import { Canvas } from '@react-three/fiber'
import { Suspense } from 'react'
import { useStore } from '../state'
import { CameraRig } from './CameraRig'
import { Ocean } from './Ocean'
import { SceneClock } from './SceneClock'
import { Sky } from './Sky'
import { Terrain } from './Terrain'
import { WindFarms } from './turbine/WindFarms'

export function Scene() {
  const elevation = useStore((s) => s.elevation)
  return (
    <Canvas
      flat
      dpr={[1, 2]}
      camera={{ fov: 38, near: 0.05, far: 12000 }}
      gl={{ antialias: true, powerPreference: 'high-performance' }}
    >
      <SceneClock />
      <CameraRig />
      <Sky />
      {elevation && (
        <>
          <Ocean elevation={elevation} />
          <Terrain elevation={elevation} />
        </>
      )}
      <Suspense fallback={null}>
        <WindFarms />
      </Suspense>
    </Canvas>
  )
}
