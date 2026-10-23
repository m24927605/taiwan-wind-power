import { DOMAIN, SATELLITE_BOUNDS, lonLatToWorld } from '../geo/domain'
import { sunDirection } from '../geo/sun'
import type { Elevation } from './elevation'

// The only clouds in the scene are the ones Himawari-9 saw. NASA GIBS serves its scans as PNGs
// every ten minutes, about half an hour behind real time, over SATELLITE_BOUNDS: everything the
// camera can see. The clean longwave infrared window (band 13, 10.4 µm) is decoded back to
// brightness temperature with the layer's own colour map: cloud is what is colder than the clear
// surface, its top is higher the colder it is, the coldest is cirrus or anvil, and the coldest of
// all is the overcast of deep convection, a typhoon's eyewall and rain bands. By day the red
// visible band (band 3) adds low cloud the infrared alone misses. Where there is no scan (hours
// not observed yet, or GIBS out of reach) there are no clouds.

const IR_LAYER = 'Himawari_AHI_Band13_Clean_Infrared'
const VIS_LAYER = 'Himawari_AHI_Band3_Red_Visible_1km'
const WMS = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi'
const COLORMAP = 'https://gibs.earthdata.nasa.gov/colormaps/v1.3/Clean_Longwave_Infrared_Window_Band.xml'
/** About the infrared band's 2 km footprint over SATELLITE_BOUNDS. */
export const SATELLITE_SIZE = 896
/** GIBS publishes a scan about half an hour after it is taken. */
const LATENCY_S = 35 * 60
const FRAME_S = 3600
/**
 * The newest scan stands until GIBS publishes the next one (an hour later, plus the latency and a
 * margin); after that there is no observation.
 */
const HOLD_S = FRAME_S + LATENCY_S + 15 * 60
const CONCURRENCY = 3
/** Standard lapse rate, °C per metre: clear mountains are colder than the sea without any cloud. */
const LAPSE = 0.0065
/** Gaussian blur of the cloud fields, in pixels: the band's footprint shows as blocks otherwise. */
const BLUR = 1.5
/** Visible reflectance from clear (sea ~0.03, land ~0.09, towns and sand to ~0.15) to cloud. */
const VIS_CLEAR = 0.16
const VIS_CLOUD = 0.36
/** The visible band only counts once the sun is this high (sine of elevation, about 20 degrees). */
const VIS_MIN_SUN = 0.35
/**
 * Bright in the visible but no colder than clear sky is sun-warmed land or glint, not cloud:
 * visible cloud also has to read this much colder in the infrared, °C.
 */
const VIS_COLD_FROM = 0.5
const VIS_COLD_TO = 2.5
/**
 * Cloud tops this cold, °C, belong to deep convection, a dense overcast reaching 12 km and more,
 * rather than to cirrus, which seldom reads colder than the first.
 */
const DEEP_FROM = -50
const DEEP_TO = -65

export interface SatelliteFrame {
  /** Scan time, unix seconds. */
  time: number
  /**
   * RGBA8, SATELLITE_SIZE², row 0 at the north edge of SATELLITE_BOUNDS: R low cloud cover,
   * G cloud-top height within the cumulus layer, B high cloud cover, A deep convection.
   */
  data: Uint8Array
}

interface Colormap {
  /** Temperature, °C, of each grey level on the map's grey ramp (warm to about -31 °C); NaN off it. */
  grey: Float32Array
  /** Temperature of each colour of the cold-top palette, by packed RGB. */
  colour: Map<number, number>
}

/** Below this the colour map leaves its grey ramp for a colour palette (which reuses some greys). */
const GREY_RAMP_FLOOR = -35
let colormap: Promise<Colormap> | null = null

function loadColormap(): Promise<Colormap> {
  colormap ??= fetch(COLORMAP)
    .then((r) => {
      if (!r.ok) throw new Error(`colour map ${r.status}`)
      return r.text()
    })
    .then((xml) => {
      const colour = new Map<number, number>()
      const ramp: [level: number, temp: number][] = []
      const doc = new DOMParser().parseFromString(xml, 'application/xml')
      for (const e of doc.querySelectorAll('ColorMapEntry')) {
        const range = e.getAttribute('value')?.match(/^[([](-?[\d.]+|-INF),(\+?-?[\d.]+|\+INF)[)\]]$/)
        const rgb = e.getAttribute('rgb')?.split(',').map(Number)
        if (!range || !rgb || e.getAttribute('nodata') === 'true') continue
        const lo = range[1] === '-INF' ? Number(range[2]) - 1 : Number(range[1])
        const hi = range[2] === '+INF' ? lo + 1 : Number(range[2])
        const temp = (lo + hi) / 2
        if (rgb[0] === rgb[1] && rgb[1] === rgb[2] && temp > GREY_RAMP_FLOOR) ramp.push([rgb[0], temp])
        else colour.set((rgb[0] << 16) | (rgb[1] << 8) | rgb[2], temp)
      }
      // Resampled images hold greys between the map's entries: interpolate along the ramp.
      ramp.sort((a, b) => a[0] - b[0])
      const grey = new Float32Array(256).fill(NaN)
      for (let k = 0; k + 1 < ramp.length; k++) {
        const [g0, t0] = ramp[k]
        const [g1, t1] = ramp[k + 1]
        for (let g = g0; g <= g1; g++) grey[g] = g1 === g0 ? t0 : t0 + ((t1 - t0) * (g - g0)) / (g1 - g0)
      }
      return { grey, colour }
    })
  return colormap
}

