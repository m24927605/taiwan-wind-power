import { lonLatToWorld, worldToDomainUv } from '../geo/domain'
import type { Buoy, Cyclone, CycloneFix, Series, TideGauge } from './cwa'
import { blend, pullsAt, type Reach, type Site } from './correction'
import { CURRENT_GRID, MARINE_POINTS, SEA_COMPONENTS, fetchOpenMeteo, getJson, gridCoordinates, type OpenMeteo } from './openMeteo'
import type { WeatherPayload } from './payload'
import { WIND_FARMS } from './windfarms'

// Live hourly ocean currents, sea state and sea level on a grid over the domain, and hub-height
// wind at every wind farm, each pulled toward what CWA's stations measure, from yesterday through three days ahead (see openMeteo.ts). They come from the shared
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
  /** Per hour, on the current grid: sea level against mean sea level, tides included, m. */
  seaLevel: Float32Array[]
  /** Per farm: [speed m/s, direction-from degrees] per hour, interleaved. */
  wind: Float32Array[]
  /** When the data was retrieved from Open-Meteo, unix seconds. */
  fetchedAt: number
  /**
   * What each farm delivered by Taipower's latest reading, MW, null for a farm it does not list;
   * null when no reading came. A reading holds for its moment only.
   */
  generation: { at: number; mw: (number | null)[] } | null
  /** Active tropical cyclones, from CWA. */
  cyclones: Cyclone[]
  /** The measurements the model was corrected with, by kind; null where none came. */
  observed: { waves: Observed | null; wind: Observed | null; tide: Observed | null }
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

export function parseWeather(
  { at, marine, wind, windBuoys, buoys = [], tides = [], cyclones = [], generation }: WeatherPayload,
  source: Weather['source'],
): Weather {
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
  const waves = correctSea(sea, times, buoys)

  const seaLevel = times.map((_, h) => {
    const frame = new Float32Array(GRID_POINTS)
    const known = new Uint8Array(GRID_POINTS)
    marine.forEach((point, m) => {
      const level = point.hourly.sea_level_height_msl[h]
      if (level === null) return
      frame[MARINE_POINTS[m]] = level
      known[MARINE_POINTS[m]] = 1
    })
    fillUnknown(frame, known, 1)
    return frame
  })
  const tide = correctSeaLevel(seaLevel, times, tides)

  // Hourly values of a point's series on the marine hours; 0 where it has none.
  const onHours = (series: { time: number[] } & Record<string, (number | null)[]>, key: string) => {
    const byTime = new Map(series.time.map((t, i) => [t, i]))
    return times.map((t) => {
      const i = byTime.get(t)
      return i === undefined ? 0 : (series[key][i] ?? 0)
    })
  }
  const windByFarm = wind.slice(0, WIND_FARMS.length).map(({ hourly }) => {
    const speed = onHours(hourly, 'wind_speed_100m')
    const from = onHours(hourly, 'wind_direction_100m')
    return new Float32Array(times.flatMap((_, h) => [speed[h], from[h]]))
  })
  const surfaceSites = (windBuoys ?? []).flatMap((id, k) => {
    const buoy = buoys.find((b) => b.id === id)
    return buoy ? [{ buoy, modelled: onHours(wind[WIND_FARMS.length + k].hourly, 'wind_speed_10m') }] : []
  })
  const windObserved = correctWind(windByFarm, times, surfaceSites)

  return {
    times,
    currents,
    sea,
    seaLevel,
    wind: windByFarm,
    fetchedAt: at / 1000,
    cyclones,
    generation: generation ? { at: generation.at, mw: WIND_FARMS.map((f) => farmOutput(f.taipowerUnits, generation.units)) } : null,
    observed: { waves, wind: windObserved, tide },
    source,
  }
}

/**
 * A reading stands for the scene this long either side of it, s: Taipower reads every ten minutes
 * and publishes a few minutes later, and the Worker and the app each poll every ten.
 */
