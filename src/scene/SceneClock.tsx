import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { OBSERVER, moonDirection, sunDirection } from '../geo/sun'
import { TURBINES } from '../data/windfarms'
import { useStore } from '../state'
import { MOON_RATIO, NIGHT_ELEVATION, SUN_E, atmosphere, seaLevelTransmittance } from './atmosphere'
import { advanceFarms, turbineScale, updateTurbineView } from './turbine/dynamics'

const STORE_SYNC_SECONDS = 0.1
/** Half-width of the sun's shadow frustum around the selected turbine, in model metres. */
const SHADOW_HALF_EXTENT = 200

/** Advances scene time, then derives the sun, lighting and wind-farm state from it. */
export function SceneClock() {
  const sun = useRef<THREE.DirectionalLight>(null)
  const initialTime = useStore.getState().time
  const time = useRef(initialTime)
  const synced = useRef(initialTime)
  const sinceSync = useRef(0)
  const scratch = useMemo(() => ({ moon: new THREE.Vector3(), transmittance: new THREE.Color() }), [])

  useFrame(({ camera }, rawDt) => {
    const dt = Math.min(rawDt, 0.1)
    updateTurbineView(camera.position.y)
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

    const trueSun = atmosphere.uSunTrue.value.set(...sunDirection(time.current, OBSERVER.lon, OBSERVER.lat))
    const moonDir = scratch.moon.set(...moonDirection(time.current, OBSERVER.lon, OBSERVER.lat))
    atmosphere.uDay.value = THREE.MathUtils.smoothstep(trueSun.y, -0.1, 0.15)
    // After nautical dusk the moon, at its real phase, is the key light of the whole scene.
    const night = trueSun.y < Math.sin(NIGHT_ELEVATION)
    const lit = 0.5 - 0.5 * trueSun.dot(moonDir)
    atmosphere.uMoonLight.value = night ? 1 : 0
    atmosphere.uSunDir.value.copy(night ? moonDir : trueSun)
    atmosphere.uSunE.value = night ? SUN_E * MOON_RATIO * lit ** 1.5 : SUN_E
    atmosphere.uTime.value += dt
    atmosphere.uCameraPos.value.copy(camera.position)
    const [x, y, z] = atmosphere.uSunDir.value.toArray()

    if (sun.current) {
      // Shadows only matter for the close-up turbine, so the frustum hugs it.
      const { selected } = useStore.getState()
      const focus = selected !== null ? TURBINES[selected] : null
      sun.current.castShadow = focus !== null
      if (focus) {
        // The frustum hugs the selected turbine at whatever size it is drawn.
        const c = sun.current.shadow.camera
        const half = SHADOW_HALF_EXTENT * turbineScale(focus.farm)
        if (Math.abs(c.right - half) > half * 0.02) {
          c.left = c.bottom = -half
          c.right = c.top = half
          c.updateProjectionMatrix()
        }
      }
      sun.current.target.position.set(focus?.x ?? 0, 0, focus?.z ?? 0)
      sun.current.position.set(x, y, z).multiplyScalar(5).add(sun.current.target.position)
      sun.current.target.updateMatrixWorld()
      // Irradiance of the key light at sea level, through the atmosphere, in display units.
      const t = seaLevelTransmittance(y, scratch.transmittance)
      sun.current.color.copy(t)
      sun.current.intensity = atmosphere.uSunE.value * atmosphere.uExposure.value
    }
  })

  return (
    <>
      <directionalLight
        ref={sun}
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.002}
        shadow-camera-near={0.5}
        shadow-camera-far={10}
      />
    </>
  )
}
