import { Html, Line } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import type { Line2 } from 'three/examples/jsm/lines/Line2.js'
import { WIND_FARMS } from '../data/windfarms'
import { useT } from '../i18n'
import { useStore } from '../state'
import { panelRects } from '../ui/panels'
import { flyToFarm } from './camera'
import { AREA_LIFT, FARM_AREAS } from './farmAreas'

const COLOR = '#ffd27a'
/** Outlines fade out as the camera moves in among the turbines (km from the farm edge). */
const FADE_NEAR = 2
const FADE_FAR = 10
/**
 * And as it comes down toward the sea (km altitude): seen edge-on from low over the water, the
 * far outlines would stack into one bright line along the coast.
 */
const FADE_LOW = 1.5
const FADE_HIGH = 6
const DECLUTTER_EVERY = 6
/** A label's clearance from the cards, px. */
const GAP = 8

const scratch = new THREE.Vector3()

/** Outlines and labels that locate the wind farms from the overview, where turbines are specks. */
export function FarmBounds() {
  const bounds = FARM_AREAS
  const t = useT()
  const lines = useRef<(Line2 | null)[]>([])
  const fills = useRef<(THREE.Mesh | null)[]>([])
  const labels = useRef<(HTMLDivElement | null)[]>([])
  const frame = useRef(0)
  // Larger farms win label collisions.
  const priority = useMemo(() => bounds.map((_, i) => i).sort((a, b) => bounds[b].capacity - bounds[a].capacity), [bounds])

  useFrame(({ camera, size }) => {
    const height = THREE.MathUtils.smoothstep(camera.position.y, FADE_LOW, FADE_HIGH)
    const fade = bounds.map((b) => {
      const d = Math.hypot(camera.position.x - b.center[0], camera.position.y, camera.position.z - b.center[1]) - b.radius
      return THREE.MathUtils.smoothstep(d, FADE_NEAR, FADE_FAR) * height
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
    type Rect = [number, number, number, number]
    const cards: Rect[] = panelRects().map((r) => [r.left - GAP, r.top - GAP, r.right + GAP, r.bottom + GAP])
    const placed: Rect[] = []
    const onScreen = (r: Rect) => r[2] > 0 && r[0] < size.width && r[3] > 0 && r[1] < size.height
    const clear = (r: Rect, of: Rect[]) => of.every((p) => r[2] < p[0] || r[0] > p[2] || r[3] < p[1] || r[1] > p[3])
    const toScreen = (p: [number, number, number]) => {
      scratch.set(...p).project(camera)
      return [(scratch.x * 0.5 + 0.5) * size.width, (-scratch.y * 0.5 + 0.5) * size.height, scratch.z] as const
    }
    // Each farm's outline on screen: a label moved east must not cover a neighbour's.
    const areas: Rect[] = bounds.map((b) => {
      const pts = b.corners.map(toScreen)
      return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))]
    })
    for (const i of priority) {
      const el = labels.current[i]
      if (!el) continue
      const b = bounds[i]
      const [x, y, z] = toScreen(b.anchor)
      const [ex, ey] = toScreen(b.east)
      const w = el.offsetWidth
      const h = el.offsetHeight
      // Matches the CSS: the label sits left of the western corner, vertically centred on it. Where
      // a card covers that, it goes right of the eastern corner instead, clear of the other farms;
      // where a larger farm's label is in the way, it is left out.
      const left: Rect = [x - w, y - h / 2, x, y + h / 2]
      const right: Rect = [ex, ey - h / 2, ex + w, ey + h / 2]
      const fits = (r: Rect) => onScreen(r) && clear(r, cards) && clear(r, placed)
      const fitsEast = fits(right) && clear(right, areas.filter((_, j) => j !== i))
      const rect = z >= 1 || fade[i] <= 0.5 ? null : fits(left) ? left : !clear(left, cards) && fitsEast ? right : null
      if (rect) placed.push(rect)
      el.classList.toggle('is-hidden', !rect)
      el.classList.toggle('is-right', rect === right)
      el.style.translate = rect === right ? `${ex - x}px ${ey - y}px` : ''
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
                <b>{t.lang === 'zh' ? WIND_FARMS[i].name : WIND_FARMS[i].nameEn}</b>
                <span>{t.farmLabel(WIND_FARMS[i].turbines, Math.round(b.capacity))}</span>
              </button>
            </div>
          </Html>
        </group>
      ))}
    </group>
  )
}
