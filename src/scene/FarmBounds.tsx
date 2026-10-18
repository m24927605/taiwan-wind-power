import { Html, Line } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import type { Line2 } from 'three/examples/jsm/lines/Line2.js'
import { TURBINES, WIND_FARMS } from '../data/windfarms'
import { flyToFarm } from './camera'

/** Margin around the outermost turbines, km. */
const PADDING = 0.8
const LIFT = 0.03
const COLOR = '#ffd27a'
/** Outlines fade out as the camera moves in among the turbines (km from the farm edge). */
const FADE_NEAR = 2
const FADE_FAR = 10
const DECLUTTER_EVERY = 6

interface Bounds {
  center: [x: number, z: number]
  /** Westernmost corner: labels hang off it into the open strait. */
  anchor: [number, number, number]
  corners: [number, number, number][]
  width: number
  depth: number
  angle: number
  radius: number
  capacity: number
}

/** Rectangle aligned with each farm's array heading, around its turbines plus a margin. */
function farmBounds(): Bounds[] {
  return WIND_FARMS.map((farm, f) => {
    const h = (farm.heading * Math.PI) / 180
    const along = [Math.sin(h), -Math.cos(h)]
    const across = [Math.cos(h), Math.sin(h)]
    let a0 = Infinity
    let a1 = -Infinity
    let b0 = Infinity
    let b1 = -Infinity
    for (const t of TURBINES) {
      if (t.farm !== f) continue
      const a = t.x * along[0] + t.z * along[1]
      const b = t.x * across[0] + t.z * across[1]
      a0 = Math.min(a0, a - PADDING)
      a1 = Math.max(a1, a + PADDING)
      b0 = Math.min(b0, b - PADDING)
      b1 = Math.max(b1, b + PADDING)
    }
    const point = (a: number, b: number): [number, number, number] => [
      along[0] * a + across[0] * b,
      LIFT,
      along[1] * a + across[1] * b,
    ]
    const corners = [point(a0, b0), point(a1, b0), point(a1, b1), point(a0, b1), point(a0, b0)]
    const c = point((a0 + a1) / 2, (b0 + b1) / 2)
    const anchor = corners.slice(0, 4).reduce((w, p) => (p[0] < w[0] ? p : w))
    return {
      center: [c[0], c[2]],
      anchor,
      corners,
      width: b1 - b0,
      depth: a1 - a0,
      angle: -h,
      radius: Math.hypot(a1 - a0, b1 - b0) / 2,
      capacity: farm.turbines * farm.ratedMW,
    }
  })
}

const scratch = new THREE.Vector3()

/** Outlines and labels that locate the wind farms from the overview, where turbines are specks. */
export function FarmBounds() {
  const bounds = useMemo(farmBounds, [])
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
    fade.forEach((k, i) => {
      const line = lines.current[i]
      if (line) line.material.opacity = 0.85 * k
      const fill = fills.current[i]
      if (fill) (fill.material as THREE.MeshBasicMaterial).opacity = 0.035 * k
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
            position={[b.center[0], LIFT * 0.5, b.center[1]]}
            rotation={[-Math.PI / 2, 0, b.angle]}
          >
            <planeGeometry args={[b.width, b.depth]} />
            <meshBasicMaterial color={COLOR} transparent depthWrite={false} toneMapped={false} />
          </mesh>
          <Html position={b.anchor} zIndexRange={[15, 0]}>
            <div
              ref={(el) => {
                labels.current[i] = el
              }}
              className="farm-label is-hidden"
            >
              <button onClick={() => flyToFarm(b.center, b.radius)}>
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
