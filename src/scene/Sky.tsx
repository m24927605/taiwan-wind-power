import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { ATMOSPHERE_GLSL, atmosphere } from './atmosphere'

/**
 * The sky dome. The environment variant feeds image-based lighting: it drops stars and the sun
 * disc (the sun is a directional light) and fills the lower hemisphere with open sea.
 */
const createMaterial = (environment: boolean) => new THREE.ShaderMaterial({
  uniforms: { ...atmosphere },
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
    varying vec3 vDir;

    float stars(vec3 dir) {
      // Cube-face cells give an even star distribution without polar pinching.
      vec3 a = abs(dir);
      vec2 uv = a.x > a.y && a.x > a.z ? dir.yz / a.x : a.y > a.z ? dir.xz / a.y : dir.xy / a.z;
      vec2 cell = floor(uv * 260.0);
      float h = hash12(cell + sign(dir.x) * 17.0 + sign(dir.y) * 31.0 + sign(dir.z) * 7.0);
      vec2 f = fract(uv * 260.0) - 0.5;
      float star = smoothstep(0.08, 0.0, length(f)) * step(0.985, h);
      float twinkle = 0.6 + 0.4 * sin(uTime * (1.0 + h * 3.0) + h * 40.0);
      return star * twinkle * (h - 0.985) * 66.0;
    }

    void main() {
      vec3 dir = normalize(vDir);
      vec3 col = skyColor(dir);
      #ifdef ENVIRONMENT
      // Skylight reaching a surface is far less saturated than the zenith seen against black.
      col = mix(vec3(dot(col, vec3(0.2126, 0.7152, 0.0722))), col, 0.45);
      // Below the horizon: deep water reflecting a dimmed sky.
      vec3 sea = vec3(0.012, 0.05, 0.07) * mix(0.05, 1.0, uDay) + skyColor(vec3(dir.x, -dir.y, dir.z)) * 0.06;
      col = mix(col, sea, smoothstep(0.02, -0.04, dir.y));
      col += sunColor() * pow(max(dot(dir, uSunDir), 0.0), 12.0) * 0.18 * uDay;
      gl_FragColor = vec4(col, 1.0);
      return;
      #endif
      float sd = max(dot(dir, uSunDir), 0.0);
      col += sunColor() * (pow(sd, 1800.0) * 12.0 + pow(sd, 12.0) * 0.18 * (0.3 + uDay));
      float night = 1.0 - smoothstep(0.0, 0.35, uDay);
      col += vec3(0.85, 0.9, 1.0) * stars(dir) * night * smoothstep(0.0, 0.15, dir.y);
      float md = max(dot(dir, MOON_DIR), 0.0);
      col += vec3(0.8, 0.86, 1.0) * (smoothstep(0.99985, 0.9999, md) * 1.6 + pow(md, 60.0) * 0.08) * night;
      gl_FragColor = vec4(col, 1.0);
      #include <colorspace_fragment>
    }
  `,
})

const material = createMaterial(false)
const geometry = new THREE.SphereGeometry(1, 48, 24)

/** Re-filter the environment once the sun has moved this far (radians) or daylight has shifted. */
const ENV_SUN_STEP = 0.01
const ENV_DAY_STEP = 0.02

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
  const last = useRef({ sun: new THREE.Vector3(0, -2, 0), day: -1 })

  useEffect(() => {
    const envMaterial = createMaterial(true)
    const sky = new THREE.Scene()
    sky.add(new THREE.Mesh(geometry, envMaterial))
    const s = { pmrem: new THREE.PMREMGenerator(gl), sky, target: null as THREE.WebGLRenderTarget | null }
    state.current = s
    last.current.day = -1
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
    if (!s) return
    const sun = atmosphere.uSunDir.value
    const day = atmosphere.uDay.value
    if (last.current.sun.angleTo(sun) < ENV_SUN_STEP && Math.abs(last.current.day - day) < ENV_DAY_STEP) return
    last.current.sun.copy(sun)
    last.current.day = day
    const previous = s.target
    s.target = s.pmrem.fromScene(s.sky, 0, 0.1, 10)
    scene.environment = s.target.texture
    previous?.dispose()
  })

  return null
}
