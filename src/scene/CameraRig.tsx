import { CameraControls } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { WORLD } from '../geo/domain'
import { useStore } from '../state'
import { advanceFlight, cancelFlight, flyToOverview, isFlying, overviewPose, registerControls, viewInsideDomain } from './camera'

/** Within this distance (km) of the overview pose the camera counts as being at the overview. */
const OVERVIEW_TOLERANCE = 40
/** Below this altitude (km), zooming in also tips the view down toward the waves nearby. */
const SEA_VIEW_BELOW = 0.2
/** How far down the view tips, radians below the horizon: the pitch a farm view arrives at. */
const SEA_VIEW_PITCH = THREE.MathUtils.degToRad(-30)
/** Tip per wheel notch (100 px of scroll), radians. */
const SEA_VIEW_STEP = THREE.MathUtils.degToRad(4)

export function CameraRig() {
  const ref = useRef<CameraControls>(null)
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const canvas = useThree((s) => s.gl.domElement)
  // The last pose whose view lay inside the domain.
  const valid = useRef({ position: new THREE.Vector3(), target: new THREE.Vector3(), set: false })
  const overview = useRef({ aspect: 0, position: new THREE.Vector3() })

  useEffect(() => {
    const c = ref.current
    if (!c) return
    registerControls(c)
    flyToOverview(false)
    c.setBoundary(new THREE.Box3(new THREE.Vector3(WORLD.minX, -1, WORLD.minZ), new THREE.Vector3(WORLD.maxX, 10, WORLD.maxZ)))
    c.addEventListener('controlstart', cancelFlight)
    return () => {
      c.removeEventListener('controlstart', cancelFlight)
      registerControls(null)
    }
  }, [])

  // Zooming in on the sea ends looking down at the waves, as a descent over a farm does, rather
  // than out at the horizon a turbine view faces, where the sky's reflection washes them out. The
  // view turns in place, after the controls have taken the same wheel event.
  useEffect(() => {
    const position = new THREE.Vector3()
    const target = new THREE.Vector3()
    const onWheel = (e: WheelEvent) => {
      const c = ref.current
      if (!c || e.deltaY >= 0 || isFlying()) return
      c.getPosition(position)
      if (position.y > SEA_VIEW_BELOW) return
      const view = c.getTarget(target).sub(position)
      const distance = view.length()
      const pitch = Math.asin(view.y / distance)
      if (pitch <= SEA_VIEW_PITCH) return
      const tipped = Math.max(SEA_VIEW_PITCH, pitch + (SEA_VIEW_STEP * e.deltaY) / 100)
      const level = Math.hypot(view.x, view.z)
      view.set((view.x / level) * Math.cos(tipped), Math.sin(tipped), (view.z / level) * Math.cos(tipped)).multiplyScalar(distance)
      c.setTarget(position.x + view.x, position.y + view.y, position.z + view.z, true)
    }
    canvas.addEventListener('wheel', onWheel, { passive: true })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [canvas])

  // Nothing can steer the view past the map's data: a pose that would show ground outside the
  // domain snaps back to the last one that did not. Scripted flights keep inside by their path.
  useFrame((_, dt) => {
    const c = ref.current
    if (!c) return
    advanceFlight(Math.min(dt, 0.1))
    const v = valid.current
    if (viewInsideDomain(camera)) {
      v.position.copy(camera.position)
      c.getTarget(v.target)
      v.set = true
    } else if (!isFlying() && v.set) {
      c.setLookAt(v.position.x, v.position.y, v.position.z, v.target.x, v.target.y, v.target.z, false)
    }
  })

  // Keep depth precision across a 1000x zoom range by tying the near plane to altitude. Close in it
  // stays a twentieth of the height, clear of a turbine's sweeping blades; from altitude everything
  // lies at least that far below, so it grows to four tenths. Land sits only 4 m above the sea, and
  // from 600 km up a near plane of a few kilometres resolves depth no finer than that.
  useFrame(() => {
    const elevation = useStore.getState().elevation
    const ground = elevation ? Math.max(0, elevation.heightAt(camera.position.x, camera.position.z) / 1000) : 0
    const altitude = Math.max(camera.position.y - ground, 0.01)
    const share = THREE.MathUtils.lerp(0.05, 0.4, THREE.MathUtils.smoothstep(Math.log(altitude), Math.log(2), Math.log(50)))
    const near = THREE.MathUtils.clamp(altitude * share, 0.004, 400)
    if (Math.abs(near - camera.near) / camera.near > 0.1) {
      camera.near = near
      camera.updateProjectionMatrix()
    }
    const o = overview.current
    if (o.aspect !== camera.aspect) {
      o.aspect = camera.aspect
      o.position.copy(overviewPose(camera).position)
    }
    const atOverview = camera.position.distanceTo(o.position) < OVERVIEW_TOLERANCE
    if (atOverview !== useStore.getState().atOverview) useStore.setState({ atOverview })
  })

  return (
    <CameraControls
      ref={ref}
      makeDefault
      minDistance={0.06}
      maxDistance={650}
      dollyToCursor
      // At the closest distance the wheel carries the target on toward the cursor, so the view can
      // go on down from a nacelle to the waves instead of stopping 60 m short of what it orbits.
      infinityDolly
      smoothTime={0.35}
      draggingSmoothTime={0.12}
    />
  )
}
