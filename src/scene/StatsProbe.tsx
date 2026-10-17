import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import { useStore } from '../state'
import { lodCounts } from './turbine/WindFarms'

const PUBLISH_EVERY = 0.5

/**
 * Accumulates renderer.info over whole frames (the composer issues several render calls per
 * frame) and publishes a snapshot for the engineering overlay twice a second.
 */
export function StatsProbe({ particles }: { particles: number }) {
  const gl = useThree((s) => s.gl)
  const acc = useRef({ time: 0, frames: 0, worst: 0 })

  useEffect(() => {
    gl.info.autoReset = false
    return () => {
      gl.info.autoReset = true
    }
  }, [gl])

  // Runs first each frame: read what the previous frame drew, then reset the counters.
  useFrame((state, dt) => {
    const a = acc.current
    a.time += dt
    a.frames++
    a.worst = Math.max(a.worst, dt)
    if (a.time >= PUBLISH_EVERY) {
      const { render, memory, programs } = gl.info
      useStore.setState({
        stats: {
          fps: a.frames / a.time,
          frameMs: (a.time / a.frames) * 1000,
          calls: render.calls,
          triangles: render.triangles,
          points: render.points,
          geometries: memory.geometries,
          textures: memory.textures,
          programs: programs?.length ?? 0,
          dpr: state.viewport.dpr,
          lod: [...lodCounts],
          particles,
        },
      })
      a.time = 0
      a.frames = 0
      a.worst = 0
    }
    gl.info.reset()
  }, -1000)

  return null
}
