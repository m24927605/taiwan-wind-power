import { WIND_FARMS } from '../data/windfarms'
import type { Weather } from '../data/weather'

/** A weather with the given hub-height wind, m/s per hour, at every farm and nothing else. */
export function windOnly(speeds: number[], start = 0): Weather {
  const times = speeds.map((_, h) => start + h * 3600)
  const series = new Float32Array(speeds.flatMap((s) => [s, 0]))
  return {
    times,
    currents: [],
    sea: [],
    seaLevel: [],
    wind: WIND_FARMS.map(() => series),
    fetchedAt: start,
    generation: null,
    observed: { waves: null, wind: null, tide: null },
    source: 'live',
  }
}
