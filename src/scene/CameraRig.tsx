import { CameraControls } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { WORLD } from '../geo/domain'
import { useStore } from '../state'

export const OVERVIEW = {
  position: new THREE.Vector3(-120, 210, 250),
  target: new THREE.Vector3(5, 0, -5),
}

let controlsInstance: CameraControls | null = null

/** Imperative access for UI-driven flights (turbine focus, reset view). */
export function getControls(): CameraControls | null {
  return controlsInstance
}

export function CameraRig() {
  const ref = useRef<CameraControls>(null)
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera

  useEffect(() => {
    const c = ref.current
    if (!c) return
    controlsInstance = c
    c.setLookAt(...OVERVIEW.position.toArray(), ...OVERVIEW.target.toArray(), false)
    c.setBoundary(new THREE.Box3(new THREE.Vector3(WORLD.minX, -1, WORLD.minZ), new THREE.Vector3(WORLD.maxX, 10, WORLD.maxZ)))
    return () => {
      controlsInstance = null
    }
  }, [])

  // Keep depth precision across a 1000x zoom range by tying the near plane to altitude.
  useFrame(() => {
    const elevation = useStore.getState().elevation
    const ground = elevation ? Math.max(0, elevation.heightAt(camera.position.x, camera.position.z) * 0.0025) : 0
    const altitude = Math.max(camera.position.y - ground, 0.01)
    const near = THREE.MathUtils.clamp(altitude * 0.05, 0.004, 5)
    if (Math.abs(near - camera.near) / camera.near > 0.1) {
      camera.near = near
      camera.updateProjectionMatrix()
    }
  })

  return (
    <CameraControls
      ref={ref}
      makeDefault
      minDistance={0.25}
      maxDistance={650}
      maxPolarAngle={Math.PI * 0.47}
      dollyToCursor
      smoothTime={0.35}
      draggingSmoothTime={0.12}
    />
  )
}