const GENERATION_HOLD_S = 45 * 60

/** Taipower's reading when the scene time is near it, else null: it holds for its moment only. */
export function generationAt(weather: Weather, t: number): Weather['generation'] {
  const g = weather.generation
  return g && Math.abs(t - g.at) <= GENERATION_HOLD_S ? g : null
}

/**
 * A cyclone at time t, interpolated along its track and on into the forecast; null before its
 * first fix or after its last. Radii a fix does not give are taken as absent.
 */
export function cycloneAt(cyclone: Cyclone, t: number): CycloneFix | null {
  const fixes = [...cyclone.track, ...cyclone.forecast.filter((f) => f.t > (cyclone.track.at(-1)?.t ?? -Infinity))]
  const j = fixes.findIndex((f) => f.t >= t)
  if (j < 0 || (j === 0 && fixes[0].t > t)) return null
  if (j === 0) return fixes[0]
  const [a, b] = [fixes[j - 1], fixes[j]]
  const k = (t - a.t) / (b.t - a.t)
  const mix = (x: number | null, y: number | null) => (x === null || y === null ? null : x + (y - x) * k)
  return {
    t,
    lon: a.lon + (b.lon - a.lon) * k,
    lat: a.lat + (b.lat - a.lat) * k,
    wind: mix(a.wind, b.wind),
    pressure: a.pressure + (b.pressure - a.pressure) * k,
    r15: mix(a.r15, b.r15),
    r25: mix(a.r25, b.r25),
    r70: b.r70 === null ? null : (a.r70 ?? 0) + (b.r70 - (a.r70 ?? 0)) * k,
  }
}

/** A farm's output as the sum of its units Taipower lists; null when it lists none of them. */
function farmOutput(names: string[], units: Record<string, number>): number | null {
  const listed = names.filter((n) => n in units)
  return listed.length ? listed.reduce((sum, n) => sum + units[n], 0) : null
}

