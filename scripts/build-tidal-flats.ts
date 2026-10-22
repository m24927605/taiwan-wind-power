// Builds public/data/tidal-flats.png: the elevation of the tidal flats along the Changhua and Yunlin
// coast, which the sea uncovers at low tide (format in TIDAL_FLATS, src/geo/domain.ts).
//
// No open dataset carries it: Copernicus DEM flattens the flats into the sea, and GTF30 and Murray's
// global maps give their extent only. So it is derived as Australia's NIDEM is. Sentinel-2 has seen
// the coast on some 130 clear mornings since 2023; each scene tells which pixels were wet (NDWI),
// and CWA's tide gauges tell how high the tide stood then. A pixel's elevation is the tide height
// that best splits the scenes it was dry in from those it was wet in. The flats kept are those the
// open sea reaches without crossing land, and only where Copernicus DEM has sea, which leaves out
// fish ponds behind the seawalls.
//
// The gauges' last 30 days are fitted with the main tidal constituents (harmonics.ts), which
// predict the tide at any scene's moment. Sentinel-2 passes at about 10:40 every time, and at that
// hour the tide here never falls below about -1.4 m: the lowest metre of spring tides is never
// seen, and flats that only dry then are not in the map.
//
// Needs a CWA open data key: CWA_API_KEY=... node scripts/build-tidal-flats.ts
// (worker/.dev.vars holds one). Reads about 1.3 GB of imagery over the network in a few minutes.

import sharp from 'sharp'
import { fromUrl } from 'geotiff'
import { mkdir } from 'node:fs/promises'
import { TIDAL_FLATS } from '../src/geo/domain.ts'
import { fitTide, type TideFit } from './harmonics.ts'
import { fromUtm, toUtm } from './utm.ts'

const KEY = process.env.CWA_API_KEY
if (!KEY) throw new Error('CWA_API_KEY is not set')

/** Scenes from this date on: older ones would show flats that have since moved. */
const SINCE = '2023-01-01'
/** The Sentinel-2 tile over the coast, in UTM zone 51; only one of its two orbits covers the coast. */
const MGRS = 'MGRS-51QTG'
const ZONE = 51
/** Working resolution, m: the 10 m bands' second overview. */
const RES = 40
/** NDWI above this is water; wet sand sits just below. */
const WET_NDWI = 0.1
/** Scene classes that see the surface: dark, vegetation, bare, water, unclassified. */
const CLEAR = new Set([2, 4, 5, 6, 7])
/** A pixel needs this many clear looks, and its split may misplace at most this share of them. */
const MIN_LOOKS = 15
const MAX_MISFIT = 0.2
/** Flats come in patches of at least this many pixels (about 5 ha); fewer are misread scenes. */
const MIN_PATCH = 30
/** The open sea the flood starts from: this far into the strait from the western edge, m. */
const OPEN_SEA_M = 8000
/** CWA gauges north to south along the coast; the tide between them is interpolated by latitude. */
const GAUGES = [
  { id: 'C4F01', lat: 24.2878 }, // Taichung Port
  { id: '1456', lat: 23.7861 }, // Mailiao
  { id: 'C4J01', lat: 23.6196 }, // Bozailiao
]

// --- Tides --------------------------------------------------------------------------------------

interface TideRecords {
  Records: {
    SeaSurfaceObs: {
      Location: { Station: { StationID: string }; StationObsTimes: { StationObsTime: { DateTime: string; WeatherElements: { TideHeight?: string } }[] } }[]
    }
  }
}

