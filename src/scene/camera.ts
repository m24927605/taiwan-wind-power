import type { CameraControls } from '@react-three/drei'
import * as THREE from 'three'
import { TURBINES } from '../data/windfarms'
import { WORLD, lonLatToWorld } from '../geo/domain'
import { playEffect } from '../audio/engine'
import { useStore } from '../state'
import type { FarmArea } from './farmAreas'
import { TURBINE } from './turbine/spec'
import { farmDynamics, lifeScale } from './turbine/dynamics'

// Imperative camera API shared by the rig, pointer interaction and UI. Every view stays inside the
// map's data: what the screen shows of the ground lies within the domain, so nothing on screen is
// anything but the live data the scene is built from.

/** Below this altitude (km) the view may run out to the hazy horizon; the camera stays inside. */
const LOW_ALTITUDE = 3
/** How far inside the domain's edge a low camera must stay, km. */
const LOW_MARGIN = 30
const SCREEN_SAMPLES = [-1, 0, 1].flatMap((x) => [-1, 0, 1].map((y) => new THREE.Vector2(x, y)))
const scratchRay = new THREE.Vector3()
const scratchHit = new THREE.Vector3()

const insideDomain = (x: number, z: number, margin = 0) =>
  x >= WORLD.minX + margin && x <= WORLD.maxX - margin && z >= WORLD.minZ + margin && z <= WORLD.maxZ - margin

/** Whether all the ground this camera shows lies inside the domain. */
export function viewInsideDomain(camera: THREE.PerspectiveCamera): boolean {
  const p = camera.position
  if (p.y < LOW_ALTITUDE) return insideDomain(p.x, p.z, LOW_MARGIN)
  camera.updateMatrixWorld()
  for (const s of SCREEN_SAMPLES) {
    const d = scratchRay.set(s.x, s.y, 0.5).unproject(camera).sub(p).normalize()
    // From altitude the horizon is beyond the map: no sky in view.
    if (d.y >= -1e-3) return false
    scratchHit.copy(p).addScaledVector(d, -p.y / d.y)
    if (!insideDomain(scratchHit.x, scratchHit.z)) return false
  }
  return true
}

/** The middle of the main island. */
const ISLAND = lonLatToWorld(120.98, 23.62)
/** Overview tilt from straight down, from the south, north up the screen. */
const OVERVIEW_TILT = THREE.MathUtils.degToRad(10)
const fitCamera = new THREE.PerspectiveCamera()

/** The island-wide view for a screen shape, north up, as far out as the domain allows. */
export function overviewPose(camera: THREE.PerspectiveCamera): { position: THREE.Vector3; target: THREE.Vector3 } {
  const target = new THREE.Vector3(ISLAND[0], 0, ISLAND[1])
  const dir = new THREE.Vector3(0, Math.cos(OVERVIEW_TILT), Math.sin(OVERVIEW_TILT))
  fitCamera.copy(camera)
  let lo = 10
  let hi = 1000
  for (let k = 0; k < 24; k++) {
    const d = (lo + hi) / 2
    fitCamera.position.copy(target).addScaledVector(dir, d)
    fitCamera.lookAt(target)
    if (viewInsideDomain(fitCamera)) lo = d
    else hi = d
  }
  return { position: target.clone().addScaledVector(dir, lo * 0.98), target }
}

let controlsInstance: CameraControls | null = null

export function registerControls(controls: CameraControls | null) {
  controlsInstance = controls
}

export function getControls(): CameraControls | null {
  return controlsInstance
}

// Scripted flights. Moving position and target independently would sweep the view toward the
// horizon halfway, out past the map. Instead the camera orbits its target: distance changes on a
// log scale, and the tilt follows the zoom, so the view only leans over once it is close and its
// footprint small. The rig advances the flight each frame (advanceFlight).

/** Flight time, seconds. */
const FLIGHT_S = 2.4

interface Orbit {
  target: THREE.Vector3
  radius: number
  polar: number
  azimuth: number
}

let flight: { from: Orbit; to: Orbit; t: number } | null = null

