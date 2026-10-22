import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { seaAt } from '../data/weather'
import { TURBINES } from '../data/windfarms'
import { atmosphere } from '../scene/atmosphere'
import { TURBINE } from '../scene/turbine/spec'
import { farmDynamics, turbineScale } from '../scene/turbine/dynamics'
import { useStore } from '../state'
import { updateSound } from './engine'

/** The soundscape follows the scene a few times a second; its parameters glide in between. */
const EVERY = 4

/** Feeds the soundscape what the camera hears: height, sea, wind and the nearest rotor. */
export function Soundscape() {
  const frame = useRef(0)
  const elapsed = useRef(0)
  const scratch = useMemo(() => ({ right: new THREE.Vector3(), to: new THREE.Vector3() }), [])

  useFrame(({ camera }, dt) => {
    elapsed.current += dt
    if (frame.current++ % EVERY !== 0) return
    const { weather, time } = useStore.getState()
    const p = camera.position
    let nearest = 0
    let best = Infinity
    for (let i = 0; i < TURBINES.length; i++) {
      const t = TURBINES[i]
      const d = (t.x - p.x) ** 2 + (TURBINE.hubHeight * turbineScale(t.farm) - p.y) ** 2 + (t.z - p.z) ** 2
      if (d < best) {
        best = d
        nearest = i
      }
    }
    const turbine = TURBINES[nearest]
    scratch.right.set(1, 0, 0).applyQuaternion(camera.quaternion)
    scratch.to.set(turbine.x - p.x, TURBINE.hubHeight * turbineScale(turbine.farm) - p.y, turbine.z - p.z).normalize()
    let waveHeight = 1
    if (weather) {
      const { windSea, swell } = seaAt(weather, time, p.x, p.z)
      waveHeight = Math.hypot(windSea.hs, swell.hs)
    }
    updateSound(
      {
        altitude: p.y,
        waveHeight,
        wind: farmDynamics.wind[turbine.farm],
        turbineDistance: Math.sqrt(best),
        rotorRpm: farmDynamics.rpm[turbine.farm],
        turbinePan: scratch.right.dot(scratch.to),
        day: atmosphere.uDay.value,
      },
      elapsed.current,
    )
    elapsed.current = 0
  })

  return null
}
