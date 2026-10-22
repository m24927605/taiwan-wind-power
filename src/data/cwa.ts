import { DOMAIN } from '../geo/domain'
import type { OpenMeteo } from './openMeteo'

// Wave heights measured by the Central Weather Administration's buoys: open data O-B0075-001
// (the last 48 hours, hourly, about half an hour behind real time), placed by the station list
// O-B0076-001. Only moored buoys inside the domain count; tide gauges and shore-based wave stations
// do not see the open sea. Both need a CWA key, so the weather service (worker/) fetches them.

const OBSERVATIONS = 'https://opendata.cwa.gov.tw/api/v1/rest/datastore/O-B0075-001'
const STATIONS = 'https://opendata.cwa.gov.tw/fileapi/v1/opendataapi/O-B0076-001'

export interface Buoy {
  id: string
  name: string
  lon: number
  lat: number
  /** Significant wave height per observed hour: [unix seconds, metres], oldest first. */
  waves: [number, number][]
}

/** What the weather service returns: the Open-Meteo responses and, when CWA answered, the buoys. */
export interface WeatherPayload extends OpenMeteo {
  buoys?: Buoy[]
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

export async function fetchBuoys(key: string): Promise<Buoy[]> {
  const get = async <T>(url: string): Promise<T> => {
    // The key never appears in an error: it would end up in logs.
    const res = await fetch(`${url}?Authorization=${encodeURIComponent(key)}&format=JSON`)
    if (!res.ok) throw new Error(`CWA ${new URL(url).pathname}: HTTP ${res.status}`)
    return (await res.json()) as T
  }
  const [observations, stations] = await Promise.all([get<Observations>(OBSERVATIONS), get<Stations>(STATIONS)])
  const moored = new Map(
    stations.cwaopendata.Resources.Resource.Data.SeaSurfaceObs.Location.filter(({ Station: s }) => s.StationAttribute === '浮標站').map(
      ({ Station: s }) => [s.StationID, s] as const,
    ),
  )
  const buoys: Buoy[] = []
  for (const location of observations.Records.SeaSurfaceObs.Location) {
    const station = moored.get(location.Station.StationID)
    if (!station) continue
    const lon = Number(station.StationLongitude)
    const lat = Number(station.StationLatitude)
    if (!(lon >= DOMAIN.west && lon <= DOMAIN.east && lat >= DOMAIN.south && lat <= DOMAIN.north)) continue
    const waves: [number, number][] = []
    for (const obs of location.StationObsTimes.StationObsTime) {
      // Missing values come as "None" or "-".
      const height = Number(obs.WeatherElements.WaveHeight)
      if (obs.WeatherElements.WaveHeight && Number.isFinite(height)) waves.push([Date.parse(obs.DateTime) / 1000, height])
    }
    if (waves.length === 0) continue
    waves.sort((a, b) => a[0] - b[0])
    buoys.push({ id: station.StationID, name: station.StationName, lon, lat, waves })
  }
  return buoys
}
