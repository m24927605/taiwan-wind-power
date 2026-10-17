import { useThree } from '@react-three/fiber'
import { useEffect } from 'react'

/**
 * Development-only bridge for automated inspection: dispatch
 * `new CustomEvent('scene:eval', { detail: 'return scene.children.length' })` and read the
 * result from `document.body.dataset.eval`.
 */
export function DevProbe() {
  const { scene, gl, camera } = useThree()
  useEffect(() => {
    const onEval = (e: Event) => {
      try {
        const fn = new Function('scene', 'gl', 'camera', (e as CustomEvent<string>).detail)
        document.body.dataset.eval = JSON.stringify(fn(scene, gl, camera))
      } catch (err) {
        document.body.dataset.eval = `error: ${err}`
      }
    }
    document.addEventListener('scene:eval', onEval)
    return () => document.removeEventListener('scene:eval', onEval)
  }, [scene, gl, camera])
  return null
}
