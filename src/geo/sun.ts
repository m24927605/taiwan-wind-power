// Solar position (NOAA low-precision algorithm), accurate to well under a degree.

const RAD = Math.PI / 180

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
