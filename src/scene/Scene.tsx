import { PerformanceMonitor } from '@react-three/drei'
import { Canvas } from '@react-three/fiber'
import { Bloom, EffectComposer, ToneMapping, Vignette } from '@react-three/postprocessing'
import { ToneMappingMode } from 'postprocessing'
import { useState } from 'react'
import { useStore } from '../state'
import { Soundscape } from '../audio/Soundscape'
import { AtmosphereLuts } from './AtmosphereLuts'
import { CameraRig } from './CameraRig'
import { CloudLayer } from './CloudLayer'
import { DevProbe } from './DevProbe'
import { FarmBounds } from './FarmBounds'
import { Interaction } from './Interaction'
import { Kuroshio } from './Kuroshio'
import { Layer } from './Layer'
import { Measure } from './Measure'
import { Ocean } from './ocean/Ocean'
import { SceneClock } from './SceneClock'
import { Sky, SkyEnvironment } from './Sky'
import { Stars } from './Stars'
import { StatsProbe } from './StatsProbe'
import { Terrain } from './Terrain'
import { HeroTurbine } from './turbine/HeroTurbine'
import { WindFarms } from './turbine/WindFarms'

const COARSE_POINTER = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches
const PARTICLE_SIZE = COARSE_POINTER ? 192 : 256
const WAVE_RESOLUTION = COARSE_POINTER ? 128 : 256
const MAX_DPR = Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, COARSE_POINTER ? 1.75 : 2)

export function Scene() {
  const elevation = useStore((s) => s.elevation)
  const weather = useStore((s) => s.weather)
  // Adaptive resolution: drop toward 1x when frames run long, recover when there is headroom.
  const [dpr, setDpr] = useState(MAX_DPR)

  return (
    <Canvas
      flat
      shadows="soft"
      dpr={dpr}
      camera={{ fov: 38, near: 0.05, far: 12000 }}
      gl={{ antialias: false, powerPreference: 'high-performance', localClippingEnabled: true, stencil: false }}
    >
      <PerformanceMonitor
        bounds={() => [50, 58]}
        flipflops={4}
        onDecline={() => setDpr((d) => Math.max(1, d - 0.25))}
        onIncline={() => setDpr((d) => Math.min(MAX_DPR, d + 0.25))}
        onFallback={() => setDpr(1)}
      />
      <StatsProbe particles={PARTICLE_SIZE * PARTICLE_SIZE} />
      <SceneClock />
      <AtmosphereLuts />
      <Soundscape />
      {import.meta.env.DEV && <DevProbe />}
      <CameraRig />
      <Sky />
      <Stars />
      <SkyEnvironment />
      {elevation && <Ocean elevation={elevation} waveResolution={WAVE_RESOLUTION} />}
      {/* Without the island drape the terrain still renders with the domain imagery. */}
      <Layer
        name="terrain"
        fallback={
          <Layer name="terrain (domain imagery)">
            <Terrain detail={false} />
          </Layer>
        }
      >
        <Terrain detail />
      </Layer>
      {elevation && weather && <Kuroshio elevation={elevation} weather={weather} size={PARTICLE_SIZE} />}
      <Layer name="wind farms">
        <WindFarms />
      </Layer>
      <Layer name="hero turbine">
        <HeroTurbine />
      </Layer>
      <FarmBounds />
      <Interaction />
      <Measure />
      {/* MSAA only pays off below ~1.5x; at retina density the extra samples cost more than they show. */}
      <EffectComposer multisampling={dpr > 1.5 ? 0 : 4}>
        <CloudLayer dpr={dpr} />
        <Bloom mipmapBlur intensity={0.6} luminanceThreshold={2.2} luminanceSmoothing={0.5} radius={0.7} />
        <Vignette offset={0.32} darkness={0.55} />
        {/* The scene is shaded in exposed scene radiance; ACES brings highlights into range. */}
        <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      </EffectComposer>
    </Canvas>
  )
}
