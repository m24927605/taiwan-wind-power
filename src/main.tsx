import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { getControls } from './scene/camera.ts'
import { useStore } from './state.ts'

// Dev hook: document.dispatchEvent(new CustomEvent('store:set', { detail: {...} })) patches state.
if (import.meta.env.DEV) {
  const logs: string[] = []
  for (const level of ['error', 'warn'] as const) {
    const original = console[level]
    console[level] = (...args: unknown[]) => {
      logs.push(`${level}: ${args.map(String).join(' ').slice(0, 2000)}`)
      document.body.dataset.logs = JSON.stringify(logs.slice(-10))
      original(...args)
    }
  }
  document.addEventListener('store:set', (e) => useStore.setState((e as CustomEvent).detail))
  document.addEventListener('store:log', () => {
    const { weather, elevation, error, time, stats } = useStore.getState()
    document.body.dataset.debug = JSON.stringify({ weather: weather?.times.length, elevation: !!elevation, error, time, stats })
  })
  document.addEventListener('camera:look', (e) => {
    const [px, py, pz, tx, ty, tz] = (e as CustomEvent<number[]>).detail
    getControls()?.setLookAt(px, py, pz, tx, ty, tz, false)
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
