import { lonLatToWorld, worldToDomainUv } from '../geo/domain'
import type { Buoy, WeatherPayload } from './cwa'
import { blend, pullsAt, type Reach, type Site } from './correction'
import { CURRENT_GRID, MARINE_POINTS, SEA_COMPONENTS, fetchOpenMeteo, getJson, gridCoordinates, type OpenMeteo } from './openMeteo'

// Live hourly ocean currents and sea state on a grid over the domain, and hub-height wind at every
// wind farm, from yesterday through three days ahead (see openMeteo.ts). They come from the shared
// weather service (worker/), or from Open-Meteo directly when it is out of reach; where neither
// can be reached (a sandboxed host), a snapshot bundled at deploy time by
// scripts/snapshot-weather.ts stands in, and says so.

export interface Weather {
  /** Hourly timestamps, unix seconds. */
  times: number[]
  /** Per hour: eastward/northward current in m/s, interleaved, row 0 at the north edge. */
  currents: Float32Array[]
  /**
   * Per hour, on the current grid: the sea state as two spectral components, each [height m,
   * mean period s, sine and cosine of the direction it comes from], the wind sea then the swell.
   */
  sea: Float32Array[]
  /** Per farm: [speed m/s, direction-from degrees] per hour, interleaved. */
  wind: Float32Array[]
  /** When the data was retrieved from Open-Meteo, unix seconds. */
  fetchedAt: number
  /** The measurements the model was corrected with, by kind; null where none came. */
  observed: { waves: Observed | null }
  /** Fetched just now, or read from the bundled snapshot. */
  source: 'live' | 'snapshot'
}

export interface Observed {
  /** Stations that reported. */
  stations: number
  /** The newest measurement, unix seconds. */
  at: number
}

const SNAPSHOT_URL = 'data/weather-snapshot.json'

const GRID_POINTS = CURRENT_GRID.cols * CURRENT_GRID.rows
/** World position of every grid point. */
const GRID_XZ = (() => {
  const { lats, lons } = gridCoordinates()
  return lats.map((lat, i) => lonLatToWorld(lons[i], lat))
})()

/** Values per grid point in a sea-state frame: four per component. */
const SEA_STRIDE = SEA_COMPONENTS.length * 4

/** The shared weather service (worker/), which fetches Open-Meteo once for every visitor. */
const WEATHER_SERVICE = import.meta.env.VITE_WEATHER_SERVICE

// Open-Meteo bills every coordinate of a multi-point request as one call against the visitor's
// own quota, and the data only changes hourly, so a direct fetch is kept per browser for half an hour.
const CACHE_TTL_MS = 30 * 60 * 1000
const CACHE_KEY = 'wind-tide:open-meteo:sea-points'

async function fetchOpenMeteoCached(): Promise<OpenMeteo> {
  try {
    const cached = localStorage.getItem(CACHE_KEY)
    if (cached) {
      const entry = JSON.parse(cached) as OpenMeteo
      if (Date.now() - entry.at < CACHE_TTL_MS) return entry
    }
  } catch {
    // Storage unavailable or corrupt: fall through to the network.
  }
  const entry = await fetchOpenMeteo()
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(entry))
  } catch {
    // Quota exceeded or storage blocked: the live response is still used.
  }
  return entry
}

/** The weather service, then Open-Meteo directly, then the bundled snapshot. */
export async function fetchWeather(): Promise<Weather> {
  if (WEATHER_SERVICE) {
    try {
      return parseWeather(await getJson<WeatherPayload>(`${WEATHER_SERVICE}/weather`), 'live')
    } catch {
      // Out of reach or failing: fetch Open-Meteo here instead.
    }
  }
  try {
    return parseWeather(await fetchOpenMeteoCached(), 'live')
  } catch (liveError) {
    const res = await fetch(SNAPSHOT_URL).catch(() => null)
    if (!res?.ok) throw liveError
    return parseWeather((await res.json()) as OpenMeteo, 'snapshot')
  }
}

