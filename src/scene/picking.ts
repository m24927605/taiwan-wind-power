import * as THREE from 'three'
import type { Elevation } from '../data/elevation'
import { TURBINES } from '../data/windfarms'
import { TURBINE } from './turbine/spec'
import { TURBINE_SCALE } from './turbine/dynamics'

const base = new THREE.Vector3()
const top = new THREE.Vector3()
const onRay = new THREE.Vector3()
const HUB_Y = TURBINE.hubHeight * TURBINE_SCALE
const ROTOR_R = TURBINE.rotorRadius * TURBINE_SCALE

/**
 * Analytic turbine picking: instanced turbines are yawed and spun in the vertex shader, so mesh
 * raycasting cannot see them. Each turbine is a capsule around its tower axis whose radius never
 * drops below a few pixels, keeping distant turbines clickable.
 */
export function pickTurbine(ray: THREE.Ray): number | null {
  let best: number | null = null
  let bestT = Infinity
  for (const t of TURBINES) {
    base.set(t.x, 0, t.z)
    top.set(t.x, HUB_Y + ROTOR_R * 0.6, t.z)
    const d2 = ray.distanceSqToSegment(base, top, onRay)
    const along = onRay.distanceTo(ray.origin)
    const radius = Math.max(ROTOR_R * 0.7, along * 0.012)
    if (d2 < radius * radius && along < bestT) {
      bestT = along
      best = t.index
    }
  }
  return best
}

/** First intersection of a ray with the terrain heightfield or the sea surface. */
export function pickGround(ray: THREE.Ray, elevation: Elevation): THREE.Vector3 | null {
  if (ray.direction.y >= 0) return null
  const tSea = -ray.origin.y / ray.direction.y
  const steps = 160
  const p = new THREE.Vector3()
  const surface = (q: THREE.Vector3) => Math.max(elevation.heightAt(q.x, q.z), 0) / 1000
  let prev = 0
  for (let i = 1; i <= steps; i++) {
    const t = (tSea * i) / steps
    ray.at(t, p)
    if (p.y <= surface(p)) {
      // Bisect between the last point above ground and this one.
      let lo = prev
      let hi = t
      for (let k = 0; k < 12; k++) {
        const mid = (lo + hi) / 2
        ray.at(mid, p)
        if (p.y <= surface(p)) hi = mid
        else lo = mid
      }
      return ray.at(hi, p)
    }
    prev = t
  }
  return ray.at(tSea, p)
}
