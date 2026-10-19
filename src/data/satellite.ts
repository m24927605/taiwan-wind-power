import { DOMAIN, lonLatToWorld } from '../geo/domain'
import { sunDirection } from '../geo/sun'
import type { Elevation } from './elevation'

// Live cloud from Himawari-9, served by NASA GIBS as PNGs every ten minutes, about half an hour
// behind real time. The clean longwave infrared window (band 13, 10.4 µm) is decoded back to
// brightness temperature with the layer's own colour map: cloud is what is colder than the clear
// surface, its top is higher the colder it is, and the coldest is cirrus or anvil. Infrared misses
// low cloud over sun-warmed land, so by day the red visible band (band 3) adds whatever reflects
// far more than sea or land. Where GIBS cannot be reached, the clouds fall back to the forecast.

const IR_LAYER = 'Himawari_AHI_Band13_Clean_Infrared'
const VIS_LAYER = 'Himawari_AHI_Band3_Red_Visible_1km'
const WMS = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi'
const COLORMAP = 'https://gibs.earthdata.nasa.gov/colormaps/v1.3/Clean_Longwave_Infrared_Window_Band.xml'
/** About the band's 2 km footprint over the domain. */
export const SATELLITE_SIZE = 256
/** GIBS publishes a scan about half an hour after it is taken. */
const LATENCY_S = 35 * 60
const FRAME_S = 3600
const CONCURRENCY = 4
/** Standard lapse rate, °C per metre: clear mountains are colder than the sea without any cloud. */
const LAPSE = 0.0065
/** Gaussian blur of the cloud fields, in pixels: the band's footprint shows as blocks otherwise. */
const BLUR = 1.5
/** Visible reflectance, corrected for the sun's height, from clear (sea ~0.03, land ~0.09) to cloud. */
const VIS_CLEAR = 0.18
const VIS_CLOUD = 0.38
/** The visible band only counts once the sun is this high (sine of elevation). */
const VIS_MIN_SUN = 0.2

