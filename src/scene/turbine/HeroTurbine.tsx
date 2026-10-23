import { Html } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import * as THREE from 'three'
import { TURBINES } from '../../data/windfarms'
import { useStore } from '../../state'
import { PartCard } from '../../ui/PartCard'
import { PARTS } from './parts'
import { TURBINE } from './spec'
import { farmDynamics, turbineScale, turbineSpin } from './dynamics'
import { useTurbineModel } from './useTurbineModel'
import { turbineMaterial } from './weathering'
import { useT } from '../../i18n'

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
  const [openPart, setOpenPart] = useState<string | null>(null)
  const t = useT()

  const materials = useMemo(() => {
    const plane = new THREE.Plane()
    const paint = turbineMaterial(false)
    const rotor = turbineMaterial(true)
    const shell = turbineMaterial(false, { side: THREE.DoubleSide, clippingPlanes: [plane], clipShadows: true })
    return { plane, paint, rotor, shell }
  }, [])

  useEffect(
    () => () => {
      materials.paint.dispose()
      materials.rotor.dispose()
      materials.shell.dispose()
    },
    [materials],
  )

  const scratch = useMemo(() => ({ n: new THREE.Vector3(), p: new THREE.Vector3(), local: new THREE.Vector3() }), [])

  useFrame(({ camera }, dt) => {
    const g = group.current
    if (!g || !rotor.current) return
    g.rotation.y = farmDynamics.yaw[turbine.farm]
    const scale = turbineScale(turbine.farm)
    g.scale.setScalar(scale)
    rotor.current.rotation.z = -turbineSpin(turbine)
    progress.current = Math.min(1, progress.current + dt / CUT_SECONDS)
    const ease = 1 - Math.pow(1 - progress.current, 3)
    // Part labels only make sense while the nacelle fills a good part of the view (within 640 m of model).
    const near = camera.position.distanceTo(g.position) < 640 * scale
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
    <group ref={group} position={[turbine.x, 0, turbine.z]} scale={turbineScale(turbine.farm)}>
      <mesh geometry={hero.tower} material={materials.paint} castShadow receiveShadow />
      <mesh geometry={hero.shell} material={materials.shell} castShadow receiveShadow />
      <mesh geometry={hero.internals} material={materials.paint} castShadow receiveShadow />
      <mesh
        ref={rotor}
        geometry={hero.rotor}
        material={materials.rotor}
        position={[0, TURBINE.hubHeight, TURBINE.hubOffsetZ]}
        castShadow
        receiveShadow
      />
      {labels &&
        PARTS.map((part) => (
          <Html
            key={part.id}
            position={part.at}
            center={false}
            zIndexRange={openPart === part.id ? [21, 21] : [20, 0]}
            className="part-label-anchor"
          >
            <div
              className={`part-label${openPart === part.id ? ' is-open' : ''}`}
              style={{ '--lift': `${part.lift}px` } as CSSProperties}
            >
              <span className="part-label__dot" />
              <span className="part-label__line" />
              <button className="part-label__text" onClick={() => setOpenPart(openPart === part.id ? null : part.id)}>
                <b>{part.text[t.lang].name}</b>
                {t.lang === 'zh' && <i>{part.text.en.name}</i>}
              </button>
              {openPart === part.id && <PartCard part={part} turbine={turbine} onClose={() => setOpenPart(null)} />}
            </div>
          </Html>
        ))}
    </group>
  )
}