// O-B0075-002: the last 30 days, hourly.
const records = (await (
  await fetch(
    `https://opendata.cwa.gov.tw/api/v1/rest/datastore/O-B0075-002?Authorization=${KEY}&format=JSON` +
      `&StationID=${GAUGES.map((g) => g.id)}&WeatherElement=TideHeight`,
  )
).json()) as TideRecords
const fits: (TideFit & { lat: number })[] = GAUGES.map(({ id, lat }) => {
  const location = records.Records.SeaSurfaceObs.Location.find((l) => l.Station.StationID === id)
  const samples = (location?.StationObsTimes.StationObsTime ?? []).flatMap((o): [number, number][] => {
    const value = Number(o.WeatherElements.TideHeight)
    return o.WeatherElements.TideHeight && Number.isFinite(value) ? [[Date.parse(o.DateTime) / 1000, value]] : []
  })
  if (samples.length < 24 * 25) throw new Error(`gauge ${id}: only ${samples.length} hours in the last 30 days`)
  const fit = fitTide(samples)
  console.log(`gauge ${id}: ${samples.length} h, residual ${fit.rms.toFixed(2)} m`)
  return { ...fit, lat }
})

/** The tide about mean sea level at a latitude, linear between the gauges. */
function tideAt(lat: number, t: number): number {
  if (lat >= fits[0].lat) return fits[0].predict(t)
  for (let i = 0; i < fits.length - 1; i++) {
    const [a, b] = [fits[i], fits[i + 1]]
    if (lat >= b.lat) return b.predict(t) + ((a.predict(t) - b.predict(t)) * (lat - b.lat)) / (a.lat - b.lat)
  }
  return fits[fits.length - 1].predict(t)
}

// --- Scenes -------------------------------------------------------------------------------------

interface Item {
  id: string
  properties: { datetime: string }
  assets: Record<'green' | 'nir' | 'scl', { href: string }>
}
interface Page {
  features: Item[]
  links: { rel: string; href: string; method?: string; body?: unknown }[]
}

const items: Item[] = []
let request: { href: string; method?: string; body?: unknown } | undefined = {
  href: 'https://earth-search.aws.element84.com/v1/search',
  method: 'POST',
  body: {
    collections: ['sentinel-2-l2a'],
    bbox: [TIDAL_FLATS.west, TIDAL_FLATS.south, TIDAL_FLATS.east, TIDAL_FLATS.north],
    datetime: `${SINCE}T00:00:00Z/${new Date().toISOString()}`,
    query: { 'grid:code': { eq: MGRS }, 's2:nodata_pixel_percentage': { lt: 10 }, 'eo:cloud_cover': { lt: 40 } },
    limit: 100,
  },
}
while (request) {
  const res = await fetch(request.href, {
    method: request.method ?? 'GET',
    headers: { 'content-type': 'application/json' },
    body: request.body ? JSON.stringify(request.body) : undefined,
  })
  const page = (await res.json()) as Page
  items.push(...page.features)
  request = page.links.find((l) => l.rel === 'next')
}
// One scene a day: reprocessed duplicates share the morning.
const scenes = [...new Map(items.map((s) => [s.properties.datetime.slice(0, 10), s])).values()]
console.log(`${scenes.length} scenes since ${SINCE}`)

// The working window in UTM, covering the output box, on the 40 m grid.
const corners = [
  [TIDAL_FLATS.west, TIDAL_FLATS.south],
  [TIDAL_FLATS.west, TIDAL_FLATS.north],
  [TIDAL_FLATS.east, TIDAL_FLATS.south],
  [TIDAL_FLATS.east, TIDAL_FLATS.north],
].map(([lon, lat]) => toUtm(lon, lat, ZONE))
const WEST = Math.floor(Math.min(...corners.map((c) => c[0])) / RES) * RES
const NORTH = Math.ceil(Math.max(...corners.map((c) => c[1])) / RES) * RES
const W = (Math.ceil(Math.max(...corners.map((c) => c[0])) / RES) * RES - WEST) / RES
const H = (NORTH - Math.floor(Math.min(...corners.map((c) => c[1])) / RES) * RES) / RES
const N = W * H

/**
 * One band over the window at 40 m, rows from the north. Overviews carry no georeferencing, so the
 * window is placed from the full-resolution image: overview i is decimated by 2^i.
 */
