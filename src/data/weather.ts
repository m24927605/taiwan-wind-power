import { DOMAIN, worldToDomainUv } from '../geo/domain'
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
   * Per hour, on the current grid: the sea state as two spectral components, each [height m,
   * mean period s, sine and cosine of the direction it comes from], the wind sea then the swell.
   */
  sea: Float32Array[]
  /** Per farm: [speed m/s, direction-from degrees] per hour, interleaved. */
  wind: Float32Array[]
  /** When the data was retrieved from Open-Meteo, unix seconds. */
  fetchedAt: number
  /** Fetched just now, or read from the bundled snapshot. */
  source: 'live' | 'snapshot'
}

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
/** Values per grid point in a sea-state frame: four per component. */
const SEA_STRIDE = SEA_COMPONENTS.length * 4
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
  const times = marine[0].hourly.time
  const currents = times.map((_, h) => {
    const frame = new Float32Array(marine.length * 2)
    const known = new Uint8Array(marine.length)
    marine.forEach((point, i) => {
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
    const frame = new Float32Array(marine.length * SEA_STRIDE)
    const known = new Uint8Array(marine.length)
    marine.forEach((point, i) => {
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

/**
 * Sea state at a world position: the wind sea and the swell, interpolated across the grid and
 * between hours. Outside the domain the nearest edge stands.
 */
export function seaAt(weather: Weather, t: number, x: number, z: number): { windSea: SeaComponent; swell: SeaComponent } {
  const f = hourIndex(weather, t)
  const i = Math.floor(f)
  const j = Math.min(i + 1, weather.times.length - 1)
  const k = f - i
  const { cols, rows } = CURRENT_GRID
  const [u, v] = worldToDomainUv(x, z)
  const gx = Math.min(Math.max(u, 0), 1) * (cols - 1)
  const gy = Math.min(Math.max(v, 0), 1) * (rows - 1)
  const c0 = Math.min(Math.floor(gx), cols - 2)
  const r0 = Math.min(Math.floor(gy), rows - 2)
  const fx = gx - c0
  const fy = gy - r0
  const corners: [number, number][] = [
    [r0 * cols + c0, (1 - fx) * (1 - fy)],
    [r0 * cols + c0 + 1, fx * (1 - fy)],
    [(r0 + 1) * cols + c0, (1 - fx) * fy],
    [(r0 + 1) * cols + c0 + 1, fx * fy],
  ]
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