export function parseWeather({ at, marine, wind, buoys }: WeatherPayload, source: Weather['source']): Weather {
  const times = marine[0].hourly.time
  const currents = times.map((_, h) => {
    const frame = new Float32Array(GRID_POINTS * 2)
    const known = new Uint8Array(GRID_POINTS)
    marine.forEach((point, m) => {
      const i = MARINE_POINTS[m]
      // Velocity is km/h; direction is the bearing the current flows toward.
      const velocity = point.hourly.ocean_current_velocity[h]
      const direction = point.hourly.ocean_current_direction[h]
      if (velocity === null || direction === null) return
      const speed = velocity / 3.6
      const dir = (direction * Math.PI) / 180
      frame[i * 2] = speed * Math.sin(dir)
      frame[i * 2 + 1] = speed * Math.cos(dir)
      known[i] = 1
    })
    fillUnknown(frame, known, 2)
    return frame
  })

  const sea = times.map((_, h) => {
    const frame = new Float32Array(GRID_POINTS * SEA_STRIDE)
    const known = new Uint8Array(GRID_POINTS)
    marine.forEach((point, m) => {
      const i = MARINE_POINTS[m]
      const values = SEA_COMPONENTS.map((c) => [point.hourly[`${c}_height`][h], point.hourly[`${c}_period`][h], point.hourly[`${c}_direction`][h]])
      if (values.some((v) => v.includes(null))) return
      values.forEach(([height, period, direction], k) => {
        const o = i * SEA_STRIDE + k * 4
        const from = (direction! * Math.PI) / 180
        frame.set([height!, period!, Math.sin(from), Math.cos(from)], o)
      })
      known[i] = 1
    })
    fillUnknown(frame, known, SEA_STRIDE)
    return frame
  })
  if (buoys?.length) correctSea(sea, times, buoys)
  const waves = buoys?.length ? { stations: buoys.length, at: Math.max(...buoys.map((b) => b.waves[b.waves.length - 1][0])) } : null

  const windByFarm = wind.map((farm) => {
    const byTime = new Map(farm.hourly.time.map((t, i) => [t, i]))
    const out = new Float32Array(times.length * 2)
    times.forEach((t, h) => {
      const i = byTime.get(t)
      out[h * 2] = i === undefined ? 0 : (farm.hourly.wind_speed_100m[i] ?? 0)
      out[h * 2 + 1] = i === undefined ? 0 : (farm.hourly.wind_direction_100m[i] ?? 0)
    })
    return out
  })

  return { times, currents, sea, wind: windByFarm, fetchedAt: at / 1000, observed: { waves }, source }
}

/**
 * Grid points the marine model leaves empty (on land and against the coast) take the mean of
 * their known neighbours, ring by ring, so sampling between grid points never blends real
 * currents or waves toward a still sea that is only missing data. Land itself is masked by
 * elevation. Each point holds `stride` values.
 */
function fillUnknown(frame: Float32Array, known: Uint8Array, stride: number) {
  const { cols, rows } = CURRENT_GRID
  for (let ring = known.slice(); ring.includes(0); ) {
    const next = ring.slice()
    for (let i = 0; i < ring.length; i++) {
      if (ring[i]) continue
      const r = Math.floor(i / cols)
      const c = i % cols
      const sum = new Float32Array(stride)
      let n = 0
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr
          const cc = c + dc
          if (rr < 0 || rr >= rows || cc < 0 || cc >= cols || !ring[rr * cols + cc]) continue
          for (let k = 0; k < stride; k++) sum[k] += frame[(rr * cols + cc) * stride + k]
          n++
        }
      }
      if (n === 0) continue
      for (let k = 0; k < stride; k++) frame[i * stride + k] = sum[k] / n
      next[i] = 1
    }
    // A frame with no known point at all stays still.
    if (next.every((v, i) => v === ring[i])) break
    ring = next
  }
}

/** Fractional hour index of a timestamp, clamped to the available range. */
export function hourIndex(weather: Weather, t: number): number {
  const { times } = weather
  const f = (t - times[0]) / 3600
  return Math.min(Math.max(f, 0), times.length - 1)
}

/** Interpolated hub-height wind at a farm: speed m/s and direction-from in radians. */
export function windAt(weather: Weather, farm: number, t: number): { speed: number; fromRad: number } {
  const f = hourIndex(weather, t)
  const i = Math.floor(f)
  const j = Math.min(i + 1, weather.times.length - 1)
  const k = f - i
  const w = weather.wind[farm]
  // Interpolate as vectors so direction wraps correctly through north.
  const vec = (h: number) => {
    const a = (w[h * 2 + 1] * Math.PI) / 180
    return [Math.sin(a) * w[h * 2], Math.cos(a) * w[h * 2]]
  }
  const [ax, ay] = vec(i)
  const [bx, by] = vec(j)
  const x = ax + (bx - ax) * k
  const y = ay + (by - ay) * k
  const speed = w[i * 2] + (w[j * 2] - w[i * 2]) * k
  return { speed, fromRad: Math.atan2(x, y) }
}