async function readBand(url: string) {
  const tiff = await fromUrl(url)
  const full = await tiff.getImage(0)
  const [x0, , , y1] = full.getBoundingBox()
  const image = await tiff.getImage(Math.round(Math.log2(RES / full.getResolution()[0])))
  const c0 = Math.round((WEST - x0) / RES)
  const r0 = Math.round((y1 - NORTH) / RES)
  const [band] = (await image.readRasters({ window: [c0, r0, c0 + W, r0 + H], fillValue: 0 })) as unknown as ArrayLike<number>[]
  return band
}

/** Retries a read a few times: S3 drops the odd connection among hundreds of range requests. */
async function retry<T>(read: () => Promise<T>, attempts = 4): Promise<T> {
  for (let k = 1; ; k++) {
    try {
      return await read()
    } catch (error) {
      if (k === attempts) throw error
      await new Promise((resolve) => setTimeout(resolve, 1000 * k))
    }
  }
}

// The latitude of each row, for the tide (along the window's middle).
const midEasting = WEST + (W * RES) / 2
const rowLat = Float64Array.from({ length: H }, (_, r) => fromUtm(midEasting, NORTH - (r + 0.5) * RES, ZONE)[1])

/** Per scene: 0 unseen, 1 dry, 2 wet; and the tide at each row. */
const looks: Uint8Array[] = []
const tides: Float32Array[] = []
let done = 0
const queue = [...scenes]
await Promise.all(
  Array.from({ length: 6 }, async () => {
    for (let scene = queue.shift(); scene; scene = queue.shift()) {
      const { green, nir, scl } = scene.assets
      const [g, n, c] = await Promise.all([green, nir, scl].map((band) => retry(() => readBand(band.href))))
      const look = new Uint8Array(N)
      for (let i = 0; i < N; i++) {
        if (!CLEAR.has(c[i]) || g[i] === 0) continue
        look[i] = (g[i] - n[i]) / (g[i] + n[i]) > WET_NDWI ? 2 : 1
      }
      const t = Date.parse(scene.properties.datetime) / 1000
      looks.push(look)
      tides.push(Float32Array.from(rowLat, (lat) => tideAt(lat, t)))
      if (++done % 20 === 0) console.log(`${done} / ${scenes.length} scenes`)
    }
  }),
)

// --- Elevation ----------------------------------------------------------------------------------

const SEA = 1
const FLAT = 2
const kind = new Uint8Array(N)
const elevation = new Float32Array(N)
const seen: [tide: number, wet: boolean][] = []
for (let i = 0; i < N; i++) {
  const row = Math.floor(i / W)
  seen.length = 0
  for (let s = 0; s < looks.length; s++) if (looks[s][i]) seen.push([tides[s][row], looks[s][i] === 2])
  if (seen.length < MIN_LOOKS) continue
  seen.sort((a, b) => a[0] - b[0])
  // A split below every look calls them all wet, so every dry look is misplaced; raising it past
  // each look in turn trades one way or the other.
  let misplaced = seen.reduce((n, [, wet]) => n + (wet ? 0 : 1), 0)
  let best = misplaced
  let split = 0
  seen.forEach(([, wet], k) => {
    misplaced += wet ? 1 : -1
    if (misplaced < best) [best, split] = [misplaced, k + 1]
  })
  if (best / seen.length > MAX_MISFIT) continue
  if (split === 0) kind[i] = SEA
  else if (split < seen.length) {
    kind[i] = FLAT
    elevation[i] = (seen[split - 1][0] + seen[split][0]) / 2
  }
}

