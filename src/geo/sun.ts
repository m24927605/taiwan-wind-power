// Solar position (NOAA low-precision algorithm), accurate to well under a degree, the moon's, and
// the turning of the stars.

const RAD = Math.PI / 180

/** Where the sky is seen from: the middle of Taiwan. */
export const OBSERVER = { lon: 120.9, lat: 23.7 } as const

/**
 * Row-major rotation from J2000 equatorial unit vectors (x to the March equinox, z to the north
 * celestial pole) to world space (+x east, +y up, -z north) at a time and place: the rows are the
 * observer's east, zenith and south in equatorial coordinates, turned by local sidereal time.
 */
export function equatorialToWorld(unixSeconds: number, lon: number, lat: number): number[] {
  const days = unixSeconds / 86400 + 2440587.5 - 2451545.0
  const gmst = (18.697374558 + 24.06570982441908 * days) % 24
  const lst = (gmst * 15 + lon) * RAD
  const phi = lat * RAD
  const [cl, sl, cp, sp] = [Math.cos(lst), Math.sin(lst), Math.cos(phi), Math.sin(phi)]
  return [-sl, cl, 0, cp * cl, cp * sl, sp, sp * cl, sp * sl, -cp]
}

/** Unit vector pointing at the sun in world space (+x east, -z north, +y up). */
export function sunDirection(unixSeconds: number, lon: number, lat: number): [number, number, number] {
  const days = unixSeconds / 86400 + 2440587.5 - 2451545.0
  const g = (357.529 + 0.98560028 * days) * RAD
  const q = 280.459 + 0.98564736 * days
  const l = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD
  const e = (23.439 - 0.00000036 * days) * RAD
  const ra = Math.atan2(Math.cos(e) * Math.sin(l), Math.cos(l))
  const dec = Math.asin(Math.sin(e) * Math.sin(l))
  const gmst = (18.697374558 + 24.06570982441908 * days) % 24
  const hourAngle = (gmst * 15 + lon) * RAD - ra
  const phi = lat * RAD
  const elevation = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(hourAngle))
  const azimuth = Math.atan2(-Math.sin(hourAngle), Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(hourAngle))
  const c = Math.cos(elevation)
  return [Math.sin(azimuth) * c, Math.sin(elevation), -Math.cos(azimuth) * c]
}

/** Unit vector pointing at the moon (low precision, about a degree), same frame as sunDirection. */
export function moonDirection(unixSeconds: number, lon: number, lat: number): [number, number, number] {
  const days = unixSeconds / 86400 + 2440587.5 - 2451545.0
  const e = 23.4397 * RAD
  const M = (134.963 + 13.064993 * days) * RAD
  const F = (93.272 + 13.22935 * days) * RAD
  const l = (218.316 + 13.176396 * days) * RAD + 6.289 * RAD * Math.sin(M)
  const b = 5.128 * RAD * Math.sin(F)
  const ra = Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l))
  const dec = Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l))
  const gmst = (18.697374558 + 24.06570982441908 * days) % 24
  const hourAngle = (gmst * 15 + lon) * RAD - ra
  const phi = lat * RAD
  const elevation = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(hourAngle))
  const azimuth = Math.atan2(-Math.sin(hourAngle), Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(hourAngle))
  const c = Math.cos(elevation)
  return [Math.sin(azimuth) * c, Math.sin(elevation), -Math.cos(azimuth) * c]
}
