import { describe, expect, it } from 'vitest'
import { TURBINE, powerAt, rpmAt } from './spec'

/** Rides through 25 to 31 m/s. */
const RIDES = 'V174-9.5'
/** Stops at 25 m/s. */
const STOPS = 'SG 8.0-167 DD'

describe('powerAt', () => {
  it('follows the cubic curve up to rated', () => {
    expect(powerAt(TURBINE.cutInMs - 0.1, RIDES)).toBe(0)
    expect(powerAt(TURBINE.cutInMs, RIDES)).toBe(0)
    expect(powerAt(TURBINE.ratedMs - 1e-9, RIDES)).toBeCloseTo(TURBINE.ratedPowerMW)
    expect(powerAt(18, RIDES)).toBe(TURBINE.ratedPowerMW)
  })

  it('eases down from the derating to nothing at cut-out on a machine that rides through', () => {
    expect(powerAt(25, RIDES)).toBe(TURBINE.ratedPowerMW)
    expect(powerAt(28, RIDES)).toBeCloseTo(TURBINE.ratedPowerMW / 2)
    expect(powerAt(31, RIDES)).toBe(0)
  })

  it('runs at rated up to cut-out on a machine that stops at once', () => {
    expect(powerAt(25 - 1e-9, STOPS)).toBe(TURBINE.ratedPowerMW)
    expect(powerAt(25, STOPS)).toBe(0)
  })

  it('gives nothing while shut down', () => {
    expect(powerAt(20, RIDES, true)).toBe(0)
  })
})

describe('rpmAt', () => {
  it('idles while shut down or beyond cut-out', () => {
    expect(rpmAt(20, RIDES, true)).toBe(TURBINE.idleRpm)
    expect(rpmAt(26, STOPS)).toBe(TURBINE.idleRpm)
    expect(rpmAt(32, RIDES)).toBe(TURBINE.idleRpm)
  })

  it('holds rated speed between rated and the derating', () => {
    expect(rpmAt(TURBINE.ratedMs, RIDES)).toBeCloseTo(TURBINE.ratedRpm)
    expect(rpmAt(25, RIDES)).toBeCloseTo(TURBINE.ratedRpm)
    expect(rpmAt(26, RIDES)).toBeLessThan(TURBINE.ratedRpm)
  })
})
