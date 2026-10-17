import { Environment, Lightformer } from '@react-three/drei'
import { Canvas, useFrame } from '@react-three/fiber'
import { Bloom, EffectComposer } from '@react-three/postprocessing'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../state'
import { createGrindSound, type GrindSound } from './grindSound'
import { Stone, type StoneHandle } from './Stone'
import './intro.css'

const AUTHOR = '陳信成'
const LEAVE_AFTER_FINISH_MS = 2600
const LEAVE_DURATION_MS = 1400

type Phase = 'polish' | 'reveal' | 'leave'

/** Dolly the camera into the stone face when leaving, so the engraving fills the frame. */
function Dolly({ phase }: { phase: Phase }) {
  useFrame(({ camera, size }, dt) => {
    // Keep the whole stone (about 3 units wide) in frame on portrait screens.
    const fit = Math.max(6, 3.4 / (2 * Math.tan((15 * Math.PI) / 180) * (size.width / size.height)))
    const target = phase === 'leave' ? 1.1 : fit
    camera.position.z += (target - camera.position.z) * Math.min(1, dt * (phase === 'leave' ? 1.6 : 2))
  })
  return null
}

export function Intro() {
  const [phase, setPhase] = useState<Phase>('polish')
  const [progress, setProgress] = useState(0)
  const stone = useRef<StoneHandle>({ progress: 0, finished: false })
  const sound = useRef<GrindSound | null>(null)

  const leave = useCallback(() => {
    setPhase('leave')
    useStore.setState({ stage: 'enter' })
    setTimeout(() => useStore.setState({ stage: 'main' }), LEAVE_DURATION_MS)
  }, [])

  const onFinish = useCallback(() => {
    sound.current?.chime()
    setPhase('reveal')
    setTimeout(leave, LEAVE_AFTER_FINISH_MS)
  }, [leave])

  const onStroke = useCallback((intensity: number) => sound.current?.setIntensity(intensity), [])

  useEffect(() => {
    const id = setInterval(() => setProgress(stone.current.progress), 100)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === 'Escape') leave()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      clearInterval(id)
      window.removeEventListener('keydown', onKey)
      sound.current?.dispose()
    }
  }, [leave])

  const startSound = () => {
    if (!sound.current) sound.current = createGrindSound()
  }

  return (
    <div className={`intro is-${phase}`} onPointerDown={startSound}>
      <div className="intro__glyph" aria-hidden>
        磨
      </div>
      <Canvas
        className="intro__canvas"
        dpr={[1, 2]}
        camera={{ position: [0, 0, 6], fov: 30 }}
        gl={{ antialias: true }}
      >
        <color attach="background" args={['#05080d']} />
        <Environment resolution={256}>
          <Lightformer form="rect" intensity={2.2} position={[0, 4, 2]} scale={[8, 1.2, 1]} rotation-x={Math.PI / 2.4} />
          <Lightformer form="rect" intensity={1.4} position={[-5, 0.5, 1]} scale={[0.6, 6, 1]} rotation-y={Math.PI / 2.2} />
          <Lightformer form="rect" intensity={1.2} position={[5, -0.5, 1]} scale={[0.6, 6, 1]} rotation-y={-Math.PI / 2.2} />
          <Lightformer form="ring" color="#f2c27a" intensity={1.6} position={[2.5, 2, 4]} scale={1.4} />
          <Lightformer form="rect" color="#5fe1ff" intensity={0.6} position={[0, -4, 1]} scale={[8, 1, 1]} rotation-x={-Math.PI / 2.4} />
        </Environment>
        <spotLight position={[3, 4, 5]} angle={0.5} penumbra={0.8} intensity={60} color="#ffe9cc" />
        <ambientLight intensity={0.04} />
        <Stone handle={stone} onStroke={onStroke} onFinish={onFinish} />
        <Dolly phase={phase} />
        <EffectComposer>
          <Bloom mipmapBlur intensity={0.9} luminanceThreshold={0.7} radius={0.6} />
        </EffectComposer>
      </Canvas>

      <header className="intro__head">
        <span className="intro__kicker">POLISH · 磨</span>
        <h2>好的作品，都是磨出來的。</h2>
      </header>

      <div className="intro__foot">
        {phase === 'polish' ? (
          <>
            <p className="intro__hint">按住並拖曳，親手打磨這方硯台</p>
            <div className="intro__progress">
              <i style={{ transform: `scaleX(${progress})` }} />
            </div>
            <span className="intro__pct">研磨 {Math.round(progress * 100)}%</span>
          </>
        ) : (
          <p className="intro__reveal">黑潮與風，此刻正流過台灣。</p>
        )}
      </div>

      <button className="intro__skip" onClick={leave}>
        略過 <span>Enter</span>
      </button>
      <p className="intro__credit">
        A Three.js study for 磨人 POLISH™ · {AUTHOR}
      </p>
    </div>
  )
}
