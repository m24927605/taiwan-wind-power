import { CameraControls } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { WORLD } from '../geo/domain'
import { useStore } from '../state'
import { flyToOverview, overviewPosition, registerControls } from './camera'

/** Within this distance (km) of the overview pose the camera counts as being at the overview. */
const OVERVIEW_TOLERANCE = 40

export function CameraRig() {
  const ref = useRef<CameraControls>(null)
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera

  useEffect(() => {
    const c = ref.current
    if (!c) return
    registerControls(c)
    flyToOverview(false)
    c.setBoundary(new THREE.Box3(new THREE.Vector3(WORLD.minX, -1, WORLD.minZ), new THREE.Vector3(WORLD.maxX, 10, WORLD.maxZ)))
    return () => {
      registerControls(null)
    }
  }, [])

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
    const atOverview = camera.position.distanceTo(overviewPosition(camera.aspect)) < OVERVIEW_TOLERANCE
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
