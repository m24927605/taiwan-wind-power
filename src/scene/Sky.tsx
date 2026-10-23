import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OBSERVER } from '../geo/sun'
import { ATMOSPHERE_GLSL, atmosphere } from './atmosphere'
import { CLOUDS_GLSL, clouds } from './clouds'

/** The lunar surface (scripts/build-moon.ts), equirectangular with longitude 0 at the centre. */
const moonMap = new THREE.TextureLoader().load('textures/moon.webp')
moonMap.colorSpace = THREE.SRGBColorSpace
/** The north celestial pole in world space: the moon's north leans toward it. */
const LAT = (OBSERVER.lat * Math.PI) / 180
const CELESTIAL_NORTH = new THREE.Vector3(0, Math.sin(LAT), -Math.cos(LAT))

/**
 * The sky dome, from the atmosphere's sky-view LUT. The environment variant feeds image-based
 * lighting: the sky as seen from the sea surface without the key light's disc (that is the
 * directional light), over a dim sea in the lower hemisphere.
 */
const createMaterial = (environment: boolean) =>
  new THREE.ShaderMaterial({
    uniforms: { ...atmosphere, ...clouds, uMoonMap: { value: moonMap }, uCelestialNorth: { value: CELESTIAL_NORTH } },
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

      uniform sampler2D uMoonMap;
      uniform vec3 uCelestialNorth;
      /** Display brightness of sunlit highlands: the moon is the brightest thing in the night sky. */
      const float MOON_DISPLAY = 3.6;
      /** Mean albedo of the lunar highlands in moon.webp, so the map's grey reads as relative albedo. */
      const float MOON_MAP_HIGHLANDS = 0.6;

      // The moon as seen from Taiwan: the photographed lunar surface on its near side, north leaning
      // toward the celestial pole, lit by the sun at the real phase (Lommel-Seeliger, so the limb
      // does not darken). The unlit part is simply not seen: the sky shows through. A faint glow of
      // scattered moonlight lies evenly over the disc and around it. In display units, like the stars
      // (Stars.tsx): exposure stops adapting at night.
      vec3 moonDisc(vec3 dir, float x, float r) {
        vec3 tint = sunTransmittance(r, uSunDir.y) / max(sunTransmittance(r, 1.0), vec3(1e-4));
        float phase = 0.5 - 0.5 * dot(uSunTrue, uSunDir);
        vec3 glow = vec3(0.75, 0.82, 1.0) * 0.035 * phase * exp(-x * 0.08);
        if (x >= 1.02) return glow * tint;
        vec3 up = normalize(uCelestialNorth - uSunDir * dot(uCelestialNorth, uSunDir));
        vec3 right = cross(uSunDir, up);
        vec2 q = vec2(dot(dir, right), dot(dir, up)) / DISC_RADIUS;
        float z = sqrt(max(1.0 - dot(q, q), 0.0));
        vec3 n = right * q.x + up * q.y - uSunDir * z;
        vec2 uv = vec2(0.5 + atan(q.x, z) / (2.0 * PI), 0.5 + asin(clamp(q.y, -1.0, 1.0)) / PI);
        float albedo = texture2D(uMoonMap, uv).r / MOON_MAP_HIGHLANDS;
        float mu0 = max(dot(n, uSunTrue), 0.0);
        float lit = mu0 / (mu0 + z + 1e-3);
        float edge = smoothstep(1.02, 0.98, x);
        return (vec3(1.0, 0.99, 0.97) * MOON_DISPLAY * albedo * lit * edge + glow) * tint;
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
        vec3 col = applyHighCloud(skyRadiance(dir), dir, uCameraPos);
        float r = RG + max(uCameraPos.y, 0.001);
        float x = acos(clamp(dot(dir, uSunDir), -1.0, 1.0)) / DISC_RADIUS;
        if (uMoonLight > 0.5) {
          col += moonDisc(dir, x, r) / uExposure;
        } else if (x < 1.2) {
          float mu = sqrt(max(1.0 - x * x, 0.0));
          float shade = 1.0 - 0.6 * (1.0 - mu);
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
