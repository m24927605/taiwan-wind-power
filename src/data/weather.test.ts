import { describe, expect, it } from 'vitest'
import { lonLatToWorld } from '../geo/domain'
import type { Buoy, Cyclone, TideGauge } from './cwa'
import { CURRENT_GRID, MARINE_POINTS } from './openMeteo'
import type { WeatherPayload } from './payload'
import { cycloneAt, parseWeather, seaAt, seaLevelAt, windAt } from './weather'
import { WIND_FARMS } from './windfarms'

const HOUR = 3600
const HOURS = 72
const time = Array.from({ length: HOURS }, (_, h) => h * HOUR)
const constant = (v: number) => time.map(() => v)

/** The modelled tide everywhere: a 1 m semidiurnal wave about mean sea level. */
const modelTide = (t: number) => Math.sin((2 * Math.PI * t) / (12.42 * HOUR))
/** Modelled wind: 10 m/s at every farm's hub, 8 m/s at the surface by every buoy. */
const HUB_WIND = 10
const SURFACE_WIND = 8

/**
 * A uniform model: a 2 m wind sea and a 1 m swell, the tide above, and the wind at the farms and
 * at the given buoys.
 */
function payload({ buoys = [], tides = [], windBuoys = [] }: { buoys?: Buoy[]; tides?: TideGauge[]; windBuoys?: string[] } = {}): WeatherPayload {
  const marine = MARINE_POINTS.map(() => ({
    hourly: {
      time,
      ocean_current_velocity: constant(0),
      ocean_current_direction: constant(0),
      sea_level_height_msl: time.map(modelTide),
      wind_wave_height: constant(2),
      wind_wave_period: constant(5),
      wind_wave_direction: constant(0),
      swell_wave_height: constant(1),
      swell_wave_period: constant(9),
      swell_wave_direction: constant(180),
    },
  }))
  const windPoint = () => ({
    hourly: { time, wind_speed_100m: constant(HUB_WIND), wind_direction_100m: constant(45), wind_speed_10m: constant(SURFACE_WIND) },
  })
  const wind = [...WIND_FARMS, ...windBuoys].map(windPoint)
  return { at: 0, marine, wind, windBuoys, buoys, tides }
}

const STATION = { id: 'B', name: 'test', lon: 120.0, lat: 24.0 }
const [bx, bz] = lonLatToWorld(STATION.lon, STATION.lat)
const MODEL_HS = Math.hypot(2, 1)

describe('buoy wave correction', () => {
  // The buoy measures half the modelled sea at hour 10.
  const weather = parseWeather(payload({ buoys: [{ ...STATION, waves: [[10 * HOUR, MODEL_HS / 2]], wind: [] }] }), 'live')
  const totalHs = (t: number, x: number, z: number) => {
    const { windSea, swell } = seaAt(weather, t, x, z)
    return Math.hypot(windSea.hs, swell.hs)
  }

  it('pulls the model toward the measurement at the buoy', () => {
    const hs = totalHs(10 * HOUR, bx, bz)
    expect(hs).toBeLessThan(MODEL_HS * 0.65)
    expect(hs).toBeGreaterThan(MODEL_HS / 2)
  })

  it('leaves the model alone far from the buoy', () => {
    expect(totalHs(10 * HOUR, bx + 250, bz)).toBeCloseTo(MODEL_HS, 2)
  })

  it('fades back to the model far from the measurement in time', () => {
    expect(totalHs(70 * HOUR, bx, bz)).toBeGreaterThan(MODEL_HS * 0.99)
  })

  it('keeps the periods and records what was observed', () => {
    expect(seaAt(weather, 10 * HOUR, bx, bz).swell.tm).toBeCloseTo(9)
    expect(weather.observed.waves).toEqual({ stations: 1, at: 10 * HOUR })
  })
})

describe('tide gauge correction', () => {
  // The gauge reads 3 m above the model (its datum) and the tide 0.5 m higher than modelled over
  // the hours it covers, the first two days.
  const SURGE = 0.5
  const levels: [number, number][] = time.slice(0, 48).map((t) => [t, modelTide(t) + 3 + (t >= 24 * HOUR ? SURGE : 0)])
  const weather = parseWeather(payload({ tides: [{ ...STATION, levels }] }), 'live')

  it('takes out the datum and pulls toward what is left', () => {
    // The mean offset over the two days is 3.25 m, so the second day sits 0.25 m above the model.
    const shift = seaLevelAt(weather, 40 * HOUR, bx, bz) - modelTide(40 * HOUR)
    expect(shift).toBeGreaterThan(0.2)
    expect(shift).toBeLessThan(0.25)
  })

  it('leaves the model alone far away and far ahead', () => {
    expect(seaLevelAt(weather, 40 * HOUR, bx + 250, bz)).toBeCloseTo(modelTide(40 * HOUR), 2)
    expect(seaLevelAt(weather, 71 * HOUR, bx, bz) - modelTide(71 * HOUR)).toBeLessThan(0.05)
  })

  it('needs most of a day of overlap to trust a gauge', () => {
    const short = parseWeather(payload({ tides: [{ ...STATION, levels: levels.slice(0, 12) }] }), 'live')
    expect(short.observed.tide).toBeNull()
    expect(weather.observed.tide).toEqual({ stations: 1, at: 47 * HOUR })
  })
})

