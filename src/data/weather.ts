import { DOMAIN } from '../geo/domain'
import { WIND_FARMS } from './windfarms'

// Live hourly ocean currents and sea state (Open-Meteo Marine) on a grid over the domain, and
// hub-height wind (Open-Meteo Forecast) at every wind farm, from yesterday through
// three days ahead. Where Open-Meteo cannot be reached (a sandboxed host), a snapshot bundled at deploy
// time by scripts/snapshot-weather.ts stands in, and says so.

/** About 36 km between grid points both ways over the domain. */
export const CURRENT_GRID = { cols: 24, rows: 14 } as const

export interface Weather {
  /** Hourly timestamps, unix seconds. */
  times: number[]
  /** Per hour: eastward/northward current in m/s, interleaved, row 0 at the north edge. */
  currents: Float32Array[]
  /**
   * Strait sea state per hour, as two spectral components: [height m, mean period s,
   * direction-from degrees] of the wind sea, then the same for the swell.
   */
  sea: Float32Array
  /** Per farm: [speed m/s, direction-from degrees] per hour, interleaved. */
  wind: Float32Array[]
  /** When the data was retrieved from Open-Meteo, unix seconds. */
  fetchedAt: number
  /** Fetched just now, or read from the bundled snapshot. */
  source: 'live' | 'snapshot'
}

// Sea state is taken as the median over grid points inside the strait, where the farms are.
const STRAIT = { west: 119.2, east: 120.6, south: 22.6, north: 25.2 }

const LIVE_RANGE = 'past_days=1&forecast_days=3&timeformat=unixtime'
/** A snapshot has to last until the next deploy, so it reaches as far ahead as the marine model. */
export const SNAPSHOT_RANGE = 'past_days=1&forecast_days=7&timeformat=unixtime'
const SNAPSHOT_URL = 'data/weather-snapshot.json'

function gridCoordinates() {
  const lats: number[] = []
  const lons: number[] = []
  for (let r = 0; r < CURRENT_GRID.rows; r++) {
    for (let c = 0; c < CURRENT_GRID.cols; c++) {
      lats.push(+(DOMAIN.north - (r / (CURRENT_GRID.rows - 1)) * (DOMAIN.north - DOMAIN.south)).toFixed(3))
      lons.push(+(DOMAIN.west + (c / (CURRENT_GRID.cols - 1)) * (DOMAIN.east - DOMAIN.west)).toFixed(3))
    }
  }
  return { lats, lons }
}

interface Hourly<K extends string> {
  hourly: { time: number[] } & Record<K, (number | null)[]>
}

// Open-Meteo bills every coordinate of a multi-point request as one call, and the data only
// changes hourly, so responses are kept per browser for half an hour.
const CACHE_TTL_MS = 30 * 60 * 1000

async function getJson<T>(url: string): Promise<{ at: number; body: T }> {
  const key = `wind-tide:${url}`
  try {
    const cached = localStorage.getItem(key)
    if (cached) {
      const entry = JSON.parse(cached) as { at: number; body: T }
      if (Date.now() - entry.at < CACHE_TTL_MS) return entry
    }
  } catch {
    // Storage unavailable or corrupt: fall through to the network.
  }
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status}`)
  const entry = { at: Date.now(), body: (await res.json()) as T }
  try {
    localStorage.setItem(key, JSON.stringify(entry))
  } catch {
    // Quota exceeded or storage blocked: the live response is still used.
  }
  return entry
}

const SEA_COMPONENTS = ['wind_wave', 'swell_wave'] as const
type MarineVariable =
  | 'ocean_current_velocity'
  | 'ocean_current_direction'
  | `${(typeof SEA_COMPONENTS)[number]}_${'height' | 'period' | 'direction'}`

/** Raw Open-Meteo responses, as fetched live and as stored in the snapshot. */
export interface OpenMeteo {
  /** Retrieval time, unix milliseconds. */
  at: number
  marine: Hourly<MarineVariable>[]
  wind: Hourly<'wind_speed_100m' | 'wind_direction_100m'>[]
}

export async function fetchOpenMeteo(range = LIVE_RANGE): Promise<OpenMeteo> {
  const { lats, lons } = gridCoordinates()
  const [marine, wind] = await Promise.all([
    getJson<OpenMeteo['marine']>(
      `https://marine-api.open-meteo.com/v1/marine?latitude=${lats}&longitude=${lons}` +
        `&hourly=ocean_current_velocity,ocean_current_direction,` +
        SEA_COMPONENTS.map((c) => `${c}_height,${c}_period,${c}_direction`).join(',') +
        `&${range}`,
    ),
    getJson<OpenMeteo['wind']>(
      `https://api.open-meteo.com/v1/forecast?latitude=${WIND_FARMS.map((f) => f.lat)}` +
        `&longitude=${WIND_FARMS.map((f) => f.lon)}&hourly=wind_speed_100m,wind_direction_100m` +
        `&wind_speed_unit=ms&${range}`,
    ),
  ])
  return { at: Math.min(marine.at, wind.at), marine: marine.body, wind: wind.body }
}

