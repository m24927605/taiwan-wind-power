import { Html, Line } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import type { Line2 } from 'three/examples/jsm/lines/Line2.js'
import { WIND_FARMS } from '../data/windfarms'
import { useStore } from '../state'
import { flyToFarm } from './camera'
import { AREA_LIFT, FARM_AREAS } from './farmAreas'

const COLOR = '#ffd27a'
/** Outlines fade out as the camera moves in among the turbines (km from the farm edge). */
const FADE_NEAR = 2
const FADE_FAR = 10
const DECLUTTER_EVERY = 6

const scratch = new THREE.Vector3()

/** Outlines and labels that locate the wind farms from the overview, where turbines are specks. */
export function FarmBounds() {
  const bounds = FARM_AREAS
  const lines = useRef<(Line2 | null)[]>([])
  const fills = useRef<(THREE.Mesh | null)[]>([])
  const labels = useRef<(HTMLDivElement | null)[]>([])
  const frame = useRef(0)
  // Larger farms win label collisions.
  const priority = useMemo(() => bounds.map((_, i) => i).sort((a, b) => bounds[b].capacity - bounds[a].capacity), [bounds])

  useFrame(({ camera, size }) => {
    const fade = bounds.map((b) => {
      const d = Math.hypot(camera.position.x - b.center[0], camera.position.y, camera.position.z - b.center[1]) - b.radius
      return THREE.MathUtils.smoothstep(d, FADE_NEAR, FADE_FAR)
    })
    const { hoveredFarm } = useStore.getState()
    fade.forEach((k, i) => {
      const hot = i === hoveredFarm
      const line = lines.current[i]
      if (line) line.material.opacity = (hot ? 1 : 0.85) * k
      const fill = fills.current[i]
      if (fill) (fill.material as THREE.MeshBasicMaterial).opacity = (hot ? 0.14 : 0.035) * k
      labels.current[i]?.classList.toggle('is-hot', hot)
    })

    if (frame.current++ % DECLUTTER_EVERY !== 0) return
    const placed: [number, number, number, number][] = []
    for (const i of priority) {
      const el = labels.current[i]
      if (!el) continue
      const b = bounds[i]
      scratch.set(...b.anchor).project(camera)
      const x = (scratch.x * 0.5 + 0.5) * size.width
      const y = (-scratch.y * 0.5 + 0.5) * size.height
      const w = el.offsetWidth
      const h = el.offsetHeight
      // Matches the CSS: the label sits left of the anchor, vertically centred on it.
      const rect: [number, number, number, number] = [x - w, y - h / 2, x, y + h / 2]
      const onScreen = scratch.z < 1 && rect[2] > 0 && rect[0] < size.width && rect[3] > 0 && rect[1] < size.height
      const free = placed.every((p) => rect[2] < p[0] || rect[0] > p[2] || rect[3] < p[1] || rect[1] > p[3])
      const show = onScreen && free && fade[i] > 0.5
      if (show) placed.push(rect)
      el.classList.toggle('is-hidden', !show)
    }
  })

  return (
    <group name="farm-bounds">
      {bounds.map((b, i) => (
        <group key={WIND_FARMS[i].id}>
          <Line
            ref={(l) => {
              lines.current[i] = l as Line2 | null
            }}
            points={b.corners}
            color={COLOR}
            lineWidth={1.5}
            transparent
            depthWrite={false}
          />
          <mesh
            ref={(m) => {
              fills.current[i] = m
            }}
            position={[b.center[0], AREA_LIFT * 0.5, b.center[1]]}
            rotation={[-Math.PI / 2, 0, b.angle]}
          >
            <planeGeometry args={[b.width, b.depth]} />
            <meshBasicMaterial color={COLOR} transparent depthWrite={false} toneMapped={false} />
          </mesh>
          {/* Only the label button takes the pointer; its wrapper would shadow the canvas. */}
          <Html position={b.anchor} zIndexRange={[9, 0]} style={{ pointerEvents: 'none' }}>
            <div
              ref={(el) => {
                labels.current[i] = el
              }}
              className="farm-label is-hidden"
            >
              <button
                onClick={() => flyToFarm(b)}
                onPointerEnter={() => useStore.setState({ hoveredFarm: i })}
                onPointerLeave={() => useStore.setState({ hoveredFarm: null })}
              >
                <b>{WIND_FARMS[i].name}</b>
                <span>
                  {WIND_FARMS[i].turbines} 座 · {Math.round(b.capacity)} MW
                </span>
              </button>
            </div>
          </Html>
        </group>
      ))}
    </group>
  )
}
