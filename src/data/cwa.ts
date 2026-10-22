import { DOMAIN } from '../geo/domain'
import type { OpenMeteo } from './openMeteo'

// Measurements from the Central Weather Administration's open data: O-B0075-001 (the last 48
// hours, hourly, about half an hour behind real time) from its moored buoys (wave height and
// wind) and tide gauges (sea level), placed by the station list O-B0076-001. Only stations inside
// the domain count. Both need a CWA key, so the weather service (worker/) fetches them: the
// station list rarely changes and is fetched apart from the observations, which are asked for
// only the stations and elements used, a fraction of the full dataset.

const OBSERVATIONS = 'https://opendata.cwa.gov.tw/api/v1/rest/datastore/O-B0075-001'
const STATIONS = 'https://opendata.cwa.gov.tw/fileapi/v1/opendataapi/O-B0076-001'

export interface Station {
  id: string
  name: string
  lon: number
  lat: number
}

export interface Stations {
  buoys: Station[]
  tideGauges: Station[]
}

/** A series of hourly measurements: [unix seconds, value], oldest first. */
export type Series = [number, number][]

export interface Buoy extends Station {
  /** Significant wave height, m. */
  waves: Series
  /** Wind speed at the buoy's anemometer, m/s. */
  wind: Series
}

export interface TideGauge extends Station {
  /** Sea level against the gauge's own datum, m. */
  levels: Series
}

/** What the weather service returns: the Open-Meteo responses and, when CWA answered, the measurements. */
export interface WeatherPayload extends OpenMeteo {
  buoys?: Buoy[]
  tides?: TideGauge[]
}

interface StationList {
  cwaopendata: {
    Resources: {
      Resource: {
        Data: {
          SeaSurfaceObs: {
            Location: {
              Station: { StationID: string; StationName: string; StationLongitude: string; StationLatitude: string; StationAttribute: string }
            }[]
          }
        }
      }
    }
  }
}

interface Elements {
  WaveHeight?: string
  TideHeight?: string
  PrimaryAnemometer?: { WindSpeed?: string }
}

interface Observations {
  Records: {
    SeaSurfaceObs: {
      Location: {
        Station: { StationID: string }
        StationObsTimes: { StationObsTime: { DateTime: string; WeatherElements: Elements }[] }
      }[]
    }
  }
}

async function getCwa<T>(url: string, key: string, query = ''): Promise<T> {
  // The key never appears in an error: it would end up in logs.
  const res = await fetch(`${url}?Authorization=${encodeURIComponent(key)}&format=JSON${query}`)
  if (!res.ok) throw new Error(`CWA ${new URL(url).pathname}: HTTP ${res.status}`)
  return (await res.json()) as T
}

/** The moored buoys and tide gauges inside the domain. */
export async function fetchStations(key: string): Promise<Stations> {
  const list = await getCwa<StationList>(STATIONS, key)
  const stations: Stations = { buoys: [], tideGauges: [] }
  for (const { Station: s } of list.cwaopendata.Resources.Resource.Data.SeaSurfaceObs.Location) {
    const lon = Number(s.StationLongitude)
    const lat = Number(s.StationLatitude)
    if (lon < DOMAIN.west || lon > DOMAIN.east || lat < DOMAIN.south || lat > DOMAIN.north) continue
    const station = { id: s.StationID, name: s.StationName, lon, lat }
    if (s.StationAttribute === '浮標站') stations.buoys.push(station)
    else if (s.StationAttribute === '潮位站') stations.tideGauges.push(station)
  }
  return stations
}

/** Each station's hourly records of the given elements, keyed by station id. */
async function fetchObservations(key: string, stations: Station[], elements: string) {
  const query = `&WeatherElement=${elements}&StationID=${stations.map((s) => s.id)}`
  const observations = await getCwa<Observations>(OBSERVATIONS, key, query)
  return new Map(
    observations.Records.SeaSurfaceObs.Location.map((l) => [
      l.Station.StationID,
      l.StationObsTimes.StationObsTime.map((o) => ({ t: Date.parse(o.DateTime) / 1000, e: o.WeatherElements })),
    ]),
  )
}

/** One element's measurements, oldest first; missing values come as "None" or "-". */
function series(records: { t: number; e: Elements }[], read: (e: Elements) => string | undefined): Series {
  const out: Series = []
  for (const { t, e } of records) {
    const raw = read(e)
    const value = Number(raw)
    if (raw && Number.isFinite(value)) out.push([t, value])
  }
  return out.sort((a, b) => a[0] - b[0])
}

/** The buoys' wave heights and wind; a buoy with neither in the last 48 hours is left out. */
export async function fetchBuoys(key: string, stations: Station[]): Promise<Buoy[]> {
  const records = await fetchObservations(key, stations, 'WaveHeight,PrimaryAnemometer')
  return stations.flatMap((station) => {
    const r = records.get(station.id) ?? []
    const buoy = { ...station, waves: series(r, (e) => e.WaveHeight), wind: series(r, (e) => e.PrimaryAnemometer?.WindSpeed) }
    return buoy.waves.length || buoy.wind.length ? [buoy] : []
  })
}

/** The tide gauges' sea levels; a gauge with none in the last 48 hours is left out. */
export async function fetchTides(key: string, stations: Station[]): Promise<TideGauge[]> {
  const records = await fetchObservations(key, stations, 'TideHeight')
  return stations.flatMap((station) => {
    const levels = series(records.get(station.id) ?? [], (e) => e.TideHeight)
    return levels.length ? [{ ...station, levels }] : []
  })
}
