import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { SATELLITE_SIZE, initSatellite, satelliteAt, wantSatellite, type SatelliteFrame } from '../data/satellite'
import { windAt } from '../data/weather'
import { WIND_FARMS } from '../data/windfarms'
import { useStore } from '../state'
import { CloudPass } from './CloudPass'
import { CLOUD_BOTTOM, clouds, generateCloudNoise } from './clouds'
import { FARM_AREAS, nearFarm } from './farmAreas'

const COARSE_POINTER = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches
/** Scans kept on the GPU: the pair in use and the pair either side of a scrub. */
const MAX_TEXTURES = 4
/** The farm whose forecast stands for the strait's wind aloft. */
const REFERENCE_FARM = Math.floor(WIND_FARMS.length / 2)
/** Clouds drift with the wind at their own height, a little faster than at the hubs. */
const CLOUD_WIND_FACTOR = 1.3
/** How quickly the clouds part and close again, per second. */
const CLEAR_RATE = 8

/** Volumetric clouds over the scene, as the first post-processing pass; mount inside the composer. */
export function CloudLayer({ dpr }: { dpr: number }) {
  const gl = useThree((s) => s.gl)
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  // Soft clouds need about one ray per CSS pixel pair, whatever the device ratio.
  const divisor = (dpr > 1.25 ? 3 : 2) + (COARSE_POINTER ? 1 : 0)
  const pass = useMemo(() => new CloudPass(camera), [camera])
  useEffect(() => () => pass.dispose(), [pass])
  useEffect(() => {
    pass.divisor = divisor
  }, [pass, divisor])

  useEffect(() => {
    let cancelled = false
    let dispose: (() => void) | null = null
    generateCloudNoise(gl, () => cancelled).then((d) => {
      if (cancelled) d()
      else dispose = d
    })
    return () => {
      cancelled = true
      dispose?.()
    }
  }, [gl])

  // Himawari scans, loaded as scene time asks for them, as textures once they arrive.
  const elevation = useStore((s) => s.elevation)
  const textures = useMemo(() => new Map<SatelliteFrame, THREE.DataTexture>(), [])
  useEffect(() => {
    if (elevation) initSatellite(elevation)
  }, [elevation])
  useEffect(
    () => () => {
      for (const t of textures.values()) t.dispose()
      textures.clear()
    },
    [textures],
  )
  const texture = (frame: SatelliteFrame, keep: SatelliteFrame) => {
    let t = textures.get(frame)
    if (!t) {
      // Evict the oldest scan that is not part of the pair now in use.
      for (const [f, old] of textures) {
        if (textures.size < MAX_TEXTURES) break
        if (f === keep) continue
        old.dispose()
        textures.delete(f)
      }
      t = new THREE.DataTexture(frame.data, SATELLITE_SIZE, SATELLITE_SIZE)
      t.magFilter = t.minFilter = THREE.LinearFilter
      t.needsUpdate = true
      textures.set(frame, t)
    }
    return t
  }

  useFrame((_, dt) => {
    const { weather, time } = useStore.getState()
    if (!weather) return
    wantSatellite(time)
    const sat = satelliteAt(time)
    clouds.uSatWeight.value = sat ? 1 : 0
    if (sat) {
      clouds.uSatA.value = texture(sat.a, sat.b)
      clouds.uSatB.value = texture(sat.b, sat.a)
      clouds.uSatBlend.value = sat.blend
    }
    const wind = windAt(weather, REFERENCE_FARM, time)
    const step = wind.speed * CLOUD_WIND_FACTOR * 0.001 * Math.min(dt, 0.1)
    // Wind blows from fromRad; the cloud detail moves the other way (+x east, -z north).
    clouds.uCloudOffset.value.x -= Math.sin(wind.fromRad) * step
    clouds.uCloudOffset.value.y += Math.cos(wind.fromRad) * step
  })

  // The clouds part over the farm under the pointer, or the one the camera has come to, so its
  // turbines can be seen to be picked. Moving between farms, one closes before the next opens.
  const cleared = useRef<number | null>(null)
  const opening = useRef(0)
  useFrame((_, dt) => {
    const focus = useStore.getState().hoveredFarm ?? nearFarm(camera.position)
    if (focus !== cleared.current && opening.current < 0.02) cleared.current = focus
    const goal = focus !== null && focus === cleared.current ? 1 : 0
    opening.current += (goal - opening.current) * (1 - Math.exp(-Math.min(dt, 0.1) * CLEAR_RATE))
    if (cleared.current !== null) {
      const area = FARM_AREAS[cleared.current]
      clouds.uCloudClear.value.set(area.center[0], 0, area.center[1], area.radius)
    }
    // From below the cloud base the eye already sees the sea, and the sky above stays overcast.
    clouds.uCloudClearStrength.value = opening.current * THREE.MathUtils.smoothstep(camera.position.y, CLOUD_BOTTOM, CLOUD_BOTTOM + 0.5)
  })

  return <primitive object={pass} dispose={null} />
}
