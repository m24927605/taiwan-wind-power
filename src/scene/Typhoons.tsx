import { Html, Line } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import type { Line2 } from 'three/examples/jsm/lines/Line2.js'
import type { Cyclone, CycloneFix } from '../data/cwa'
import { cycloneAt } from '../data/weather'
import { lonLatToWorld } from '../geo/domain'
import { useT } from '../i18n'
import { useStore } from '../state'
import { panelRects } from '../ui/panels'
import { AREA_LIFT } from './farmAreas'

// Tropical cyclones as CWA tracks them: the path so far, the forecast path with the circles the
// centre falls within at 70 % probability, and, where the scene time falls on the track, the
// centre with its gale (15 m/s) and storm (25 m/s) radii. A map device like the farm outlines,
// drawn above the clouds (see Overlay) and shown only from high up.

const COLOR = '#ff8f7a'
/** Shown once the eye climbs from this altitude to the next, km: a typhoon spans hundreds of km. */
const FADE_LOW = 15
const FADE_HIGH = 60
const SEGMENTS = 96
/** Line opacities: the track, the forecast, the gale and storm radii, then the 70 % circles. */
const OPACITY = [0.9, 0.7, 0.9, 0.9]
const CONE_OPACITY = 0.35

/** A unit circle on the sea, to be scaled to a radius in km. */
const UNIT_CIRCLE = Array.from({ length: SEGMENTS + 1 }, (_, i): [number, number, number] => {
  const a = (i / SEGMENTS) * Math.PI * 2
  return [Math.cos(a), 0, Math.sin(a)]
})

const at = (f: CycloneFix): [number, number, number] => {
  const [x, z] = lonLatToWorld(f.lon, f.lat)
  return [x, AREA_LIFT, z]
}

/** A label's clearance from the cards, px. */
const GAP = 10

/**
 * Moves a label out from under the cards over the scene: to the left of a card if it stays on
 * screen there, otherwise above it, with a leader back to the centre. `shift` holds the offset
 * already applied, so the label is measured where it would sit unmoved.
 */
function clearOfPanels(el: HTMLElement, shift: { x: number; y: number }) {
  const r = el.getBoundingClientRect()
  const left = r.left - shift.x
  const top = r.top - shift.y
  let x = 0
  let y = 0
  for (const b of panelRects()) {
    const l = left + x
    const t = top + y
    if (l >= b.right + GAP || l + r.width <= b.left - GAP || t >= b.bottom + GAP || t + r.height <= b.top - GAP) continue
    if (b.left - GAP - r.width >= GAP) x = b.left - GAP - r.width - left
    else y = b.top - GAP - r.height - top
  }
  shift.x = x
  shift.y = y
  el.style.translate = `${x}px ${y}px`
  el.classList.toggle('is-shifted', x !== 0 || y !== 0)
  // The leader runs from the centre to the label's nearest edge.
  const len = Math.hypot(x, y)
  const inside = len && Math.min(Math.abs(r.width / 2 / (x || 1e-9)), Math.abs(r.height / 2 / (y || 1e-9))) * len
  el.style.setProperty('--leader-x', `${-x}px`)
  el.style.setProperty('--leader-y', `${-y}px`)
  el.style.setProperty('--leader-len', `${Math.max(0, len - inside)}px`)
  el.style.setProperty('--leader-angle', `${Math.atan2(y, x)}rad`)
}

/** One empty list, so the store selector returns the same value while there is no weather. */
const NONE: Cyclone[] = []

export function Typhoons() {
  const cyclones = useStore((s) => s.weather?.cyclones ?? NONE)
  return (
    <group name="typhoons">
      {cyclones.map((c) => (
        <Typhoon key={c.number} cyclone={c} />
      ))}
    </group>
  )
}

function Typhoon({ cyclone }: { cyclone: Cyclone }) {
  const t = useT()
  const { track, forecast, cone } = useMemo(() => {
    const last = cyclone.track.at(-1)
    const ahead = cyclone.forecast.filter((f) => !last || f.t > last.t)
    return {
      track: cyclone.track.map(at),
      forecast: [...(last ? [last] : []), ...ahead].map(at),
      cone: ahead
        .filter((f) => f.r70 !== null)
        .map((f) => {
          const [cx, , cz] = at(f)
          return UNIT_CIRCLE.map(([x, , z]): [number, number, number] => [cx + x * f.r70!, AREA_LIFT, cz + z * f.r70!])
        }),
    }
  }, [cyclone])

  const lines = useRef<(Line2 | null)[]>([])
  const centre = useRef<THREE.Group>(null)
  const gale = useRef<THREE.Group>(null)
  const storm = useRef<THREE.Group>(null)
  const label = useRef<HTMLDivElement>(null)
  const shift = useRef({ x: 0, y: 0 })
  const line = (i: number) => (l: unknown) => {
    lines.current[i] = l as Line2 | null
  }

  useFrame(({ camera }) => {
    const fade = THREE.MathUtils.smoothstep(camera.position.y, FADE_LOW, FADE_HIGH)
    lines.current.forEach((l, i) => {
      if (l) l.material.opacity = (OPACITY[i] ?? CONE_OPACITY) * fade
    })
    const now = cycloneAt(cyclone, useStore.getState().time)
    if (!centre.current || !gale.current || !storm.current || !label.current) return
    centre.current.visible = now !== null && fade > 0
    label.current.classList.toggle('is-hidden', now === null || fade < 0.5)
    if (!now) return
    clearOfPanels(label.current, shift.current)
    centre.current.position.set(...at(now))
    gale.current.visible = now.r15 !== null
    gale.current.scale.setScalar(now.r15 ?? 1)
    storm.current.visible = now.r25 !== null
    storm.current.scale.setScalar(now.r25 ?? 1)
    label.current.textContent = t.typhoon(t.lang === 'zh' ? cyclone.name : cyclone.nameEn, cyclone.number, Math.round(now.pressure), now.wind === null ? null : Math.round(now.wind))
  })

  return (
    <group>
      <Line ref={line(0)} points={track} color={COLOR} lineWidth={2} transparent depthWrite={false} />
      {forecast.length > 1 && <Line ref={line(1)} points={forecast} color={COLOR} lineWidth={2} dashed dashSize={12} gapSize={8} transparent depthWrite={false} />}
      {cone.map((points, i) => (
        <Line key={i} ref={line(OPACITY.length + i)} points={points} color={COLOR} lineWidth={1} transparent depthWrite={false} />
      ))}
      <group ref={centre} visible={false}>
        <group ref={gale}>
          <Line ref={line(2)} points={UNIT_CIRCLE} color={COLOR} lineWidth={1.5} transparent depthWrite={false} />
        </group>
        <group ref={storm}>
          <Line ref={line(3)} points={UNIT_CIRCLE} color={COLOR} lineWidth={2.5} transparent depthWrite={false} />
        </group>
        <Html zIndexRange={[9, 0]} style={{ pointerEvents: 'none' }}>
          <div ref={label} className="typhoon-label is-hidden" />
        </Html>
      </group>
    </group>
  )
}