export interface SeaComponent {
  /** Significant height, m. */
  hs: number
  /** Mean period, s. */
  tm: number
  /** Direction the waves come from, radians clockwise from north. */
  fromRad: number
}

/** The four grid points around a world position and their bilinear weights; outside the domain the nearest edge stands. */
function gridCorners(x: number, z: number): [point: number, weight: number][] {
  const { cols, rows } = CURRENT_GRID
  const [u, v] = worldToDomainUv(x, z)
  const gx = Math.min(Math.max(u, 0), 1) * (cols - 1)
  const gy = Math.min(Math.max(v, 0), 1) * (rows - 1)
  const c0 = Math.min(Math.floor(gx), cols - 2)
  const r0 = Math.min(Math.floor(gy), rows - 2)
  const fx = gx - c0
  const fy = gy - r0
  return [
    [r0 * cols + c0, (1 - fx) * (1 - fy)],
    [r0 * cols + c0 + 1, fx * (1 - fy)],
    [(r0 + 1) * cols + c0, (1 - fx) * fy],
    [(r0 + 1) * cols + c0 + 1, fx * fy],
  ]
}

/**
 * Sea state at a world position: the wind sea and the swell, interpolated across the grid and
 * between hours.
 */
export function seaAt(weather: Weather, t: number, x: number, z: number): { windSea: SeaComponent; swell: SeaComponent } {
  const f = hourIndex(weather, t)
  const i = Math.floor(f)
  const j = Math.min(i + 1, weather.times.length - 1)
  const k = f - i
  const corners = gridCorners(x, z)
  const value = (o: number) => {
    let acc = 0
    for (const [p, w] of corners) acc += (weather.sea[i][p * SEA_STRIDE + o] * (1 - k) + weather.sea[j][p * SEA_STRIDE + o] * k) * w
    return acc
  }
  const component = (c: number): SeaComponent => ({
    hs: value(c * 4),
    tm: value(c * 4 + 1),
    // Directions blend as unit vectors so they wrap through north.
    fromRad: Math.atan2(value(c * 4 + 2), value(c * 4 + 3)),
  })
  return { windSea: component(0), swell: component(1) }
}

/**
 * How far buoys pull the modelled wave heights (see correction.ts). Coastal buoys see a sheltered
 * sea the 36 km grid cannot, which is why the reach is short.
 */
const WAVE_REACH: Reach = { km: 30, s: 6 * 3600, modelWeight: 0.1 }
/** A buoy scales the model by at most this factor either way. */
const MAX_RATIO = 2
/** Below this modelled height, m, a ratio says more about the grid than about the sea. */
const MIN_MODEL_HS = 0.2

/**
 * Scales the modelled wave heights toward the buoys' measurements, in place, by a blend of the
 * log ratios of measured to modelled height. Both components scale alike, so the total
 * significant height scales by the blended ratio; periods stay the model's.
 */
function correctSea(sea: Float32Array[], times: number[], buoys: Buoy[]) {
  const totalHs = (frame: Float32Array, corners: [number, number][]) => {
    let wind = 0
    let swell = 0
    for (const [p, w] of corners) {
      wind += frame[p * SEA_STRIDE] * w
      swell += frame[p * SEA_STRIDE + 4] * w
    }
    return Math.hypot(wind, swell)
  }
  // Ratios first, from the uncorrected model.
  const sites: Site[] = buoys.map((buoy) => {
    const [x, z] = lonLatToWorld(buoy.lon, buoy.lat)
    const corners = gridCorners(x, z)
    const residuals: [number, number][] = []
    for (const [t, measured] of buoy.waves) {
      const h = hourAt(times, t)
      if (h === null) continue
      const modelled = totalHs(sea[h], corners)
      if (modelled < MIN_MODEL_HS) continue
      residuals.push([t, Math.log(Math.min(Math.max(measured / modelled, 1 / MAX_RATIO), MAX_RATIO))])
    }
    return { x, z, residuals }
  })
  times.forEach((t, h) => {
    const pulls = pullsAt(sites, t, WAVE_REACH)
    if (pulls.length === 0) return
    GRID_XZ.forEach(([px, pz], p) => {
      const scale = Math.exp(blend(pulls, px, pz, WAVE_REACH))
      for (let c = 0; c < SEA_COMPONENTS.length; c++) sea[h][p * SEA_STRIDE + c * 4] *= scale
    })
  })
}

/** The index of an hour in the series, or null when it is not one of them. */
function hourAt(times: number[], t: number): number | null {
  const h = (t - times[0]) / 3600
  return Number.isInteger(h) && h >= 0 && h < times.length ? h : null
}