export async function fetchWeather(): Promise<Weather> {
  try {
    return parseWeather(await fetchOpenMeteo(), 'live')
  } catch (liveError) {
    const res = await fetch(SNAPSHOT_URL).catch(() => null)
    if (!res?.ok) throw liveError
    return parseWeather((await res.json()) as OpenMeteo, 'snapshot')
  }
}

function parseWeather({ at, marine, wind }: OpenMeteo, source: Weather['source']): Weather {
  const { lats, lons } = gridCoordinates()
  const times = marine[0].hourly.time
  const currents = times.map((_, h) => {
    const frame = new Float32Array(marine.length * 2)
    marine.forEach((point, i) => {
      // Velocity is km/h; direction is the bearing the current flows toward.
      const speed = (point.hourly.ocean_current_velocity[h] ?? 0) / 3.6
      const dir = ((point.hourly.ocean_current_direction[h] ?? 0) * Math.PI) / 180
      frame[i * 2] = speed * Math.sin(dir)
      frame[i * 2 + 1] = speed * Math.cos(dir)
    })
    return frame
  })

  const strait = marine.filter((_, i) => {
    const lat = lats[i]
    const lon = lons[i]
    return lon >= STRAIT.west && lon <= STRAIT.east && lat >= STRAIT.south && lat <= STRAIT.north
  })
  const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]
  const sea = new Float32Array(times.length * 6)
  times.forEach((_, h) => {
    SEA_COMPONENTS.forEach((c, k) => {
      const height = (p: (typeof strait)[number]) => p.hourly[`${c}_height`][h]
      const period = (p: (typeof strait)[number]) => p.hourly[`${c}_period`][h]
      const direction = (p: (typeof strait)[number]) => ((p.hourly[`${c}_direction`][h] ?? 0) * Math.PI) / 180
      const valid = strait.filter((p) => height(p) !== null && period(p) !== null)
      if (valid.length === 0) return
      const o = h * 6 + k * 3
      sea[o] = median(valid.map((p) => height(p)!))
      sea[o + 1] = median(valid.map((p) => period(p)!))
      // Average directions as unit vectors so they wrap through north.
      const x = valid.reduce((acc, p) => acc + Math.sin(direction(p)), 0)
      const y = valid.reduce((acc, p) => acc + Math.cos(direction(p)), 0)
      sea[o + 2] = (Math.atan2(x, y) * 180) / Math.PI
    })
  })

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

  return { times, currents, sea, wind: windByFarm, fetchedAt: at / 1000, source }
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

/** Interpolated strait sea state: the wind sea and the swell. */
export function seaAt(weather: Weather, t: number): { windSea: SeaComponent; swell: SeaComponent } {
  const f = hourIndex(weather, t)
  const i = Math.floor(f)
  const j = Math.min(i + 1, weather.times.length - 1)
  const k = f - i
  const s = weather.sea
  const component = (c: number): SeaComponent => {
    const lerp = (o: number) => s[i * 6 + c * 3 + o] + (s[j * 6 + c * 3 + o] - s[i * 6 + c * 3 + o]) * k
    const a = (s[i * 6 + c * 3 + 2] * Math.PI) / 180
    const b = (s[j * 6 + c * 3 + 2] * Math.PI) / 180
    const x = Math.sin(a) * (1 - k) + Math.sin(b) * k
    const y = Math.cos(a) * (1 - k) + Math.cos(b) * k
    return { hs: lerp(0), tm: lerp(1), fromRad: Math.atan2(x, y) }
  }
  return { windSea: component(0), swell: component(1) }
}