const smoothstep = (x: number, a: number, b: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1)
  return t * t * (3 - 2 * t)
}

/**
 * Ground height in metres at the centre of every frame pixel: 0 over the sea, NaN beyond the
 * elevation grid, where land and sea are not known.
 */
function pixelHeights(elevation: Elevation): Float32Array {
  const n = SATELLITE_SIZE
  const b = SATELLITE_BOUNDS
  const heights = new Float32Array(n * n)
  for (let j = 0; j < n; j++) {
    const lat = b.north - ((j + 0.5) / n) * (b.north - b.south)
    for (let i = 0; i < n; i++) {
      const lon = b.west + ((i + 0.5) / n) * (b.east - b.west)
      const inside = lon >= DOMAIN.west && lon <= DOMAIN.east && lat >= DOMAIN.south && lat <= DOMAIN.north
      heights[j * n + i] = inside ? Math.max(elevation.heightAt(...lonLatToWorld(lon, lat)), 0) : NaN
    }
  }
  return heights
}

/** The warmest few percent of the sea: clear water, under no cloud. */
function clearTemperature(values: number[]): number | null {
  if (values.length < 50) return null
  values.sort((a, b) => a - b)
  return values[Math.floor(values.length * 0.95)]
}

/** In-place separable Gaussian blur of one channel of an n² float field. */
function blur(field: Float32Array, n: number, sigma: number) {
  const r = Math.ceil(sigma * 2.5)
  const kernel = Array.from({ length: 2 * r + 1 }, (_, k) => Math.exp(-((k - r) ** 2) / (2 * sigma * sigma)))
  const sum = kernel.reduce((a, b) => a + b, 0)
  const tmp = new Float32Array(field.length)
  for (const [step, line] of [[1, n], [n, 1]]) {
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) {
        let v = 0
        for (let k = -r; k <= r; k++) {
          const c = Math.min(Math.max(b + k, 0), n - 1)
          v += field[a * line + c * step] * kernel[k + r]
        }
        tmp[a * line + b * step] = v / sum
      }
    }
    field.set(tmp)
  }
}

/** Cloud fields from one frame of brightness temperatures; null if the frame holds no data. */
function cloudFields(temps: Float32Array, heights: Float32Array, reflectance: Float32Array | null): Uint8Array | null {
  // Clear sky comes from the sea inside the map, whose temperature barely moves through the day;
  // over land it is the same reduced by the lapse rate. Land surface temperature swings with sun
  // and slope, and beyond the map land and sea are not known, so both take a wider margin.
  const sea: number[] = []
  let valid = 0
  temps.forEach((t, i) => {
    if (Number.isNaN(t)) return
    valid++
    if (heights[i] === 0) sea.push(t)
  })
  if (valid < temps.length * 0.5) return null
  const clearSea = clearTemperature(sea)
  if (clearSea === null) return null
  const n = SATELLITE_SIZE
  const low = new Float32Array(n * n)
  const top = new Float32Array(n * n)
  const high = new Float32Array(n * n)
  const deep = new Float32Array(n * n)
  for (let i = 0; i < temps.length; i++) {
    const h = heights[i]
    const clear = clearSea - (h > 0 ? h * LAPSE : 0)
    const t = Number.isNaN(temps[i]) ? clear : temps[i]
    low[i] = h === 0 ? smoothstep(t, clear - 3, clear - 13) : smoothstep(t, clear - 6, clear - 18)
    if (reflectance) {
      const cold = smoothstep(t, clear - VIS_COLD_FROM, clear - VIS_COLD_TO)
      low[i] = Math.max(low[i], smoothstep(reflectance[i], VIS_CLEAR, VIS_CLOUD) * cold)
    }
    top[i] = smoothstep(t, clear - 3, clear - 30)
    high[i] = smoothstep(t, -15, -40)
    deep[i] = smoothstep(t, DEEP_FROM, DEEP_TO)
  }
  for (const f of [low, top, high, deep]) blur(f, n, BLUR)
  const out = new Uint8Array(n * n * 4)
  for (let i = 0; i < n * n; i++) {
    out[i * 4] = 255 * low[i]
    out[i * 4 + 1] = 255 * top[i]
    out[i * 4 + 2] = 255 * high[i]
    out[i * 4 + 3] = 255 * deep[i]
  }
  return out
}

