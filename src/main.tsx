import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { getControls } from './scene/CameraRig.tsx'
import { useStore } from './state.ts'

// Dev hook: document.dispatchEvent(new CustomEvent('store:set', { detail: {...} })) patches state.
if (import.meta.env.DEV) {
  document.addEventListener('store:set', (e) => useStore.setState((e as CustomEvent).detail))
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
