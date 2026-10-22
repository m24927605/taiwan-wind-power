import { describe, expect, it } from 'vitest'
import { TURBINE, powerAt, rpmAt } from './spec'

describe('powerAt', () => {
  it('follows the cubic curve up to rated', () => {
    expect(powerAt(TURBINE.cutInMs - 0.1)).toBe(0)
    expect(powerAt(TURBINE.cutInMs)).toBe(0)
    expect(powerAt(TURBINE.ratedMs - 1e-9)).toBeCloseTo(TURBINE.ratedPowerMW)
    expect(powerAt(18)).toBe(TURBINE.ratedPowerMW)
  })

  it('eases down from the derating to nothing at cut-out', () => {
    expect(powerAt(TURBINE.derateMs)).toBe(TURBINE.ratedPowerMW)
    expect(powerAt((TURBINE.derateMs + TURBINE.cutOutMs) / 2)).toBeCloseTo(TURBINE.ratedPowerMW / 2)
    expect(powerAt(TURBINE.cutOutMs)).toBe(0)
  })

  it('gives nothing while shut down', () => {
    expect(powerAt(20, true)).toBe(0)
  })
})

describe('rpmAt', () => {
  it('idles while shut down or beyond cut-out', () => {
    expect(rpmAt(20, true)).toBe(TURBINE.idleRpm)
    expect(rpmAt(TURBINE.cutOutMs + 5)).toBe(TURBINE.idleRpm)
  })

  it('holds rated speed between rated and the derating', () => {
    expect(rpmAt(TURBINE.ratedMs)).toBeCloseTo(TURBINE.ratedRpm)
    expect(rpmAt(TURBINE.derateMs)).toBeCloseTo(TURBINE.ratedRpm)
    expect(rpmAt(TURBINE.derateMs + 1)).toBeLessThan(TURBINE.ratedRpm)
  })
})