/** What a set of stations measured: how many reported and the newest measurement; null if none. */
function observed(series: Series[]): Observed | null {
  const reported = series.filter((s) => s.length > 0)
  return reported.length ? { stations: reported.length, at: Math.max(...reported.map((s) => s[s.length - 1][0])) } : null
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

/** Sea level against mean sea level at a world position, tides included, m. */
export function seaLevelAt(weather: Weather, t: number, x: number, z: number): number {
  const f = hourIndex(weather, t)
  const i = Math.floor(f)
  const j = Math.min(i + 1, weather.times.length - 1)
  const k = f - i
  let level = 0
  for (const [p, w] of gridCorners(x, z)) level += (weather.seaLevel[i][p] * (1 - k) + weather.seaLevel[j][p] * k) * w
  return level
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
function correctSea(sea: Float32Array[], times: number[], buoys: Buoy[]): Observed | null {
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
  return observed(buoys.map((b) => b.waves))
}

/**
 * How far tide gauges pull the modelled sea level. The tide changes slowly along the coast, but
 * gauges stand in harbours and river mouths the 8 km model does not resolve.
 */
const TIDE_REACH: Reach = { km: 30, s: 6 * 3600, modelWeight: 0.1 }
/**
 * A gauge needs this many hours beside the model to find its datum against mean sea level: most of
 * a day, which spans the semidiurnal tide's cycles. Just after the model's day turns, at midnight
 * UTC, it reaches back only 24 hours and the gauges lag an hour, so a full day would be too many.
 */
const MIN_TIDE_HOURS = 20

/**
 * Shifts the modelled sea level toward the tide gauges, in place. Each gauge measures against its
 * own datum, not mean sea level, so its mean offset from the model over the hours both cover is
 * taken out first; what pulls is the rest: the timing and range of the tide where the model gets
 * them wrong, and surges it misses.
 */
function correctSeaLevel(seaLevel: Float32Array[], times: number[], gauges: TideGauge[]): Observed | null {
  const sites: Site[] = []
  const used: Series[] = []
  for (const gauge of gauges) {
    const [x, z] = lonLatToWorld(gauge.lon, gauge.lat)
    const corners = gridCorners(x, z)
    const pairs = gauge.levels.flatMap(([t, measured]) => {
      const h = hourAt(times, t)
      if (h === null) return []
      let modelled = 0
      for (const [p, w] of corners) modelled += seaLevel[h][p] * w
      return [[t, measured - modelled] as [number, number]]
    })
    if (pairs.length < MIN_TIDE_HOURS) continue
    const offset = pairs.reduce((sum, [, d]) => sum + d, 0) / pairs.length
    sites.push({ x, z, residuals: pairs.map(([t, d]) => [t, d - offset]) })
    used.push(gauge.levels)
  }
  times.forEach((t, h) => {
    const pulls = pullsAt(sites, t, TIDE_REACH)
    if (pulls.length === 0) return
    GRID_XZ.forEach(([px, pz], p) => {
      seaLevel[h][p] += blend(pulls, px, pz, TIDE_REACH)
    })
  })
  return observed(used)
}

/**
 * How far buoys pull the farms' wind: the nearest stand 7 to 45 km from the farms. A buoy's
 * anemometer rides a few metres above breaking seas, so the model keeps more weight than against
 * the wave heights: about a quarter at a buoy, half at 45 km, almost all beyond 80 km.
 */
const WIND_REACH: Reach = { km: 40, s: 6 * 3600, modelWeight: 0.3 }
/**
 * CWA does not publish its anemometer heights; on its 2.5 to 3 m discus buoys they stand about
 * 3.5 m above the sea, and the neutral log profile over open sea (roughness 0.2 mm) takes the
 * wind there to 10 m by this factor.
 */
const ANEMOMETER_TO_10M = 1.1
/** Below this modelled wind, m/s, a ratio is mostly noise. */
const MIN_MODEL_WIND = 2

/**
 * Scales the farms' hub-height wind toward the buoys', in place. Each buoy's measurement, taken to
 * 10 m, gives a ratio to the model's 10 m wind at the buoy; the farms take the blended ratio at
 * their hub height too, as the model's profile between 10 and 100 m stands.
 */
function correctWind(windByFarm: Float32Array[], times: number[], buoys: { buoy: Buoy; modelled: number[] }[]): Observed | null {
  const sites: Site[] = buoys.flatMap(({ buoy, modelled }) => {
    const [x, z] = lonLatToWorld(buoy.lon, buoy.lat)
    const residuals = buoy.wind.flatMap(([t, measured]) => {
      const h = hourAt(times, t)
      if (h === null || modelled[h] < MIN_MODEL_WIND) return []
      const ratio = Math.min(Math.max((measured * ANEMOMETER_TO_10M) / modelled[h], 1 / MAX_RATIO), MAX_RATIO)
      return [[t, Math.log(ratio)] as [number, number]]
    })
    return residuals.length ? [{ x, z, residuals }] : []
  })
  const farms = WIND_FARMS.map((f) => lonLatToWorld(f.lon, f.lat))
  times.forEach((t, h) => {
    const pulls = pullsAt(sites, t, WIND_REACH)
    if (pulls.length === 0) return
    farms.forEach(([fx, fz], f) => {
      windByFarm[f][h * 2] *= Math.exp(blend(pulls, fx, fz, WIND_REACH))
    })
  })
  return sites.length ? observed(buoys.filter(({ buoy }) => buoy.wind.length).map(({ buoy }) => buoy.wind)) : null
}

/** The index of an hour in the series, or null when it is not one of them. */
function hourAt(times: number[], t: number): number | null {
  const h = (t - times[0]) / 3600
  return Number.isInteger(h) && h >= 0 && h < times.length ? h : null
}
