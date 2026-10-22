import * as THREE from 'three'
import { TURBINES, WIND_FARMS } from '../data/windfarms'

/** Margin around the outermost turbines, km. */
const PADDING = 0.8
/** Outlines float just above the sea. */
export const AREA_LIFT = 0.03

export interface FarmArea {
  center: [x: number, z: number]
  /** Westernmost corner: labels hang off it into the open strait. */
  anchor: [number, number, number]
  corners: [number, number, number][]
  width: number
  depth: number
  angle: number
  radius: number
  capacity: number
  /** Unit axes along and across the array heading, with the rectangle's extent on each. */
  along: [number, number]
  across: [number, number]
  extent: [a0: number, a1: number, b0: number, b1: number]
}

/** Rectangle aligned with each farm's array heading, around its turbines plus a margin. */
export const FARM_AREAS: FarmArea[] = WIND_FARMS.map((farm, f) => {
  const h = (farm.heading * Math.PI) / 180
  const along: [number, number] = [Math.sin(h), -Math.cos(h)]
  const across: [number, number] = [Math.cos(h), Math.sin(h)]
  let a0 = Infinity
  let a1 = -Infinity
  let b0 = Infinity
  let b1 = -Infinity
  for (const t of TURBINES) {
    if (t.farm !== f) continue
    const a = t.x * along[0] + t.z * along[1]
    const b = t.x * across[0] + t.z * across[1]
    a0 = Math.min(a0, a - PADDING)
    a1 = Math.max(a1, a + PADDING)
    b0 = Math.min(b0, b - PADDING)
    b1 = Math.max(b1, b + PADDING)
  }
  const point = (a: number, b: number): [number, number, number] => [
    along[0] * a + across[0] * b,
    AREA_LIFT,
    along[1] * a + across[1] * b,
  ]
  const corners = [point(a0, b0), point(a1, b0), point(a1, b1), point(a0, b1), point(a0, b0)]
  const c = point((a0 + a1) / 2, (b0 + b1) / 2)
  return {
    center: [c[0], c[2]],
    anchor: corners.slice(0, 4).reduce((w, p) => (p[0] < w[0] ? p : w)),
    corners,
    width: b1 - b0,
    depth: a1 - a0,
    angle: -h,
    radius: Math.hypot(a1 - a0, b1 - b0) / 2,
    capacity: farm.turbines * farm.ratedMW,
    along,
    across,
    extent: [a0, a1, b0, b1],
  }
})

/** Camera distance from a farm's centre in its fly-to view. */
export function farmViewDistance(area: FarmArea): number {
  return (area.radius * 2.2 + 2) * Math.hypot(0.55, 0.55, 0.8)
}

/** Distance from a point to a farm's centre, in fly-to view distances. */
function viewDistances(area: FarmArea, p: THREE.Vector3): number {
  return Math.hypot(p.x - area.center[0], p.y, p.z - area.center[1]) / farmViewDistance(area)
}

/** Within this many fly-to view distances, a farm's turbines are picked one by one. */
const NEAR = 1.5

/** The farm the eye has come in to, where its turbines are picked one by one; the nearest wins. */
export function nearFarm(eye: THREE.Vector3): number | null {
  let best: number | null = null
  let bestD = NEAR
  for (let i = 0; i < FARM_AREAS.length; i++) {
    const d = viewDistances(FARM_AREAS[i], eye)
    if (d <= bestD) {
      bestD = d
      best = i
    }
  }
  return best
}

const hit = new THREE.Vector3()

/**
 * The farm area under a ray, while the camera is still well outside that farm's fly-to view.
 * Closer in, clicks belong to the individual turbines.
 */
export function pickFarm(ray: THREE.Ray): number | null {
  if (ray.direction.y >= 0) return null
  ray.at((AREA_LIFT - ray.origin.y) / ray.direction.y, hit)
  for (let i = 0; i < FARM_AREAS.length; i++) {
    const { along, across, extent } = FARM_AREAS[i]
    const a = hit.x * along[0] + hit.z * along[1]
    const b = hit.x * across[0] + hit.z * across[1]
    if (a < extent[0] || a > extent[1] || b < extent[2] || b > extent[3]) continue
    return viewDistances(FARM_AREAS[i], ray.origin) > NEAR ? i : null
  }
  return null
}
