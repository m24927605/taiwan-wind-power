import { createPortal, useThree } from '@react-three/fiber'
import { RenderPass } from 'postprocessing'
import { useEffect, useMemo, type ReactNode } from 'react'
import * as THREE from 'three'

/** Renders its scene over what is already in the buffer, clearing only depth. */
class OverlayPass extends RenderPass {
  constructor(scene: THREE.Scene, camera: THREE.Camera) {
    super(scene, camera)
    this.getClearPass().setClearFlags(false, true, false)
    this.skipShadowMapUpdate = true
    // The scene's depth, which later passes may read, stays as the main render left it.
    this.needsDepthBlit = false
  }

  override render(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget, outputBuffer: THREE.WebGLRenderTarget, deltaTime?: number, stencilTest?: boolean) {
    // The composer renders with autoClear on, which would wipe the image underneath.
    const autoClear = renderer.autoClear
    renderer.autoClear = false
    super.render(renderer, inputBuffer, outputBuffer, deltaTime, stencilTest)
    renderer.autoClear = autoClear
  }
}

/**
 * Draws its children over the clouds: map marks that must stay legible whatever the weather.
 * Mount inside the composer, after the cloud pass. The scene's depth does not reach this far, so
 * the marks only hide one another.
 */
export function Overlay({ children }: { children: ReactNode }) {
  const camera = useThree((s) => s.camera)
  const scene = useMemo(() => new THREE.Scene(), [])
  const pass = useMemo(() => new OverlayPass(scene, camera), [scene, camera])
  useEffect(() => () => pass.dispose(), [pass])

  return (
    <>
      {createPortal(children, scene)}
      <primitive object={pass} dispose={null} />
    </>
  )
}
