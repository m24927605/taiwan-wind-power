import { describe, expect, it } from 'vitest'
import { fromUtm, toUtm } from './utm'

describe('UTM', () => {
  it('puts the central meridian at 500 km east', () => {
    const [e, n] = toUtm(123, 0, 51)
    expect(e).toBeCloseTo(500000, 3)
    expect(n).toBeCloseTo(0, 3)
  })

  it('matches the extent Element84 lists for Sentinel-2 tile 51QTG', () => {
    // The tile spans 199980 to 309780 m east and 2590200 to 2700000 m north; its STAC bbox is
    // 120.0422966 to 121.1383977 E and 23.3941022 to 24.4017970 N.
    const corners = [
      [199980, 2590200],
      [199980, 2700000],
      [309780, 2590200],
      [309780, 2700000],
    ].map(([e, n]) => fromUtm(e, n, 51))
    // About 10 m.
    const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-4)
    near(Math.min(...corners.map((c) => c[0])), 120.0422966)
    near(Math.max(...corners.map((c) => c[0])), 121.1383977)
    near(Math.min(...corners.map((c) => c[1])), 23.3941022)
    near(Math.max(...corners.map((c) => c[1])), 24.401797)
  })

  it('round-trips', () => {
    const [lon, lat] = fromUtm(...toUtm(120.05, 24.25, 51), 51)
    expect(lon).toBeCloseTo(120.05, 8)
    expect(lat).toBeCloseTo(24.25, 8)
  })
})
