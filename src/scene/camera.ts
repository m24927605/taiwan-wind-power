import type { CameraControls } from '@react-three/drei'
import * as THREE from 'three'
import { TURBINES } from '../data/windfarms'
import { playEffect } from '../audio/engine'
import { useStore } from '../state'
import type { FarmArea } from './farmAreas'
import { TURBINE } from './turbine/spec'
import { TURBINE_SCALE, farmDynamics } from './turbine/dynamics'

// Imperative camera API shared by the rig, pointer interaction and UI.

export const OVERVIEW = {
  position: new THREE.Vector3(-120, 210, 250),
  target: new THREE.Vector3(5, 0, -5),
}

let controlsInstance: CameraControls | null = null

export function registerControls(controls: CameraControls | null) {
  controlsInstance = controls
}

export function getControls(): CameraControls | null {
  return controlsInstance
}

/** Glide to a three-quarter view of a turbine's nacelle, from the side its rotor faces away from. */
export function flyToTurbine(index: number) {
  const t = TURBINES[index]
  playEffect('select')
  playEffect('fly')
  const yaw = farmDynamics.yaw[t.farm]
  const hubY = TURBINE.hubHeight * TURBINE_SCALE
  const angle = yaw + Math.PI * 0.62
  const r = 0.24
  // Aim at the middle of the nacelle, a few metres behind the hub.
  const back = -6 * TURBINE_SCALE
  controlsInstance?.setLookAt(
    t.x + Math.sin(angle) * r,
    hubY + 0.085,
    t.z + Math.cos(angle) * r,
    t.x + Math.sin(yaw) * back,
    hubY - 0.012,
    t.z + Math.cos(yaw) * back,
    true,
  )
}

/** Oblique view over a whole wind farm, from the south-east so the coast sits behind it. */
export function flyToFarm({ center, radius }: FarmArea) {
  const r = radius * 2.2 + 2
  playEffect('fly')
  useStore.setState({ selected: null, hoveredFarm: null })
  controlsInstance?.setLookAt(center[0] + r * 0.55, r * 0.55, center[1] + r * 0.8, center[0], 0, center[1], true)
}

/** Overview camera position, pulled back on portrait screens so both coasts stay in frame. */
export function overviewPosition(aspect: number): THREE.Vector3 {
  const pullBack = THREE.MathUtils.clamp(1.15 / aspect, 1, 2)
  return OVERVIEW.position.clone().sub(OVERVIEW.target).multiplyScalar(pullBack).add(OVERVIEW.target)
}

export function flyToOverview(animate: boolean) {
  const c = controlsInstance
  if (!c) return
  const p = overviewPosition((c.camera as THREE.PerspectiveCamera).aspect)
  if (animate) playEffect('fly')
  c.setLookAt(p.x, p.y, p.z, ...OVERVIEW.target.toArray(), animate)
}

export function resetView() {
  useStore.setState({ selected: null })
  flyToOverview(true)
}
