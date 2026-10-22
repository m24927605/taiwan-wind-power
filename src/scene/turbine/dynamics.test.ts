import { beforeEach, describe, expect, it } from 'vitest'
import { windOnly } from '../../test/weather'
import { advanceFarms, farmDynamics } from './dynamics'
import { TURBINE } from './spec'

const HOUR = 3600
// Rises through cut-out at hour 2, falls back between restart and cut-out, then below restart.
const storm = windOnly([20, 26, 31, 27, 23, 21, 20])

const stateAt = (hour: number) => {
  advanceFarms(storm, hour * HOUR, 1)
  return farmDynamics.shutDown[0] === 1
}

describe('high-wind shutdown', () => {
  beforeEach(() => {
    farmDynamics.initialised = false
  })

  it('derates below cut-out without shutting down', () => {
    expect(stateAt(1)).toBe(false)
    expect(farmDynamics.power[0]).toBeGreaterThan(0)
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
    expect(farmDynamics.power[0]).toBe(0)
    advanceFarms(storm, 3 * HOUR, 1e3)
    expect(farmDynamics.rpm[0]).toBeCloseTo(TURBINE.idleRpm)
  })
})
