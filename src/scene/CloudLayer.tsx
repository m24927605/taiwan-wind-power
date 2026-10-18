import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { cloudsAt, windAt } from '../data/weather'
import { WIND_FARMS } from '../data/windfarms'
import { useStore } from '../state'
import { CloudPass } from './CloudPass'
import { clouds, generateCloudNoise } from './clouds'

const COARSE_POINTER = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches
/** The farm whose forecast stands for the strait's wind aloft. */
const REFERENCE_FARM = Math.floor(WIND_FARMS.length / 2)
/** Clouds drift with the wind at their own height, a little faster than at the hubs. */
const CLOUD_WIND_FACTOR = 1.3

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

  useFrame((_, dt) => {
    const { weather, time } = useStore.getState()
    if (!weather) return
    // Cumulus from the forecast's low cloud, cirrus from its high cloud.
    const { low, high } = cloudsAt(weather, time)
    clouds.uCoverage.value = THREE.MathUtils.clamp(0.12 + low * 0.85, 0, 1)
    clouds.uCirrus.value = high * 0.9
    const wind = windAt(weather, REFERENCE_FARM, time)
    const step = wind.speed * CLOUD_WIND_FACTOR * 0.001 * Math.min(dt, 0.1)
    // Wind blows from fromRad; the field moves the other way (+x east, -z north).
    clouds.uCloudOffset.value.x -= Math.sin(wind.fromRad) * step
    clouds.uCloudOffset.value.y += Math.cos(wind.fromRad) * step
  })

  return <primitive object={pass} dispose={null} />
}
