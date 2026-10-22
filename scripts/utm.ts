// WGS84 to and from UTM (Krüger series, sub-millimetre within a zone), for Sentinel-2's grids.

const A_ = 6378137
const F = 1 / 298.257223563
const K0 = 0.9996
const N_ = F / (2 - F)
const A = (A_ / (1 + N_)) * (1 + N_ ** 2 / 4 + N_ ** 4 / 64)
const ALPHA = [N_ / 2 - (2 / 3) * N_ ** 2 + (5 / 16) * N_ ** 3, (13 / 48) * N_ ** 2 - (3 / 5) * N_ ** 3, (61 / 240) * N_ ** 3]
const BETA = [N_ / 2 - (2 / 3) * N_ ** 2 + (37 / 96) * N_ ** 3, N_ ** 2 / 48 + N_ ** 3 / 15, (17 / 480) * N_ ** 3]
const DELTA = [2 * N_ - (2 / 3) * N_ ** 2 - 2 * N_ ** 3, (7 / 3) * N_ ** 2 - (8 / 5) * N_ ** 3, (56 / 15) * N_ ** 3]
const centralMeridian = (zone: number) => zone * 6 - 183

/** Easting and northing, m, in a northern-hemisphere zone. */
export function toUtm(lon: number, lat: number, zone: number): [number, number] {
  const phi = (lat * Math.PI) / 180
  const dl = ((lon - centralMeridian(zone)) * Math.PI) / 180
  const e = (2 * Math.sqrt(N_)) / (1 + N_)
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - e * Math.atanh(e * Math.sin(phi)))
  const xi = Math.atan2(t, Math.cos(dl))
  const eta = Math.atanh(Math.sin(dl) / Math.sqrt(1 + t * t))
  let x = eta
  let y = xi
  for (let j = 1; j <= 3; j++) {
    x += ALPHA[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta)
    y += ALPHA[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta)
  }
  return [500000 + K0 * A * x, K0 * A * y]
}

/** Longitude and latitude of a point in a northern-hemisphere zone. */
export function fromUtm(easting: number, northing: number, zone: number): [number, number] {
  const xi = northing / (K0 * A)
  const eta = (easting - 500000) / (K0 * A)
  let x = xi
  let y = eta
  for (let j = 1; j <= 3; j++) {
    x -= BETA[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta)
    y -= BETA[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta)
  }
  const chi = Math.asin(Math.sin(x) / Math.cosh(y))
  let phi = chi
  for (let j = 1; j <= 3; j++) phi += DELTA[j - 1] * Math.sin(2 * j * chi)
  return [centralMeridian(zone) + (Math.atan2(Math.sinh(y), Math.cos(x)) * 180) / Math.PI, (phi * 180) / Math.PI]
}
