import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { TURBINES } from '../data/windfarms'
import { useStore } from '../state'
import { flyToFarm, flyToTurbine } from './camera'
import { FARM_AREAS, pickFarm } from './farmAreas'
import { pickGround, pickTurbine } from './picking'

const CLICK_SLOP_PX = 6

/** Pointer handling for hover, farm and turbine selection, and the measuring tool. */
export function Interaction() {
  const gl = useThree((s) => s.gl)
  const camera = useThree((s) => s.camera)
  const pointer = useRef<{ x: number; y: number } | null>(null)
  const down = useRef<{ x: number; y: number } | null>(null)
  const raycaster = useRef(new THREE.Raycaster())

  useEffect(() => {
    const el = gl.domElement
    const ndc = (e: PointerEvent) => {
      const r = el.getBoundingClientRect()
      return { x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -((e.clientY - r.top) / r.height) * 2 + 1 }
    }
    const rayFrom = (p: { x: number; y: number }) => {
      raycaster.current.setFromCamera(new THREE.Vector2(p.x, p.y), camera)
      return raycaster.current.ray
    }
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') pointer.current = ndc(e)
    }
    const onLeave = () => {
      pointer.current = null
      useStore.setState({ hovered: null, hoveredFarm: null })
    }
    const onDown = (e: PointerEvent) => {
      down.current = { x: e.clientX, y: e.clientY }
    }
    const onUp = (e: PointerEvent) => {
      const start = down.current
      down.current = null
      if (!start || Math.hypot(e.clientX - start.x, e.clientY - start.y) > CLICK_SLOP_PX) return
      const ray = rayFrom(ndc(e))
      const { tool, elevation, measure } = useStore.getState()
      const hit = pickTurbine(ray)
      if (tool === 'measure') {
        const ground = hit !== null ? null : elevation && pickGround(ray, elevation)
        const point: [number, number] | null =
          hit !== null ? [TURBINES[hit].x, TURBINES[hit].z] : ground ? [ground.x, ground.z] : null
        if (point) useStore.setState({ measure: measure.length >= 2 ? [point] : [...measure, point] })
        return
      }
      // From afar a farm is picked as a whole; turbine capsules there span kilometres anyway.
      const farm = pickFarm(ray)
      if (farm !== null) {
        flyToFarm(FARM_AREAS[farm])
      } else if (hit !== null) {
        useStore.setState({ selected: hit })
        flyToTurbine(hit)
      } else {
        useStore.setState({ selected: null })
      }
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerleave', onLeave)
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointerup', onUp)
    return () => {
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerleave', onLeave)
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointerup', onUp)
    }
  }, [gl, camera])

  // Hover picking runs at most once per frame, and not while dragging the camera.
  useFrame(() => {
    if (!pointer.current || down.current) return
    raycaster.current.setFromCamera(new THREE.Vector2(pointer.current.x, pointer.current.y), camera)
    const ray = raycaster.current.ray
    const measuring = useStore.getState().tool === 'measure'
    const farm = measuring ? null : pickFarm(ray)
    const hit = farm === null ? pickTurbine(ray) : null
    const { hovered, hoveredFarm } = useStore.getState()
    if (hit !== hovered || farm !== hoveredFarm) {
      useStore.setState({ hovered: hit, hoveredFarm: farm })
      gl.domElement.style.cursor = hit !== null || farm !== null ? 'pointer' : ''
    }
  })

  return null
}
