import { DOMAIN } from '../geo/domain'

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

/**
 * Each station's hourly records of the given elements over the last `hours`, keyed by station id.
 * The dataset holds 48 hours; asking for fewer keeps the response, and the Worker's CPU, down.
 */
async function fetchObservations(key: string, stations: Station[], elements: string, hours = 48) {
  // Taiwan time, without an offset, as the dataset writes it.
  const from = new Date(Date.now() + (8 - hours) * 3600 * 1000).toISOString().slice(0, 19)
  const query = `&WeatherElement=${elements}&StationID=${stations.map((s) => s.id)}&timeFrom=${from}`
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

/**
 * The buoys' wave heights and wind over the last day, as far back as the model reaches; a buoy with
 * neither is left out. The anemometer comes with gusts and Beaufort numbers, three times the
 * bytes of the wave heights, so two days would not fit the Worker's CPU budget.
 */
export async function fetchBuoys(key: string, stations: Station[]): Promise<Buoy[]> {
  const records = await fetchObservations(key, stations, 'WaveHeight,PrimaryAnemometer', 24)
  return stations.flatMap((station) => {
    const r = records.get(station.id) ?? []
    const buoy = { ...station, waves: series(r, (e) => e.WaveHeight), wind: series(r, (e) => e.PrimaryAnemometer?.WindSpeed) }
    return buoy.waves.length || buoy.wind.length ? [buoy] : []
  })
}

/**
 * The tide gauges' sea levels over the last 30 hours; a gauge with none is left out. The model
 * starts at midnight UTC yesterday, so older readings would match no model hour, and 30 hours
 * always leave the overlap the correction needs (see weather.ts).
 */
export async function fetchTides(key: string, stations: Station[]): Promise<TideGauge[]> {
  const records = await fetchObservations(key, stations, 'TideHeight', 30)
  return stations.flatMap((station) => {
    const levels = series(records.get(station.id) ?? [], (e) => e.TideHeight)
    return levels.length ? [{ ...station, levels }] : []
  })
}

// Tropical cyclones: W-C0034-005, every active one over the north-west Pacific and the South
// China Sea, with its track so far (hourly fixes) and CWA's forecast (6 hours to about four days
// ahead).

const CYCLONES = 'https://opendata.cwa.gov.tw/api/v1/rest/datastore/W-C0034-005'

export interface CycloneFix {
  /** Unix seconds. */
  t: number
  lon: number
  lat: number
  /** Maximum sustained wind, m/s; null where not given. */
  wind: number | null
  /** Central pressure, hPa. */
  pressure: number
  /** Radius of winds of 15 m/s (gale, Beaufort 7) and 25 m/s (storm, Beaufort 10), km; null where none. */
  r15: number | null
  r25: number | null
  /** Forecast fixes: the radius the centre falls within with 70 % probability, km. */
  r70: number | null
}

export interface Cyclone {
  name: string
  nameEn: string
  /** Analysed fixes, oldest first. */
  track: CycloneFix[]
  /** Forecast fixes from the latest analysis, earliest first. */
  forecast: CycloneFix[]
}

interface RawFix {
  DateTime?: string
  InitialTime?: string
  ForecastHour?: string
  CoordinateLongitude: string
  CoordinateLatitude: string
  MaxWindSpeed?: string
  Pressure: string
  Circle15ms?: { Radius: string }
  Circle25ms?: { Radius: string }
  Radius70PercentProbability?: string
}

interface RawCyclones {
  records: {
    TropicalCyclones?: {
      TropicalCyclone: {
        TyphoonName: string
        CwaTyphoonName?: string
        AnalysisData: { Fix: RawFix[] }
        ForecastData?: { Fix: RawFix[] }
      }[]
    }
  }
}

function fix(raw: RawFix): CycloneFix {
  const t = raw.DateTime
    ? Date.parse(raw.DateTime) / 1000
    : Date.parse(raw.InitialTime!) / 1000 + Number(raw.ForecastHour) * 3600
  const optional = (v?: string) => (v === undefined || v === '' ? null : Number(v))
  return {
    t,
    lon: Number(raw.CoordinateLongitude),
    lat: Number(raw.CoordinateLatitude),
    wind: optional(raw.MaxWindSpeed),
    pressure: Number(raw.Pressure),
    r15: optional(raw.Circle15ms?.Radius),
    r25: optional(raw.Circle25ms?.Radius),
    r70: optional(raw.Radius70PercentProbability),
  }
}

/** The active tropical cyclones; none outside the season. */
export async function fetchCyclones(key: string): Promise<Cyclone[]> {
  const data = await getCwa<RawCyclones>(CYCLONES, key)
  return (data.records.TropicalCyclones?.TropicalCyclone ?? []).map((c) => ({
    name: c.CwaTyphoonName ?? c.TyphoonName,
    nameEn: c.TyphoonName,
    track: c.AnalysisData.Fix.map(fix).sort((a, b) => a.t - b.t),
    forecast: (c.ForecastData?.Fix ?? []).map(fix).sort((a, b) => a.t - b.t),
  }))
}
