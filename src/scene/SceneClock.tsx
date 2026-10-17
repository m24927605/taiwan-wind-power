import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { sunDirection } from '../geo/sun'
import { useStore } from '../state'
import { MOON_DIR, atmosphere } from './atmosphere'
import { advanceFarms } from './turbine/dynamics'

const TAIWAN_LON = 120.9
const TAIWAN_LAT = 23.7
const STORE_SYNC_SECONDS = 0.1

/** Advances scene time, then derives the sun, lighting and wind-farm state from it. */
export function SceneClock() {
  const sun = useRef<THREE.DirectionalLight>(null)
  const moon = useRef<THREE.DirectionalLight>(null)
  const hemi = useRef<THREE.HemisphereLight>(null)
  const time = useRef(useStore.getState().time)
  const synced = useRef(time.current)
  const sinceSync = useRef(0)
  const colors = useMemo(() => ({ noon: new THREE.Color(1, 0.97, 0.92), low: new THREE.Color(1, 0.55, 0.3) }), [])

  useFrame(({ camera }, rawDt) => {
    const dt = Math.min(rawDt, 0.1)
    const { live, speed, weather, time: storeTime } = useStore.getState()
    // Any outside write to the store time (timeline scrubbing) is a seek.
    if (storeTime !== synced.current) time.current = synced.current = storeTime
    if (live) time.current = Date.now() / 1000
    else time.current += dt * speed * 3600
    if (weather) {
      const first = weather.times[0]
      const last = weather.times[weather.times.length - 1]
      time.current = Math.min(Math.max(time.current, first), last)
      advanceFarms(weather, time.current, dt)
    }
    sinceSync.current += dt
    if (sinceSync.current > STORE_SYNC_SECONDS) {
      sinceSync.current = 0
      synced.current = time.current
      useStore.setState({ time: time.current })
    }

    const [x, y, z] = sunDirection(time.current, TAIWAN_LON, TAIWAN_LAT)
    atmosphere.uSunDir.value.set(x, y, z)
    const day = THREE.MathUtils.smoothstep(y, -0.1, 0.15)
    atmosphere.uDay.value = day
    atmosphere.uTime.value += dt
    atmosphere.uCameraPos.value.copy(camera.position)

    if (sun.current && moon.current && hemi.current) {
      sun.current.position.set(x, y, z).multiplyScalar(100)
      sun.current.intensity = 3.2 * THREE.MathUtils.smoothstep(y, -0.02, 0.12)
      sun.current.color.lerpColors(colors.low, colors.noon, THREE.MathUtils.smoothstep(y, 0, 0.35))
      moon.current.intensity = 0.35 * (1 - day)
      hemi.current.intensity = 0.15 + 0.85 * day
    }
  })

  return (
    <>
      <directionalLight ref={sun} />
      <directionalLight ref={moon} color="#9fb4ff" position={MOON_DIR.clone().multiplyScalar(100)} />
      <hemisphereLight ref={hemi} args={['#bcd3ee', '#1b2a3a', 1]} />
    </>
  )
}