const toOrbit = (position: THREE.Vector3, target: THREE.Vector3): Orbit => {
  const s = new THREE.Spherical().setFromVector3(position.clone().sub(target))
  return { target: target.clone(), radius: s.radius, polar: s.phi, azimuth: s.theta }
}

const easeInOut = (x: number) => x * x * (3 - 2 * x)

/** Start a flight to a pose from wherever the camera is now. */
function flyTo(position: THREE.Vector3, target: THREE.Vector3) {
  const c = controlsInstance
  if (!c) return
  const from = toOrbit(c.camera.position, c.getTarget(new THREE.Vector3()))
  const to = toOrbit(position, target)
  // Turn the short way round.
  to.azimuth = from.azimuth + Math.atan2(Math.sin(to.azimuth - from.azimuth), Math.cos(to.azimuth - from.azimuth))
  flight = { from, to, t: 0 }
}

export const isFlying = () => flight !== null

/** The viewer took the controls: the flight gives way. */
export function cancelFlight() {
  flight = null
}

const scratchOffset = new THREE.Vector3()

/** Moves the camera along the current flight; call once per frame. */
export function advanceFlight(dt: number) {
  const c = controlsInstance
  if (!c || !flight) return
  const { from, to } = flight
  flight.t = Math.min(1, flight.t + dt / FLIGHT_S)
  const e = easeInOut(flight.t)
  const target = from.target.clone().lerp(to.target, e)
  const radius = Math.exp(THREE.MathUtils.lerp(Math.log(from.radius), Math.log(to.radius), e))
  // Tilt goes with zoom: lean over only as the camera closes in, straighten up first on the way out.
  const zoom = Math.abs(Math.log(to.radius / from.radius)) > 1e-3 ? (Math.log(radius) - Math.log(from.radius)) / Math.log(to.radius / from.radius) : e
  const lean = to.radius < from.radius ? zoom ** 2 : 1 - (1 - zoom) ** 2
  const polar = THREE.MathUtils.lerp(from.polar, to.polar, lean)
  const azimuth = THREE.MathUtils.lerp(from.azimuth, to.azimuth, e)
  scratchOffset.setFromSphericalCoords(radius, polar, azimuth)
  c.setLookAt(target.x + scratchOffset.x, target.y + scratchOffset.y, target.z + scratchOffset.z, target.x, target.y, target.z, false)
  if (flight.t >= 1) flight = null
}

/** Glide to a three-quarter view of a turbine's nacelle, from the side its rotor faces away from. */
export function flyToTurbine(index: number) {
  const t = TURBINES[index]
  playEffect('select')
  playEffect('fly')
  const yaw = farmDynamics.yaw[t.farm]
  // Down there turbines are drawn life size; distances are in model metres scaled to the machine.
  const s = lifeScale(t.farm)
  const hubY = TURBINE.hubHeight * s
  const angle = yaw + Math.PI * 0.62
  const r = 96 * s
  // Aim at the middle of the nacelle, a few metres behind the hub.
  const back = -6 * s
  flyTo(
    new THREE.Vector3(t.x + Math.sin(angle) * r, hubY + 34 * s, t.z + Math.cos(angle) * r),
    new THREE.Vector3(t.x + Math.sin(yaw) * back, hubY - 4.8 * s, t.z + Math.cos(yaw) * back),
  )
}

/** Oblique view over a whole wind farm, from the south-east so the coast sits behind it. */
export function flyToFarm({ center, radius }: FarmArea) {
  const r = radius * 1.6 + 1.5
  playEffect('fly')
  useStore.setState({ selected: null, hoveredFarm: null })
  flyTo(new THREE.Vector3(center[0] + r * 0.55, r * 0.55, center[1] + r * 0.8), new THREE.Vector3(center[0], 0, center[1]))
}

export function flyToOverview(animate: boolean) {
  const c = controlsInstance
  if (!c) return
  const { position: p, target: t } = overviewPose(c.camera as THREE.PerspectiveCamera)
  if (animate) {
    playEffect('fly')
    flyTo(p, t)
  } else {
    flight = null
    c.setLookAt(p.x, p.y, p.z, t.x, t.y, t.z, false)
  }
}

export function resetView() {
  useStore.setState({ selected: null })
  flyToOverview(true)
}
