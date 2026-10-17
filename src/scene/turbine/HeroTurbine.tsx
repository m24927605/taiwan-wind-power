import { Html } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import * as THREE from 'three'
import { TURBINES } from '../../data/windfarms'
import { useStore } from '../../state'
import { TURBINE } from './spec'
import { TURBINE_SCALE, farmDynamics } from './dynamics'
import { useTurbineModel } from './useTurbineModel'

// Label anchors in model metres, matching the parts laid out in scripts/build-turbine.ts.
// `lift` staggers the leader lines (px) so neighbouring labels never overlap.
const PARTS: { name: string; en: string; at: [number, number, number]; lift: number }[] = [
  { name: '主軸承', en: 'Main bearing', at: [0, 113.8, 4], lift: 34 },
  { name: '齒輪箱', en: 'Gearbox', at: [0, 114.2, -2.6], lift: 92 },
  { name: '發電機', en: 'Generator', at: [0, 114.6, -8.6], lift: 54 },
  { name: '變流器', en: 'Converter', at: [3.3, 113.2, -12], lift: 120 },
  { name: '偏航系統', en: 'Yaw drive', at: [0, 108.6, -2], lift: 14 },
]

const CUT_SECONDS = 1.6

export function HeroTurbine() {
  const selected = useStore((s) => s.selected)
  return selected === null ? null : <Hero key={selected} index={selected} />
}

function Hero({ index }: { index: number }) {
  const { hero } = useTurbineModel()
  const turbine = TURBINES[index]
  const group = useRef<THREE.Group>(null)
  const rotor = useRef<THREE.Mesh>(null)
  const progress = useRef(0)
  const [labels, setLabels] = useState(false)

  const materials = useMemo(() => {
    const plane = new THREE.Plane()
    const paint = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.05 })
    const shell = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.42,
      metalness: 0.05,
      side: THREE.DoubleSide,
      clippingPlanes: [plane],
    })
    const machinery = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.6, clippingPlanes: [] })
    return { plane, paint, shell, machinery }
  }, [])

  useEffect(
    () => () => {
      materials.paint.dispose()
      materials.shell.dispose()
      materials.machinery.dispose()
    },
    [materials],
  )

  const scratch = useMemo(() => ({ n: new THREE.Vector3(), p: new THREE.Vector3(), local: new THREE.Vector3() }), [])

  useFrame(({ camera }, dt) => {
    const g = group.current
    if (!g || !rotor.current) return
    g.rotation.y = farmDynamics.yaw[turbine.farm]
    rotor.current.rotation.z = -(farmDynamics.spin[turbine.farm] + turbine.phase)
    progress.current = Math.min(1, progress.current + dt / CUT_SECONDS)
    const ease = 1 - Math.pow(1 - progress.current, 3)
    // Part labels only make sense while the nacelle fills a good part of the view.
    const near = camera.position.distanceTo(g.position) < 1.6
    const show = progress.current > 0.6 && near
    if (show !== labels) setLabels(show)

    // Cut away the half of the nacelle facing the camera, sweeping in from its outer skin.
    g.updateMatrixWorld()
    scratch.local.copy(camera.position)
    g.worldToLocal(scratch.local)
    const side = scratch.local.x >= 0 ? 1 : -1
    const offset = (1 - ease) * 6
    scratch.n.set(-side, 0, 0).transformDirection(g.matrixWorld)
    scratch.p.set(side * offset, 0, 0).applyMatrix4(g.matrixWorld)
    materials.plane.setFromNormalAndCoplanarPoint(scratch.n, scratch.p)
  })

  return (
    <group ref={group} position={[turbine.x, 0, turbine.z]} scale={TURBINE_SCALE}>
      <mesh geometry={hero.tower} material={materials.paint} />
      <mesh geometry={hero.shell} material={materials.shell} />
      <mesh geometry={hero.internals} material={materials.machinery} />
      <mesh ref={rotor} geometry={hero.rotor} material={materials.paint} position={[0, TURBINE.hubHeight, TURBINE.hubOffsetZ]} />
      {labels &&
        PARTS.map((part) => (
          <Html key={part.name} position={part.at} center={false} zIndexRange={[20, 0]} className="part-label-anchor">
            <div className="part-label" style={{ '--lift': `${part.lift}px` } as CSSProperties}>
              <span className="part-label__dot" />
              <span className="part-label__line" />
              <span className="part-label__text">
                <b>{part.name}</b>
                <i>{part.en}</i>
              </span>
            </div>
          </Html>
        ))}
    </group>
  )
}
