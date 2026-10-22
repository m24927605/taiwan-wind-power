import { DOMAIN } from '../geo/domain'
import type { OpenMeteo } from './openMeteo'

// Wave heights measured by the Central Weather Administration's buoys: open data O-B0075-001
// (the last 48 hours, hourly, about half an hour behind real time), placed by the station list
// O-B0076-001. Only moored buoys inside the domain count; tide gauges and shore-based wave stations
// do not see the open sea. Both need a CWA key, so the weather service (worker/) fetches them: the
// station list rarely changes and is fetched apart from the observations, which are asked for
// only those stations and only the wave height, a twentieth of the full dataset.

const OBSERVATIONS = 'https://opendata.cwa.gov.tw/api/v1/rest/datastore/O-B0075-001'
const STATIONS = 'https://opendata.cwa.gov.tw/fileapi/v1/opendataapi/O-B0076-001'

export interface BuoyStation {
  id: string
  name: string
  lon: number
  lat: number
}

export interface Buoy extends BuoyStation {
  /** Significant wave height per observed hour: [unix seconds, metres], oldest first. */
  waves: [number, number][]
}

/** What the weather service returns: the Open-Meteo responses and, when CWA answered, the buoys. */
export interface WeatherPayload extends OpenMeteo {
  buoys?: Buoy[]
}

interface Stations {
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

interface Observations {
  Records: {
    SeaSurfaceObs: {
      Location: {
        Station: { StationID: string }
        StationObsTimes: { StationObsTime: { DateTime: string; WeatherElements: { WaveHeight?: string } }[] }
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

/** The moored buoys inside the domain. */
export async function fetchBuoyStations(key: string): Promise<BuoyStation[]> {
  const stations = await getCwa<Stations>(STATIONS, key)
  return stations.cwaopendata.Resources.Resource.Data.SeaSurfaceObs.Location.flatMap(({ Station: s }) => {
    const lon = Number(s.StationLongitude)
    const lat = Number(s.StationLatitude)
    const inside = lon >= DOMAIN.west && lon <= DOMAIN.east && lat >= DOMAIN.south && lat <= DOMAIN.north
    return s.StationAttribute === '浮標站' && inside ? [{ id: s.StationID, name: s.StationName, lon, lat }] : []
  })
}

/** The stations' wave heights; a station with none in the last 48 hours is left out. */
export async function fetchBuoys(key: string, stations: BuoyStation[]): Promise<Buoy[]> {
  const byId = new Map(stations.map((s) => [s.id, s]))
  const observations = await getCwa<Observations>(OBSERVATIONS, key, `&WeatherElement=WaveHeight&StationID=${stations.map((s) => s.id)}`)
  const buoys: Buoy[] = []
  for (const location of observations.Records.SeaSurfaceObs.Location) {
    const station = byId.get(location.Station.StationID)
    if (!station) continue
    const waves: [number, number][] = []
    for (const obs of location.StationObsTimes.StationObsTime) {
      // Missing values come as "None" or "-".
      const height = Number(obs.WeatherElements.WaveHeight)
      if (obs.WeatherElements.WaveHeight && Number.isFinite(height)) waves.push([Date.parse(obs.DateTime) / 1000, height])
    }
    if (waves.length === 0) continue
    waves.sort((a, b) => a[0] - b[0])
    buoys.push({ ...station, waves })
  }
  return buoys
}