export interface SatelliteFrame {
  /** Scan time, unix seconds. */
  time: number
  /**
   * RGBA8, SATELLITE_SIZE², row 0 at the north edge: R low cloud cover, G cloud-top height within
   * the cumulus layer, B high cloud cover, A 255.
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

/** Ground height in metres (sea level over water) at the centre of every frame pixel. */
function pixelHeights(elevation: Elevation): Float32Array {
  const n = SATELLITE_SIZE
  const heights = new Float32Array(n * n)
  for (let j = 0; j < n; j++) {
    const lat = DOMAIN.north - ((j + 0.5) / n) * (DOMAIN.north - DOMAIN.south)
    for (let i = 0; i < n; i++) {
      const [x, z] = lonLatToWorld(DOMAIN.west + ((i + 0.5) / n) * (DOMAIN.east - DOMAIN.west), lat)
      heights[j * n + i] = Math.max(elevation.heightAt(x, z), 0)
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
  // Clear sky comes from the sea, whose temperature barely moves through the day; over land it
  // is the same reduced by the lapse rate. Land surface temperature swings with sun and slope, so
  // land takes a wider margin before it counts as cloud.
  const sea: number[] = []
  let valid = 0
  temps.forEach((t, i) => {
    if (Number.isNaN(t)) return
    valid++
    if (heights[i] <= 0) sea.push(t)
  })
  if (valid < temps.length * 0.5) return null
  const clearSea = clearTemperature(sea)
  if (clearSea === null) return null
  const n = SATELLITE_SIZE
  const low = new Float32Array(n * n)
  const top = new Float32Array(n * n)
  const high = new Float32Array(n * n)
  for (let i = 0; i < temps.length; i++) {
    const land = heights[i] > 0
    const clear = clearSea - heights[i] * LAPSE
    const t = Number.isNaN(temps[i]) ? clear : temps[i]
    low[i] = land ? smoothstep(t, clear - 6, clear - 18) : smoothstep(t, clear - 3, clear - 13)
    if (reflectance) low[i] = Math.max(low[i], smoothstep(reflectance[i], VIS_CLEAR, VIS_CLOUD))
    top[i] = smoothstep(t, clear - 3, clear - 30)
    high[i] = smoothstep(t, -15, -40)
  }
  for (const f of [low, top, high]) blur(f, n, BLUR)
  const out = new Uint8Array(n * n * 4)
  for (let i = 0; i < n * n; i++) {
    out[i * 4] = 255 * low[i]
    out[i * 4 + 1] = 255 * top[i]
    out[i * 4 + 2] = 255 * high[i]
    out[i * 4 + 3] = 255
  }
  return out
}

/** One layer of one scan over the domain as RGBA pixels, or null if GIBS has no image for it. */
async function fetchLayer(layer: string, time: number): Promise<Uint8ClampedArray | null> {
  const iso = new Date(time * 1000).toISOString().replace('.000', '')
  const url =
    `${WMS}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=${layer}&CRS=EPSG:4326&FORMAT=image/png` +
    `&BBOX=${DOMAIN.south},${DOMAIN.west},${DOMAIN.north},${DOMAIN.east}` +
    `&WIDTH=${SATELLITE_SIZE}&HEIGHT=${SATELLITE_SIZE}&TIME=${iso}`
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
  const center = sunDirection(time, (DOMAIN.west + DOMAIN.east) / 2, (DOMAIN.south + DOMAIN.north) / 2)
  const sunUp = center[1] > VIS_MIN_SUN
  const [map, ir, vis] = await Promise.all([
    loadColormap(),
    fetchLayer(IR_LAYER, time),
    sunUp ? fetchLayer(VIS_LAYER, time) : Promise.resolve(null),
  ])
  if (!ir) return null
  const n = SATELLITE_SIZE * SATELLITE_SIZE
  const temps = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const [r, g, b, alpha] = [ir[i * 4], ir[i * 4 + 1], ir[i * 4 + 2], ir[i * 4 + 3]]
    temps[i] = alpha < 128 ? NaN : r === g && g === b ? map.grey[r] : (map.colour.get((r << 16) | (g << 8) | b) ?? NaN)
  }
  // The visible band is reflectance on a linear grey scale; dividing by the sun's height evens out
  // morning and afternoon.
  let reflectance: Float32Array | null = null
  if (vis) {
    reflectance = new Float32Array(n)
    for (let i = 0; i < n; i++) reflectance[i] = vis[i * 4 + 3] < 128 ? 0 : vis[i * 4] / 255 / center[1]
  }
  const data = cloudFields(temps, heights, reflectance)
  return data && { time, data }
}

const frames = new Map<number, SatelliteFrame | null>()
let latest = -Infinity

/**
 * Starts fetching every published hourly frame from `start` up to now, newest first so the live
 * view fills in before the history does.
 */
export function loadSatellite(start: number, elevation: Elevation): void {
  const heights = pixelHeights(elevation)
  latest = Math.floor((Date.now() / 1000 - LATENCY_S) / FRAME_S) * FRAME_S
  const queue: number[] = []
  for (let t = latest; t >= Math.floor(start / FRAME_S) * FRAME_S; t -= FRAME_S) if (!frames.has(t)) queue.push(t)
  const worker = async () => {
    for (let t = queue.shift(); t !== undefined; t = queue.shift()) {
      try {
        frames.set(t, await loadFrame(t, heights))
      } catch (error) {
        // Unreachable (a sandboxed host) or a bad frame: that hour falls back to the forecast.
        frames.set(t, null)
        if (t === latest) console.warn('[satellite] Himawari frames unavailable:', error)
      }
    }
  }
  for (let i = 0; i < CONCURRENCY; i++) void worker()
}

export interface SatelliteSample {
  a: SatelliteFrame
  b: SatelliteFrame
  /** Weight of b. */
  blend: number
  /** How much the satellite, rather than the forecast, shapes the clouds: fades out after the last scan. */
  weight: number
}

/** The two frames around scene time `t`, or null where there are none. */
export function satelliteAt(t: number): SatelliteSample | null {
  const t0 = Math.floor(t / FRAME_S) * FRAME_S
  const a = frames.get(Math.min(t0, latest)) ?? null
  if (!a) return null
  const b = frames.get(t0 + FRAME_S) ?? a
  // Past the newest scan the clouds hold it for an hour, then hand over to the forecast.
  const weight = 1 - smoothstep(t, a.time + FRAME_S, a.time + 2 * FRAME_S)
  return { a, b, blend: b === a ? 0 : (t - t0) / FRAME_S, weight }
}
