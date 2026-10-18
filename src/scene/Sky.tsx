import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { ATMOSPHERE_GLSL, atmosphere } from './atmosphere'
import { CLOUDS_GLSL, clouds } from './clouds'

/**
 * The sky dome, from the atmosphere's sky-view LUT. The environment variant feeds image-based
 * lighting: the sky as seen from the sea surface without the key light's disc (that is the
 * directional light), over a dim sea in the lower hemisphere.
 */
const createMaterial = (environment: boolean) =>
  new THREE.ShaderMaterial({
    uniforms: { ...atmosphere, ...clouds },
    defines: environment ? { ENVIRONMENT: '' } : {},
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }
    `,
    fragmentShader: /* glsl */ `
      ${ATMOSPHERE_GLSL}
      ${CLOUDS_GLSL}
      varying vec3 vDir;
      const float DISC_RADIUS = 0.00465;

      // Hashed stars on a grid of directions, about a pixel across.
      float stars(vec3 d) {
        vec3 p = d * 300.0;
        vec3 cell = floor(p);
        vec3 h = fract(sin(vec3(dot(cell, vec3(127.1, 311.7, 74.7)), dot(cell, vec3(269.5, 183.3, 246.1)), dot(cell, vec3(113.5, 271.9, 124.6)))) * 43758.5453);
        if (h.x < 0.975) return 0.0;
        float r = length(p - cell - 0.2 - h * 0.6);
        float twinkle = 0.7 + 0.3 * sin(uTime * (1.0 + h.z * 3.0) + h.y * 40.0);
        return smoothstep(0.35, 0.0, r) * (0.15 + pow(h.y, 8.0) * 4.0) * twinkle;
      }

      void main() {
        vec3 dir = normalize(vDir);
        #ifdef ENVIRONMENT
        vec3 col = groundEnvRadiance(vec3(dir.x, max(dir.y, 0.0), dir.z), 0.0);
        // Below the horizon: deep water reflecting a little of the sky above it.
        vec3 sea = groundSkyRadiance(vec3(dir.x, -dir.y, dir.z)) * 0.06
          + vec3(0.006, 0.014, 0.018) * (skyIrradiance() + sunIrradiance(0.0) * max(uSunDir.y, 0.0));
        col = mix(col, sea, smoothstep(0.02, -0.04, dir.y));
        #else
        vec3 col = applyCirrus(skyRadiance(dir), dir, uCameraPos);
        float r = RG + max(uCameraPos.y, 0.001);
        float darkness = smoothstep(-0.08, -0.25, uSunTrue.y);
        if (darkness > 0.0) col += stars(dir) * darkness * 6e-3 * transmittanceTo(r, dir.y) * step(0.0, dir.y);
        float x = acos(clamp(dot(dir, uSunDir), -1.0, 1.0)) / DISC_RADIUS;
        if (x < 1.2) {
          float mu = sqrt(max(1.0 - x * x, 0.0));
          float shade = 1.0 - 0.6 * (1.0 - mu);
          if (uMoonLight > 0.5) {
            // The moon's near hemisphere, lit by the sun: its phase, with a little earthshine.
            vec3 t1 = normalize(cross(uSunDir, vec3(0.0, 1.0, 0.0)));
            vec3 t2 = cross(t1, uSunDir);
            vec3 off = (dir - uSunDir * dot(dir, uSunDir)) / DISC_RADIUS;
            vec3 n = t1 * dot(off, t1) + t2 * dot(off, t2) - uSunDir * mu;
            float full = pow(0.5 - 0.5 * dot(uSunTrue, uSunDir), 1.5);
            shade = (max(dot(n, uSunTrue), 0.0) + 0.01) / max(full, 0.02);
          }
          col += uSunE * sunTransmittance(r, uSunDir.y) * 80.0 * shade * smoothstep(1.05, 0.95, x);
        }
        #endif
        gl_FragColor = vec4(col * uExposure, 1.0);
        #include <colorspace_fragment>
      }
    `,
  })

const material = createMaterial(false)
const geometry = new THREE.SphereGeometry(1, 48, 24)

/** Re-filter the environment once the key light has moved this far (radians) or exposure has shifted. */
const ENV_SUN_STEP = 0.01
const ENV_EXPOSURE_STEP = 0.04

export function Sky() {
  const mesh = useRef<THREE.Mesh>(null)
  useFrame(({ camera }) => mesh.current?.position.copy(camera.position))
  return <mesh ref={mesh} geometry={geometry} material={material} frustumCulled={false} renderOrder={-1} />
}

/** Image-based lighting from the live sky, so painted steel picks up skylight and the sea. */
export function SkyEnvironment() {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const state = useRef<{ pmrem: THREE.PMREMGenerator; sky: THREE.Scene; target: THREE.WebGLRenderTarget | null } | null>(null)
  const last = useRef({ sun: new THREE.Vector3(0, -2, 0), exposure: -1 })

  useEffect(() => {
    const envMaterial = createMaterial(true)
    const sky = new THREE.Scene()
    sky.add(new THREE.Mesh(geometry, envMaterial))
    const s = { pmrem: new THREE.PMREMGenerator(gl), sky, target: null as THREE.WebGLRenderTarget | null }
    state.current = s
    last.current.exposure = -1
    return () => {
      if (scene.environment === s.target?.texture) scene.environment = null
      s.target?.dispose()
      s.pmrem.dispose()
      envMaterial.dispose()
      state.current = null
    }
  }, [gl, scene])

  useFrame(() => {
    const s = state.current
    if (!s || !atmosphere.uGroundSky.value) return
    const sun = atmosphere.uSunDir.value
    const exposure = atmosphere.uExposure.value
    const moved = last.current.sun.angleTo(sun) >= ENV_SUN_STEP
    if (!moved && Math.abs(exposure / last.current.exposure - 1) < ENV_EXPOSURE_STEP) return
    last.current.sun.copy(sun)
    last.current.exposure = exposure
    const previous = s.target
    s.target = s.pmrem.fromScene(s.sky, 0, 0.1, 10)
    scene.environment = s.target.texture
    previous?.dispose()
  })

  return null
}
