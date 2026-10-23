import { beforeEach, describe, expect, it } from 'vitest'
import { WIND_FARMS } from '../../data/windfarms'
import { windOnly } from '../../test/weather'
import { advanceFarms, farmDynamics, totalOutputMW } from './dynamics'
import { TURBINE } from './spec'

const HOUR = 3600
// Rises through cut-out at hour 2, falls back between restart and cut-out, then below restart.
const storm = windOnly([20, 26, 31, 27, 23, 21, 20])
/** A farm whose machines ride through 25 to 31 m/s, and one whose machines stop at 25 m/s. */
const RIDES = WIND_FARMS.findIndex((f) => f.model === 'V174-9.5')
const STOPS = WIND_FARMS.findIndex((f) => f.model === 'SG 8.0-167 DD')

const stateAt = (hour: number, farm = RIDES) => {
  advanceFarms(storm, hour * HOUR, 1)
  return farmDynamics.shutDown[farm] === 1
}

describe('high-wind shutdown', () => {
  beforeEach(() => {
    farmDynamics.initialised = false
  })

  it('derates below cut-out without shutting down', () => {
    expect(stateAt(1)).toBe(false)
    expect(farmDynamics.power[RIDES]).toBeGreaterThan(0)
  })

  it('shuts down at once where the machine does not ride through', () => {
    expect(stateAt(1, STOPS)).toBe(true)
    expect(farmDynamics.power[STOPS]).toBe(0)
    expect(stateAt(4, STOPS)).toBe(true)
    expect(stateAt(5, STOPS)).toBe(false)
  })

  it('shuts down at cut-out and stays down until the wind falls below restart', () => {
    expect([2, 3, 4, 4.5].map(stateAt)).toEqual([true, true, true, true])
    expect(stateAt(5)).toBe(false)
  })

  it('does not depend on the frames before, so the timeline can be scrubbed', () => {
    expect(stateAt(0)).toBe(false)
    expect(stateAt(4)).toBe(true)
    expect(stateAt(6)).toBe(false)
    expect(stateAt(3)).toBe(true)
  })

  it('produces nothing and idles while down', () => {
    stateAt(3)
    expect(farmDynamics.power[RIDES]).toBe(0)
    advanceFarms(storm, 3 * HOUR, 1e3)
    expect(farmDynamics.rpm[RIDES]).toBeCloseTo(TURBINE.idleRpm)
  })
})

describe("Taipower's output", () => {
  const farm = WIND_FARMS[STOPS]
  const capacity = farm.turbines * farm.ratedMW
  /** The storm, with Taipower reading the given output at hour 1 (26 m/s, the model shut down). */
  const measuring = (mw: (number | null)[]) => ({ ...storm, generation: { at: HOUR, mw } })
  const output = (f: number) => farmDynamics.power[f] * farmDynamics.running[f] * WIND_FARMS[f].turbines
  const turningAt = (weather: ReturnType<typeof measuring>, hour: number, f: number) => {
    advanceFarms(weather, hour * HOUR, 1)
    return Math.round(farmDynamics.running[f] * WIND_FARMS[f].turbines)
  }

  beforeEach(() => {
    farmDynamics.initialised = false
  })

  it('turns as many turbines as it calls for where the model has the farm stopped', () => {
    const weather = measuring(WIND_FARMS.map((_, f) => (f === STOPS ? capacity / 4 : null)))
    expect(turningAt(weather, 1, STOPS)).toBe(Math.round(farm.turbines / 4))
    expect(output(STOPS)).toBeCloseTo(capacity / 4, 3)
    expect(farmDynamics.rpm[STOPS]).toBeGreaterThan(TURBINE.idleRpm)
  })

  it('stops a farm the model has running when it measures nothing', () => {
    const weather = measuring(WIND_FARMS.map((_, f) => (f === RIDES ? 0 : null)))
    expect(turningAt(weather, 1, RIDES)).toBe(0)
    expect(output(RIDES)).toBe(0)
    expect(farmDynamics.modelled[RIDES]).toBeGreaterThan(0)
  })

  it('holds while the reading does, then fades back to the model', () => {
    const weather = measuring(WIND_FARMS.map((_, f) => (f === RIDES ? 0 : null)))
    advanceFarms(weather, 1 * HOUR, 1)
    const modelled = farmDynamics.modelled[RIDES]
    advanceFarms(weather, 1.5 * HOUR, 1)
    expect(output(RIDES)).toBe(0)
    advanceFarms(weather, (1 + 3.75 / 2) * HOUR, 1)
    expect(output(RIDES)).toBeCloseTo(farmDynamics.modelled[RIDES] / 2, 3)
    expect(modelled).toBeGreaterThan(0)
    advanceFarms(weather, 4 * HOUR + 1, 1)
    expect(output(RIDES)).toBeCloseTo(farmDynamics.modelled[RIDES], 3)
  })

  it('sums to what Taipower measured where it covers every farm', () => {
    const mw = WIND_FARMS.map((f, i) => (i % 2 ? 0 : (f.turbines * f.ratedMW) / 3))
    advanceFarms(measuring(mw), 1 * HOUR, 1)
    const total = mw.reduce((a, b) => a + b, 0)
    expect(totalOutputMW()).toBeGreaterThan(total * 0.97)
    expect(totalOutputMW()).toBeLessThan(total * 1.03)
  })
})
