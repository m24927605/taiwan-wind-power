import { describe, expect, it } from 'vitest'
import { fitTide } from './harmonics'

const HOUR = 3600
const DAY = 24 * HOUR
const start = Date.parse('2026-09-22T00:00:00Z') / 1000

/** A semidiurnal and a diurnal tide about a datum 0.4 m below the gauge's zero, as fitted. */
const fitOn = (tide: (t: number) => number, days = 30) =>
  fitTide(Array.from({ length: days * 24 }, (_, h): [number, number] => [start + h * HOUR, tide(start + h * HOUR)]))

describe('fitTide', () => {
  const tide = (t: number) => 0.4 + 1.5 * Math.cos((2 * Math.PI * t) / (12.4206012 * HOUR) + 1) + 0.2 * Math.cos((2 * Math.PI * t) / (23.9344697 * HOUR))

  it('finds the mean and reproduces the record', () => {
    const fit = fitOn(tide)
    expect(fit.mean).toBeCloseTo(0.4, 2)
    expect(fit.rms).toBeLessThan(0.05)
    for (const t of [start + 3 * DAY, start + 17.5 * DAY]) expect(fit.predict(t)).toBeCloseTo(tide(t) - 0.4, 1)
  })

  it('leaves weather out of the tide', () => {
    // A day-long half-metre surge in the record.
    const surge = (t: number) => tide(t) + (t > start + 10 * DAY && t < start + 11 * DAY ? 0.5 : 0)
    const fit = fitOn(surge)
    expect(Math.abs(fit.predict(start + 10.5 * DAY) - (tide(start + 10.5 * DAY) - 0.4))).toBeLessThan(0.1)
  })
})
