// Harmonic analysis of an hourly tide record: a least-squares fit of the main constituents, with
// the nodal factors that let the fit predict the tide years away from the month it was fitted on.

/** Speeds, degrees per hour. A month of hourly data resolves these; S2/K2 and K1/P1 need half a year. */
const SPEEDS = {
  M2: 28.9841042,
  S2: 30.0,
  N2: 28.4397295,
  K1: 15.0410686,
  O1: 13.9430356,
  Q1: 13.3986609,
  M4: 57.9682084,
  MS4: 58.9841042,
} as const
type Constituent = keyof typeof SPEEDS
const NAMES = Object.keys(SPEEDS) as Constituent[]
const RAD = Math.PI / 180

/** Nodal amplitude factor f and phase u (degrees) at unix seconds t (Schureman). */
function nodal(name: Constituent, t: number): [number, number] {
  // Longitude of the moon's ascending node.
  const N = (125.0445 - 0.0529538 * ((t - 946728000) / 86400)) * RAD
  const m2: [number, number] = [1.0004 - 0.0373 * Math.cos(N) + 0.0002 * Math.cos(2 * N), -2.14 * Math.sin(N)]
  switch (name) {
    case 'M2':
    case 'N2':
    case 'MS4':
      return m2
    case 'M4':
      return [m2[0] ** 2, 2 * m2[1]]
    case 'K1':
      return [
        1.006 + 0.115 * Math.cos(N) - 0.0088 * Math.cos(2 * N) + 0.0006 * Math.cos(3 * N),
        -8.86 * Math.sin(N) + 0.68 * Math.sin(2 * N) - 0.07 * Math.sin(3 * N),
      ]
    case 'O1':
    case 'Q1':
      return [
        1.0089 + 0.1871 * Math.cos(N) - 0.0147 * Math.cos(2 * N) + 0.0014 * Math.cos(3 * N),
        10.8 * Math.sin(N) - 1.34 * Math.sin(2 * N) + 0.19 * Math.sin(3 * N),
      ]
    case 'S2':
      return [1, 0]
  }
}

function basis(t: number): number[] {
  const hours = t / 3600
  const row = [1]
  for (const name of NAMES) {
    const [f, u] = nodal(name, t)
    const a = (SPEEDS[name] * hours + u) * RAD
    row.push(f * Math.cos(a), f * Math.sin(a))
  }
  return row
}

export interface TideFit {
  /** The record's mean level, its datum's offset from mean sea level. */
  mean: number
  /** RMS of what the constituents leave unexplained (weather, surges), m. */
  rms: number
  /** The tide about mean sea level at unix seconds t, m. */
  predict(t: number): number
}

/** Fits [unix seconds, metres] samples by least squares (normal equations, Gaussian elimination). */
export function fitTide(samples: [number, number][]): TideFit {
  const k = 1 + 2 * NAMES.length
  const A = Array.from({ length: k }, () => new Float64Array(k + 1))
  for (const [t, y] of samples) {
    const r = basis(t)
    for (let i = 0; i < k; i++) {
      for (let j = 0; j < k; j++) A[i][j] += r[i] * r[j]
      A[i][k] += r[i] * y
    }
  }
  for (let i = 0; i < k; i++) {
    let p = i
    for (let j = i + 1; j < k; j++) if (Math.abs(A[j][i]) > Math.abs(A[p][i])) p = j
    ;[A[i], A[p]] = [A[p], A[i]]
    for (let j = i + 1; j < k; j++) {
      const m = A[j][i] / A[i][i]
      for (let c = i; c <= k; c++) A[j][c] -= m * A[i][c]
    }
  }
  const x = new Float64Array(k)
  for (let i = k - 1; i >= 0; i--) {
    let s = A[i][k]
    for (let j = i + 1; j < k; j++) s -= A[i][j] * x[j]
    x[i] = s / A[i][i]
  }
  const level = (t: number) => basis(t).reduce((s, v, i) => s + v * x[i], 0)
  const rms = Math.sqrt(samples.reduce((s, [t, y]) => s + (y - level(t)) ** 2, 0) / samples.length)
  return { mean: x[0], rms, predict: (t) => level(t) - x[0] }
}
