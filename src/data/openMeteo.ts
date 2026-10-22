import { DOMAIN } from '../geo/domain'
import { WIND_FARMS } from './windfarms'

// The Open-Meteo requests behind the app's weather: hourly ocean currents and sea state (Marine)
// on a grid over the domain, and hub-height wind (Forecast) at every wind farm. Shared by the app,
// the weather service (worker/) and the snapshot script, so the requests are defined once.

/** About 36 km between grid points both ways over the domain. */
export const CURRENT_GRID = { cols: 24, rows: 14 } as const

export const LIVE_RANGE = 'past_days=1&forecast_days=3&timeformat=unixtime'
/** A snapshot has to last until the next deploy, so it reaches as far ahead as the marine model. */
export const SNAPSHOT_RANGE = 'past_days=1&forecast_days=7&timeformat=unixtime'

/** Longitude and latitude of every grid point, row by row from the north-west corner. */
export function gridCoordinates() {
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

export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status}`)
  return (await res.json()) as T
}

export const SEA_COMPONENTS = ['wind_wave', 'swell_wave'] as const
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
  return { at: Date.now(), marine, wind }
}
