import { DOMAIN } from '../geo/domain'
import { WIND_FARMS } from './windfarms'

// Live hourly ocean currents (Open-Meteo Marine) on a grid over the domain, and hub-height
// wind (Open-Meteo Forecast, 100 m) at every wind farm, from yesterday through three days ahead.

export const CURRENT_GRID = { cols: 18, rows: 18 } as const

export interface Weather {
  /** Hourly timestamps, unix seconds. */
  times: number[]
  /** Per hour: eastward/northward current in m/s, interleaved, row 0 at the north edge. */
  currents: Float32Array[]
  /** Per farm: [speed m/s, direction-from degrees] per hour, interleaved. */
  wind: Float32Array[]
  fetchedAt: number
}

const RANGE = 'past_days=1&forecast_days=3&timeformat=unixtime'

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

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status}`)
  return res.json() as Promise<T>
}

export async function fetchWeather(): Promise<Weather> {
  const { lats, lons } = gridCoordinates()
  const [marine, wind] = await Promise.all([
    getJson<Hourly<'ocean_current_velocity' | 'ocean_current_direction'>[]>(
      `https://marine-api.open-meteo.com/v1/marine?latitude=${lats}&longitude=${lons}` +
        `&hourly=ocean_current_velocity,ocean_current_direction&${RANGE}`,
    ),
    getJson<Hourly<'wind_speed_100m' | 'wind_direction_100m'>[]>(
      `https://api.open-meteo.com/v1/forecast?latitude=${WIND_FARMS.map((f) => f.lat)}` +
        `&longitude=${WIND_FARMS.map((f) => f.lon)}&hourly=wind_speed_100m,wind_direction_100m` +
        `&wind_speed_unit=ms&${RANGE}`,
    ),
  ])

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

  return { times, currents, wind: windByFarm, fetchedAt: Date.now() / 1000 }
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