/** One layer of one scan over SATELLITE_BOUNDS as RGBA pixels, or null if GIBS has no image for it. */
async function fetchLayer(layer: string, time: number): Promise<Uint8ClampedArray | null> {
  const b = SATELLITE_BOUNDS
  const iso = new Date(time * 1000).toISOString().replace('.000', '')
  const url =
    `${WMS}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=${layer}&CRS=EPSG:4326&FORMAT=image/png` +
    `&BBOX=${b.south},${b.west},${b.north},${b.east}&WIDTH=${SATELLITE_SIZE}&HEIGHT=${SATELLITE_SIZE}&TIME=${iso}`
  const response = await fetch(url)
  if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) return null
  const bitmap = await createImageBitmap(await response.blob())
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = SATELLITE_SIZE
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(bitmap, 0, 0, SATELLITE_SIZE, SATELLITE_SIZE)
  bitmap.close()
  return ctx.getImageData(0, 0, SATELLITE_SIZE, SATELLITE_SIZE).data
}

async function loadFrame(time: number, heights: Float32Array): Promise<SatelliteFrame | null> {
  const centre = sunDirection(time, (DOMAIN.west + DOMAIN.east) / 2, (DOMAIN.south + DOMAIN.north) / 2)
  const [map, ir, vis] = await Promise.all([
    loadColormap(),
    fetchLayer(IR_LAYER, time),
    centre[1] > VIS_MIN_SUN ? fetchLayer(VIS_LAYER, time) : Promise.resolve(null),
  ])
  if (!ir) return null
  const n = SATELLITE_SIZE * SATELLITE_SIZE
  const temps = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const [r, g, b, alpha] = [ir[i * 4], ir[i * 4 + 1], ir[i * 4 + 2], ir[i * 4 + 3]]
    temps[i] = alpha < 128 ? NaN : r === g && g === b ? map.grey[r] : (map.colour.get((r << 16) | (g << 8) | b) ?? NaN)
  }
  // The visible band is reflectance on a linear grey scale. A scan GIBS has not finished yet comes
  // back transparent and counts as no visible data.
  let reflectance: Float32Array | null = null
  if (vis) {
    reflectance = new Float32Array(n)
    for (let i = 0; i < n; i++) reflectance[i] = vis[i * 4 + 3] < 128 ? 0 : vis[i * 4] / 255
  }
  const data = cloudFields(temps, heights, reflectance)
  return data && { time, data }
}

/** Scans by hour: a frame once loaded, null once a load has failed. */
const frames = new Map<number, SatelliteFrame | null>()
const requested = new Map<number, Promise<void>>()
const queue: { time: number; done: () => void }[] = []
let heights: Float32Array | null = null
let running = 0

/** The newest scan GIBS has published by now. */
const latestScan = () => Math.floor((Date.now() / 1000 - LATENCY_S) / FRAME_S) * FRAME_S

/** Starts loading the scans asked for so far, once the ground (land and sea) is known. */
export function initSatellite(elevation: Elevation): void {
  heights ??= pixelHeights(elevation)
  pump()
}

function pump() {
  while (heights && running < CONCURRENCY && queue.length) {
    const job = queue.shift() as (typeof queue)[number]
    const h = heights
    running++
    loadFrame(job.time, h)
      // One retry: a dropped request should not leave a gap in the clouds.
      .catch(() => loadFrame(job.time, h))
      .catch((error) => {
        console.warn('[satellite] Himawari scan unavailable:', new Date(job.time * 1000).toISOString(), error)
        return null
      })
      .then((frame) => frames.set(job.time, frame))
      .finally(() => {
        running--
        job.done()
        pump()
      })
  }
}

/** The scan for one hour, loaded once; nothing for hours GIBS has not published yet. */
function request(time: number): Promise<void> {
  if (time > latestScan()) return Promise.resolve()
  let promise = requested.get(time)
  if (!promise) {
    promise = new Promise<void>((done) => queue.push({ time, done }))
    requested.set(time, promise)
    pump()
  }
  return promise
}

/** Asks for the scans scene time `t` needs: its hour and the next, then the one before. */
export function wantSatellite(t: number): void {
  const t0 = Math.floor(t / FRAME_S) * FRAME_S
  for (const h of [t0, t0 + FRAME_S, t0 - FRAME_S]) void request(h)
}

/** Loads every scan from `from` to `to` (unix seconds), resolving once all have arrived. */
export function prefetchSatellite(from: number, to: number): Promise<void> {
  const jobs: Promise<void>[] = []
  for (let t = Math.floor(from / FRAME_S) * FRAME_S; t <= to + FRAME_S; t += FRAME_S) jobs.push(request(t))
  return Promise.all(jobs).then(() => undefined)
}

export interface SatelliteSample {
  a: SatelliteFrame
  b: SatelliteFrame
  /** Weight of b. */
  blend: number
}

/** The scans around scene time `t`, or null where none was made (or loaded yet): no clouds then. */
export function satelliteAt(t: number): SatelliteSample | null {
  const t0 = Math.floor(t / FRAME_S) * FRAME_S
  // Before this hour's scan is published, the previous one stands for a while.
  const previous = frames.get(t0 - FRAME_S) ?? null
  const a = frames.get(t0) ?? (previous && t - previous.time <= HOLD_S ? previous : null)
  if (!a) return null
  const b = frames.get(a.time + FRAME_S) ?? a
  return { a, b, blend: b === a ? 0 : (t - a.time) / FRAME_S }
}
