import { Canvas } from '@react-three/fiber'
import { Suspense } from 'react'
import { useStore } from '../state'
import { CameraRig } from './CameraRig'
import { DevProbe } from './DevProbe'
import { Kuroshio } from './Kuroshio'
import { Ocean } from './Ocean'
import { SceneClock } from './SceneClock'
import { Sky } from './Sky'
import { StatsProbe } from './StatsProbe'
import { Terrain } from './Terrain'
import { WindFarms } from './turbine/WindFarms'

const PARTICLE_SIZE = 256

export function Scene() {
  const elevation = useStore((s) => s.elevation)
  const weather = useStore((s) => s.weather)
  return (
    <Canvas
      flat
      dpr={[1, 2]}
      camera={{ fov: 38, near: 0.05, far: 12000 }}
      gl={{ antialias: true, powerPreference: 'high-performance' }}
    >
      <StatsProbe particles={PARTICLE_SIZE * PARTICLE_SIZE} />
      <SceneClock />
      {import.meta.env.DEV && <DevProbe />}
      <CameraRig />
      <Sky />
      {elevation && (
        <>
          <Ocean elevation={elevation} />
          <Terrain elevation={elevation} />
        </>
      )}
      {elevation && weather && <Kuroshio elevation={elevation} weather={weather} size={PARTICLE_SIZE} />}
      <Suspense fallback={null}>
        <WindFarms />
      </Suspense>
    </Canvas>
  )
}
