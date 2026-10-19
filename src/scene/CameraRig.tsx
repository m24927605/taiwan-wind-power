import { CameraControls } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { WORLD } from '../geo/domain'
import { useStore } from '../state'
import { advanceFlight, cancelFlight, flyToOverview, isFlying, overviewPose, registerControls, viewInsideDomain } from './camera'

/** Within this distance (km) of the overview pose the camera counts as being at the overview. */
const OVERVIEW_TOLERANCE = 40

export function CameraRig() {
  const ref = useRef<CameraControls>(null)
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
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

  // Keep depth precision across a 1000x zoom range by tying the near plane to altitude.
  useFrame(() => {
    const elevation = useStore.getState().elevation
    const ground = elevation ? Math.max(0, elevation.heightAt(camera.position.x, camera.position.z) / 1000) : 0
    const altitude = Math.max(camera.position.y - ground, 0.01)
    const near = THREE.MathUtils.clamp(altitude * 0.05, 0.004, 5)
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
      maxPolarAngle={Math.PI * 0.47}
      dollyToCursor
      smoothTime={0.35}
      draggingSmoothTime={0.12}
    />
  )
}
