import { useGLTF, useTexture } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import { useMemo } from 'react'
import * as THREE from 'three'
import { VERTICAL_EXAGGERATION, WORLD } from '../geo/domain'
import { ATMOSPHERE_GLSL, atmosphere } from './atmosphere'

const TERRAIN_URL = '/models/terrain.glb'
const IMAGERY_URL = '/textures/imagery.webp'
const NORMALS_URL = '/textures/normals.webp'
/** Matches scripts/build-terrain.ts: land is lifted this far above the ocean plane. */
const LAND_LIFT_KM = 0.004

// Sentinel-2 passes at about 10:30 local time, so the imagery carries morning sun from the
// south-south-east. Part of that baked shading is divided out before the scene sun is applied.
const CAPTURE_SUN = new THREE.Vector3(0.369, 0.766, 0.527).normalize()

function createMaterial(imagery: THREE.Texture, normals: THREE.Texture) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...atmosphere,
      uImagery: { value: imagery },
      uNormals: { value: normals },
      uDomain: { value: new THREE.Vector4(WORLD.minX, WORLD.minZ, WORLD.width, WORLD.depth) },
      uCaptureSun: { value: CAPTURE_SUN },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      varying float vElev;
      void main() {
        // The GLB is quantized; the model matrix carries the dequantization.
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vElev = max(world.y - ${LAND_LIFT_KM.toFixed(4)}, 0.0) * ${(1000 / VERTICAL_EXAGGERATION).toFixed(4)};
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      ${ATMOSPHERE_GLSL}
      uniform sampler2D uImagery;
      uniform sampler2D uNormals;
      uniform vec4 uDomain;
      uniform vec3 uCaptureSun;
      varying vec3 vWorld;
      varying float vElev;

      float contour(float h, float interval) {
        float c = h / interval;
        float w = fwidth(c);
        float line = 1.0 - min(abs(fract(c - 0.5) - 0.5) / max(w, 1e-4), 1.0);
        return line * (1.0 - smoothstep(0.15, 0.45, w));
      }

      void main() {
        vec2 uv = (vWorld.xz - uDomain.xy) / uDomain.zw;
        vec2 nxz = texture2D(uNormals, uv).rg * 2.0 - 1.0;
        vec3 n = vec3(nxz.x, sqrt(max(1.0 - dot(nxz, nxz), 0.0)), nxz.y);
        float h = vElev;

        vec3 albedo = texture2D(uImagery, uv).rgb;
        float baked = clamp(dot(n, uCaptureSun) / uCaptureSun.y, 0.35, 1.25);
        albedo /= mix(1.0, baked, 0.8);

        float sunLight = max(dot(n, uSunDir), 0.0) * smoothstep(-0.04, 0.12, uSunDir.y);
        float moonLight = max(dot(n, MOON_DIR), 0.0) * (1.0 - uDay);
        vec3 ambient = mix(vec3(0.020, 0.030, 0.050), vec3(0.24, 0.29, 0.36), uDay);
        vec3 light = sunColor() * sunLight * 1.45 + vec3(0.10, 0.13, 0.20) * moonLight + ambient * (0.55 + 0.45 * n.y);
        vec3 col = albedo * light;

        // City lights where the imagery is bright and grey on the lowland: the real urban fabric.
        float lum = dot(albedo, vec3(0.2126, 0.7152, 0.0722));
        float peak = max(albedo.r, max(albedo.g, albedo.b));
        float saturation = (peak - min(albedo.r, min(albedo.g, albedo.b))) / max(peak, 1e-3);
        float urban = smoothstep(0.06, 0.16, lum) * (1.0 - smoothstep(0.15, 0.32, saturation));
        urban *= (1.0 - smoothstep(80.0, 400.0, h)) * smoothstep(0.9, 0.98, n.y);
        float grain = hash12(floor(vWorld.xz * 30.0));
        vec3 sodium = vec3(1.0, 0.62, 0.28) * urban * (0.35 + 0.9 * grain);
        col += sodium * 1.6 * (1.0 - smoothstep(0.0, 0.45, uDay));

        col = applyFog(col, vWorld);
        // Engineering mode: cartographic contours, 200 m and 1000 m index lines.
        float lines = contour(h, 200.0) * 0.5 + contour(h, 1000.0);
        col = mix(col, vec3(0.1, 0.9, 1.0) * lines + col * 0.25, uDebug);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }
    `,
  })
}

export function Terrain() {
  const gl = useThree((s) => s.gl)
  const { scene } = useGLTF(TERRAIN_URL)
  const [imagery, normals] = useTexture([IMAGERY_URL, NORMALS_URL], ([color, normal]) => {
    for (const t of [color, normal]) {
      t.flipY = false
      t.anisotropy = Math.min(8, gl.capabilities.getMaxAnisotropy())
    }
    color.colorSpace = THREE.SRGBColorSpace
  })
  const material = useMemo(() => createMaterial(imagery, normals), [imagery, normals])
  const model = useMemo(() => {
    let m: THREE.Mesh | undefined
    scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) m = o as THREE.Mesh
    })
    if (!m) throw new Error('terrain.glb: no mesh')
    m.material = material
    return scene
  }, [scene, material])
  return <primitive object={model} name="terrain" />
}

useGLTF.preload(TERRAIN_URL)