describe('buoy wind correction', () => {
  // A buoy beside the first farm measures, once taken to 10 m, 25 % more wind than modelled.
  const farm = WIND_FARMS[0]
  const buoy: Buoy = { id: 'W', name: 'wind', lon: farm.lon, lat: farm.lat, waves: [], wind: time.map((t) => [t, (SURFACE_WIND * 1.25) / 1.1]) }
  const weather = parseWeather(payload({ buoys: [buoy], windBuoys: ['W'] }), 'live')

  it('scales the hub-height wind of the farms nearby', () => {
    const speed = windAt(weather, 0, 10 * HOUR).speed
    expect(speed).toBeGreaterThan(HUB_WIND * 1.15)
    expect(speed).toBeLessThan(HUB_WIND * 1.25)
    expect(weather.observed.wind).toEqual({ stations: 1, at: 71 * HOUR })
  })

  it('leaves the farms far from it alone', () => {
    const far = WIND_FARMS.findIndex((f) => Math.hypot(f.lon - farm.lon, f.lat - farm.lat) > 0.8)
    expect(windAt(weather, far, 10 * HOUR).speed).toBeLessThan(HUB_WIND * 1.01)
  })
})

describe('Taipower output', () => {
  it('sums the units of each farm and leaves farms it does not list empty', () => {
    const units = { 芳一風: 22.4, 芳二風: 138.6, 海能風: 360.6, 觀園: 21.1 }
    const weather = parseWeather({ ...payload(), generation: { at: 5 * HOUR, units } }, 'live')
    const mw = (id: string) => weather.generation!.mw[WIND_FARMS.findIndex((f) => f.id === id)]
    expect(mw('changfang')).toBeCloseTo(161)
    expect(mw('formosa2')).toBeCloseTo(360.6)
    expect(mw('yunneng')).toBeNull()
    expect(weather.generation!.at).toBe(5 * HOUR)
  })
})

describe('cycloneAt', () => {
  const fix = (h: number, lon: number, r25: number | null, r70: number | null = null) => ({
    t: h * HOUR,
    lon,
    lat: 22,
    wind: 45,
    pressure: 940,
    r15: 300,
    r25,
    r70,
  })
  // Analysed at hours 0 and 1, forecast from hour 1 (repeating the last fix) to hour 7.
  const cyclone: Cyclone = { number: '1', name: '測試', nameEn: 'TEST', track: [fix(0, 125, 140), fix(1, 124.8, 140)], forecast: [fix(1, 124.8, 140, 0), fix(7, 124.2, 120, 30)] }

  it('follows the track, then the forecast', () => {
    expect(cycloneAt(cyclone, 0.5 * HOUR)!.lon).toBeCloseTo(124.9)
    const ahead = cycloneAt(cyclone, 4 * HOUR)!
    expect(ahead.lon).toBeCloseTo(124.5)
    expect(ahead.r25).toBeCloseTo(130)
    expect(ahead.r70).toBeCloseTo(15)
  })

  it('is nowhere before the first fix or after the last', () => {
    expect(cycloneAt(cyclone, -HOUR)).toBeNull()
    expect(cycloneAt(cyclone, 8 * HOUR)).toBeNull()
  })

  it('drops a radius one of its fixes lacks', () => {
    const patchy = { ...cyclone, track: [fix(0, 125, null), fix(1, 124.8, 140)] }
    expect(cycloneAt(patchy, 0.5 * HOUR)!.r25).toBeNull()
  })
})

describe('without measurements', () => {
  const plain = parseWeather(payload(), 'live')

  it('stands as modelled', () => {
    const { windSea, swell } = seaAt(plain, 10 * HOUR, bx, bz)
    expect(windSea.hs).toBeCloseTo(2)
    expect(swell.hs).toBeCloseTo(1)
    expect(seaLevelAt(plain, 10 * HOUR, bx, bz)).toBeCloseTo(modelTide(10 * HOUR))
    expect(windAt(plain, 0, 10 * HOUR).speed).toBeCloseTo(HUB_WIND)
    expect(plain.observed).toEqual({ waves: null, wind: null, tide: null })
    expect(plain.generation).toBeNull()
  })

  it('fills the points left out of the request from their neighbours', () => {
    expect(MARINE_POINTS).not.toContain(0)
    expect(plain.sea[0][0]).toBeCloseTo(2)
    expect(plain.sea[0].length).toBe(CURRENT_GRID.cols * CURRENT_GRID.rows * 8)
  })
})
