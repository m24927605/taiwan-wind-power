import { describe, expect, it } from 'vitest'
import { lonLatToWorld } from '../geo/domain'
import type { Buoy } from './cwa'
import { CURRENT_GRID, MARINE_POINTS } from './openMeteo'
import { parseWeather, seaAt } from './weather'

const HOUR = 3600
const HOURS = 72

/** A uniform model sea: a 2 m wind sea and a 1 m swell everywhere, every hour. */
function payload(buoys?: Buoy[]) {
  const time = Array.from({ length: HOURS }, (_, h) => h * HOUR)
  const constant = (v: number) => time.map(() => v)
  const marine = MARINE_POINTS.map(() => ({
    hourly: {
      time,
      ocean_current_velocity: constant(0),
      ocean_current_direction: constant(0),
      wind_wave_height: constant(2),
      wind_wave_period: constant(5),
      wind_wave_direction: constant(0),
      swell_wave_height: constant(1),
      swell_wave_period: constant(9),
      swell_wave_direction: constant(180),
    },
  }))
  return { at: 0, marine, wind: [], buoys }
}

const BUOY = { id: 'B', name: 'test', lon: 120.0, lat: 24.0 }
const [bx, bz] = lonLatToWorld(BUOY.lon, BUOY.lat)
const totalHs = (t: number, x: number, z: number) => {
  const { windSea, swell } = seaAt(weather, t, x, z)
  return Math.hypot(windSea.hs, swell.hs)
}
const MODEL_HS = Math.hypot(2, 1)
// The buoy measures half the modelled sea at hour 10.
const weather = parseWeather(payload([{ ...BUOY, waves: [[10 * HOUR, MODEL_HS / 2]] }]), 'live')

describe('buoy correction', () => {
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

  it('keeps the periods and records when it was observed', () => {
    expect(seaAt(weather, 10 * HOUR, bx, bz).swell.tm).toBeCloseTo(9)
    expect(weather.observedAt).toBe(10 * HOUR)
  })

  it('fills the points left out of the request from their neighbours', () => {
    const plain = parseWeather(payload(), 'live')
    expect(MARINE_POINTS).not.toContain(0)
    expect(plain.sea[0][0]).toBeCloseTo(2)
    expect(plain.sea[0].length).toBe(CURRENT_GRID.cols * CURRENT_GRID.rows * 8)
  })

  it('stands as modelled without buoys', () => {
    const plain = parseWeather(payload(), 'live')
    const { windSea, swell } = seaAt(plain, 10 * HOUR, bx, bz)
    expect(windSea.hs).toBeCloseTo(2)
    expect(swell.hs).toBeCloseTo(1)
    expect(plain.observedAt).toBe(0)
  })
})
