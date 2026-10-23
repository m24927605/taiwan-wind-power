import { CameraControls } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { WORLD } from '../geo/domain'
import { useStore } from '../state'
import { advanceFlight, cancelFlight, floorAt, flyToOverview, isFlying, overviewPose, registerControls, viewInsideDomain } from './camera'

/** Within this distance (km) of the overview pose the camera counts as being at the overview. */
const OVERVIEW_TOLERANCE = 40
/** Below this altitude (km), zooming in also tips the view down toward the waves nearby. */
const SEA_VIEW_BELOW = 0.2
/** How far down the view tips, radians below the horizon: the pitch a farm view arrives at. */
const SEA_VIEW_PITCH = THREE.MathUtils.degToRad(-30)
/** Tip per wheel notch (100 px of scroll), radians. */
const SEA_VIEW_STEP = THREE.MathUtils.degToRad(4)
/** Down there the wheel closes on a point one altitude ahead, so each notch covers a share of it. */
const SEA_DOLLY_PIVOT = 1
/** A drag down there turns the view about a point this close ahead of the eye, km. */
const SEA_LOOK_PIVOT = 0.001
/** ...and at this share of the orbiting speed, which would swing a look around too fast. */
const SEA_LOOK_SPEED = 0.35

export function CameraRig() {
  const ref = useRef<CameraControls>(null)
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const canvas = useThree((s) => s.gl.domElement)
  // The last pose whose view lay inside the domain.
  const valid = useRef({ position: new THREE.Vector3(), target: new THREE.Vector3(), set: false })
  const overview = useRef({ aspect: 0, position: new THREE.Vector3() })
  const lifted = useMemo(() => new THREE.Vector3(), [])

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

  // Low over the sea the controls orbit a point ahead of the eye that the rig moves before each
  // gesture, in the capture phase so the controls act about it. A drag turns the view about a point
  // a metre ahead, which is looking around: about one farther off, below the sea, raising the view
  // would carry the eye under the surface, so it could not look up. The wheel closes on a point one
  // altitude ahead, and zooming in also tips the view down to the waves nearby, where a descent over
  // a farm arrives, rather than out at the horizon a turbine view faces, where the sky's reflection
  // washes them out.
  useEffect(() => {
    const position = new THREE.Vector3()
    const target = new THREE.Vector3()
    const pivot = (distance: number, pitch?: number, smooth = false) => {
      const c = ref.current!
      const view = c.getTarget(target).sub(position)
      const level = Math.hypot(view.x, view.z)
      const p = pitch ?? Math.asin(view.y / view.length())
      view.set((view.x / level) * Math.cos(p), Math.sin(p), (view.z / level) * Math.cos(p)).multiplyScalar(distance)
      c.setTarget(position.x + view.x, position.y + view.y, position.z + view.z, smooth)
    }
    const low = () => {
      const c = ref.current
      if (!c || isFlying()) return false
      c.getPosition(position)
      return position.y <= SEA_VIEW_BELOW
    }
    const onPointerDown = () => {
      const c = ref.current
      if (!c) return
      const looking = low()
      if (looking) pivot(SEA_LOOK_PIVOT)
      c.azimuthRotateSpeed = c.polarRotateSpeed = looking ? SEA_LOOK_SPEED : 1
    }
    const onWheel = (e: WheelEvent) => {
      if (!low()) return
      const view = ref.current!.getTarget(target).sub(position)
      const pitch = Math.asin(view.y / view.length())
      const tipped = e.deltaY >= 0 || pitch <= SEA_VIEW_PITCH ? pitch : Math.max(SEA_VIEW_PITCH, pitch + (SEA_VIEW_STEP * e.deltaY) / 100)
      pivot(position.y * SEA_DOLLY_PIVOT, tipped, true)
    }
    canvas.addEventListener('pointerdown', onPointerDown, { capture: true })
    canvas.addEventListener('wheel', onWheel, { capture: true, passive: true })
    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown, { capture: true })
      canvas.removeEventListener('wheel', onWheel, { capture: true })
    }
  }, [canvas])

  // Nothing can steer the view past the map's data: a pose that would show ground outside the
  // domain snaps back to the last one that did not. Scripted flights keep inside by their path.
  useFrame((_, dt) => {
    const c = ref.current
    if (!c) return
    advanceFlight(Math.min(dt, 0.1))
    // An eye that sinks below the floor is lifted back onto it with what it looks at, so it keeps
    // looking the same way: turning about a point just ahead of it (see above) dips it a little, and
    // a pose refused for that would leave a view down on the waves unable to look up.
    const p = camera.position
    const floor = floorAt(p.x, p.z)
    if (p.y < floor && !isFlying()) {
      // Moving the target carries the eye with it and leaves a turn in progress running.
      const t = c.getTarget(lifted, false)
      // A millimetre over, so rounding cannot leave it under and the pose be refused.
      c.moveTo(t.x, t.y + floor - p.y + 1e-6, t.z, false)
      c.update(0)
    }
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
      // A metre, so a drag low over the sea can turn about a point just ahead of the eye (see above).
      minDistance={0.001}
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