// The flats the open sea reaches without crossing land (4-connected, so a one-pixel seawall
// holds), in patches of MIN_PATCH pixels or more (8-connected).
const reached = new Uint8Array(N)
const flood: number[] = []
for (let r = 0; r < H; r++) {
  for (let c = 0; c < OPEN_SEA_M / RES; c++) {
    if (kind[r * W + c] === SEA) {
      reached[r * W + c] = 1
      flood.push(r * W + c)
    }
  }
}
while (flood.length) {
  const i = flood.pop()!
  const c = i % W
  for (const j of [c > 0 ? i - 1 : -1, c < W - 1 ? i + 1 : -1, i - W, i + W]) {
    if (j < 0 || j >= N || reached[j] || !kind[j]) continue
    reached[j] = 1
    flood.push(j)
  }
}
const keep = new Uint8Array(N)
const visited = new Uint8Array(N)
for (let start = 0; start < N; start++) {
  if (visited[start] || kind[start] !== FLAT || !reached[start]) continue
  const patch = [start]
  visited[start] = 1
  for (let k = 0; k < patch.length; k++) {
    const r = Math.floor(patch[k] / W)
    const c = patch[k] % W
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const j = (r + dr) * W + c + dc
        if (r + dr < 0 || r + dr >= H || c + dc < 0 || c + dc >= W || visited[j] || kind[j] !== FLAT || !reached[j]) continue
        visited[j] = 1
        patch.push(j)
      }
    }
  }
  if (patch.length >= MIN_PATCH && patch.every((i) => i % W >= OPEN_SEA_M / RES)) for (const i of patch) keep[i] = 1
}

// --- Output -------------------------------------------------------------------------------------

// Copernicus GLO-30 (1 arcsecond) flattens the sea and its flats to exactly 0.
const copernicus = new Map<number, { data: ArrayLike<number>; c0: number; r0: number; w: number; h: number }>()
for (let lat0 = Math.floor(TIDAL_FLATS.south); lat0 < TIDAL_FLATS.north; lat0++) {
  const name = `Copernicus_DSM_COG_10_N${lat0}_00_E120_00_DEM`
  const image = await retry(async () => (await fromUrl(`https://copernicus-dem-30m.s3.amazonaws.com/${name}/${name}.tif`)).getImage())
  const c0 = Math.floor((TIDAL_FLATS.west - 120) * 3600)
  const c1 = Math.ceil((TIDAL_FLATS.east - 120) * 3600)
  const r0 = Math.max(0, Math.floor((lat0 + 1 - TIDAL_FLATS.north) * 3600))
  const r1 = Math.min(3600, Math.ceil((lat0 + 1 - TIDAL_FLATS.south) * 3600))
  const [data] = (await retry(() => image.readRasters({ window: [c0, r0, c1, r1] }))) as unknown as ArrayLike<number>[]
  copernicus.set(lat0, { data, c0, r0, w: c1 - c0, h: r1 - r0 })
}
function isSea(lon: number, lat: number): boolean {
  const tile = copernicus.get(Math.floor(lat))!
  const c = Math.floor((lon - 120) * 3600) - tile.c0
  const r = Math.floor((Math.floor(lat) + 1 - lat) * 3600) - tile.r0
  return tile.data[r * tile.w + c] === 0
}

const { west, north, step, min, max } = TIDAL_FLATS
const width = Math.round((TIDAL_FLATS.east - west) / step)
const height = Math.round((north - TIDAL_FLATS.south) / step)
const out = Buffer.alloc(width * height)
let flats = 0
for (let r = 0; r < height; r++) {
  const lat = north - (r + 0.5) * step
  for (let c = 0; c < width; c++) {
    const lon = west + (c + 0.5) * step
    const [e, n] = toUtm(lon, lat, ZONE)
    const i = Math.floor((NORTH - n) / RES) * W + Math.floor((e - WEST) / RES)
    if (!keep[i] || !isSea(lon, lat)) continue
    out[r * width + c] = 1 + Math.round(((Math.min(Math.max(elevation[i], min), max) - min) / (max - min)) * 254)
    flats++
  }
}
await mkdir('public/data', { recursive: true })
await sharp(out, { raw: { width, height, channels: 1 } }).png({ compressionLevel: 9 }).toFile(`public/${TIDAL_FLATS.url}`)
const km2 = Math.round(flats * (step * 111.32 * Math.cos((24 * Math.PI) / 180)) * (step * 110.57))
console.log(`wrote public/${TIDAL_FLATS.url}: ${width}x${height}, ${km2} km2 of flats`)
