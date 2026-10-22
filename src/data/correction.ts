// Pulling a model toward measurements. Each station gives a residual against the model at its
// place and hour (a log ratio for wave heights and wind, a difference for sea level); a point
// takes a blend of the residuals, weighted by its distance from each station and by how far the
// hour lies from that station's nearest measurement, against the model's own weight. So near the
// stations and the hours they measured the measurements stand, and far from them, and far into
// the forecast, the model does.

export interface Site {
  /** World position, km. */
  x: number
  z: number
  /** Residuals per measured hour: [unix seconds, residual], any order. */
  residuals: [t: number, residual: number][]
}

export interface Reach {
  /** A station's pull falls to 1/e this far away, km, */
  km: number
  /** and this long either side of its measurement, s. */
  s: number
  /** Where the stations' weights add up to this, half their residual applies. */
  modelWeight: number
}

interface Pull {
  x: number
  z: number
  residual: number
  weight: number
}

/** The stations' pulls at time t: each one's nearest residual, weighted by how far it lies in time. */
export function pullsAt(sites: Site[], t: number, reach: Reach): Pull[] {
  return sites.flatMap(({ x, z, residuals }) => {
    if (residuals.length === 0) return []
    const [tn, residual] = residuals.reduce((best, r) => (Math.abs(r[0] - t) < Math.abs(best[0] - t) ? r : best))
    return [{ x, z, residual, weight: Math.exp(-Math.abs(tn - t) / reach.s) }]
  })
}

/** The blended residual at a world position; 0 where no station reaches. */
export function blend(pulls: Pull[], x: number, z: number, reach: Reach): number {
  let sum = 0
  let weight = 0
  for (const pull of pulls) {
    const w = pull.weight * Math.exp(-((x - pull.x) ** 2 + (z - pull.z) ** 2) / reach.km ** 2)
    sum += w * pull.residual
    weight += w
  }
  return sum / (weight + reach.modelWeight)
}
