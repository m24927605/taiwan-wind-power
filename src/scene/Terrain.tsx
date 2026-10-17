import { useMemo } from 'react'
import * as THREE from 'three'
import type { Elevation } from '../data/elevation'
import { ELEVATION_SIZE, VERTICAL_EXAGGERATION, WORLD, lonLatToWorld } from '../geo/domain'
import { ATMOSPHERE_GLSL, atmosphere } from './atmosphere'

const STEP = 2
const EDGE_TAPER = 0.035

// Night-time city glow: lon, lat, radius km, intensity.
const CITIES: [number, number, number, number][] = [
  [121.53, 25.04, 13, 1.0], [121.45, 25.0, 16, 0.75], [121.74, 25.13, 5, 0.5], [121.3, 24.99, 12, 0.8],
  [120.97, 24.8, 8, 0.7], [120.82, 24.56, 5, 0.4], [120.68, 24.15, 14, 0.9], [120.54, 24.08, 7, 0.6],
  [120.68, 23.91, 5, 0.4], [120.54, 23.71, 5, 0.4], [120.45, 23.48, 6, 0.6], [120.21, 22.99, 11, 0.85],
  [120.31, 22.63, 14, 1.0], [120.49, 22.67, 6, 0.5], [121.75, 24.75, 6, 0.5], [121.6, 23.98, 5, 0.45],
  [121.14, 22.76, 4, 0.4], [119.57, 23.57, 3, 0.4], [119.0, 25.43, 8, 0.6], [119.38, 25.72, 6, 0.5],
]

function buildGeometry({ data }: Elevation): THREE.BufferGeometry {
  const n = ELEVATION_SIZE
  const m = Math.floor((n - 1) / STEP) + 1
  const positions = new Float32Array(m * m * 3)
  const elev = new Float32Array(m * m)
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < m; i++) {
      const u = i / (m - 1)
      const v = j / (m - 1)
      // Land sinks below the sea near the domain border so cropped coastlines end softly.
      const edge = Math.min(u, v, 1 - u, 1 - v) / EDGE_TAPER
      const taper = edge >= 1 ? 1 : edge * edge * (3 - 2 * edge)
      const raw = data[j * STEP * n + i * STEP]
      const h = raw > 0 ? raw * taper - (1 - taper) * 60 : raw
      const k = j * m + i
      positions[k * 3] = WORLD.minX + u * WORLD.width
      // Lift land a hair above the ocean plane and push the seabed down to avoid z-fighting.
      positions[k * 3 + 1] = (h * VERTICAL_EXAGGERATION) / 1000 + (h > 0 ? 0.004 : -0.02)
      positions[k * 3 + 2] = WORLD.minZ + v * WORLD.depth
      elev[k] = h
    }
  }
  // Keep only cells that touch land; the open sea is drawn by the ocean shader.
  const indices: number[] = []
  for (let j = 0; j < m - 1; j++) {
    for (let i = 0; i < m - 1; i++) {
      const a = j * m + i
      const b = a + 1
      const c = a + m
      const d = c + 1
      if (Math.max(elev[a], elev[b], elev[c], elev[d]) > -10) indices.push(a, c, b, b, c, d)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  g.setAttribute('elevation', new THREE.BufferAttribute(elev, 1))
  g.setIndex(indices)
  g.computeVertexNormals()
  g.computeBoundingSphere()
  return g
}

function createMaterial() {
  const cities = CITIES.map(([lon, lat, r, k]) => {
    const [x, z] = lonLatToWorld(lon, lat)
    return new THREE.Vector4(x, z, r, k)
  })
  return new THREE.ShaderMaterial({
    uniforms: { ...atmosphere, uCities: { value: cities } },
    vertexShader: /* glsl */ `
      attribute float elevation;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vElev;
      void main() {
        vWorld = position;
        vNormal = normal;
        vElev = elevation;
        gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      ${ATMOSPHERE_GLSL}
      uniform vec4 uCities[${CITIES.length}];
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vElev;

      vec3 srgb(vec3 c) { return pow(c, vec3(2.2)); }

      vec3 ramp(float h) {
        vec3 c = srgb(vec3(0.73, 0.67, 0.54));
        c = mix(c, srgb(vec3(0.46, 0.53, 0.35)), smoothstep(1.0, 8.0, h));
        c = mix(c, srgb(vec3(0.31, 0.42, 0.27)), smoothstep(120.0, 700.0, h));
        c = mix(c, srgb(vec3(0.21, 0.32, 0.24)), smoothstep(900.0, 2000.0, h));
        c = mix(c, srgb(vec3(0.37, 0.35, 0.29)), smoothstep(2300.0, 3100.0, h));
        c = mix(c, srgb(vec3(0.72, 0.70, 0.66)), smoothstep(3450.0, 3800.0, h));
        return c;
      }

      float contour(float h, float interval) {
        float c = h / interval;
        float w = fwidth(c);
        float line = 1.0 - min(abs(fract(c - 0.5) - 0.5) / max(w, 1e-4), 1.0);
        return line * (1.0 - smoothstep(0.15, 0.45, w));
      }

      void main() {
        vec3 n = normalize(vNormal);
        float h = vElev;
        vec3 albedo = ramp(h);
        albedo = mix(albedo, srgb(vec3(0.42, 0.39, 0.33)), smoothstep(0.82, 0.55, n.y) * smoothstep(300.0, 1200.0, h));

        float sunLight = max(dot(n, uSunDir), 0.0) * smoothstep(-0.04, 0.12, uSunDir.y);
        float moonLight = max(dot(n, MOON_DIR), 0.0) * (1.0 - uDay);
        vec3 ambient = mix(vec3(0.020, 0.030, 0.050), vec3(0.17, 0.21, 0.27), uDay);
        vec3 light = sunColor() * sunLight * 1.55 + vec3(0.10, 0.13, 0.20) * moonLight + ambient * (0.6 + 0.4 * n.y);
        vec3 col = albedo * light;

        // Cartographic contours: 200 m lines, 1000 m index lines.
        float lines = contour(h, 200.0) * 0.5 + contour(h, 1000.0);
        vec3 lineTint = mix(vec3(0.25, 0.75, 0.85) * 0.05, col * 0.55, uDay);
        col = mix(col, lineTint, clamp(lines, 0.0, 1.0) * step(5.0, h) * 0.55);

        // City lights: warm sodium glow in the lowlands, broken up into a street-like grain.
        float glow = 0.0;
        for (int i = 0; i < ${CITIES.length}; i++) {
          vec2 d = vWorld.xz - uCities[i].xy;
          float r = uCities[i].z * 0.6;
          glow += uCities[i].w * exp(-dot(d, d) / (r * r));
        }
        float grain = hash12(floor(vWorld.xz * 9.0));
        float street = smoothstep(0.55, 0.95, grain) * smoothstep(0.08, 0.6, glow);
        glow = glow * 0.12 + street * 0.9;
        glow *= 1.0 - smoothstep(120.0, 450.0, h);
        col += vec3(1.0, 0.6, 0.26) * glow * (1.0 - smoothstep(0.0, 0.45, uDay));

        col = applyFog(col, vWorld);
        col = mix(col, vec3(0.1, 0.9, 1.0) * lines + col * 0.25, uDebug);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }
    `,
  })
}

export function Terrain({ elevation }: { elevation: Elevation }) {
  const geometry = useMemo(() => buildGeometry(elevation), [elevation])
  const material = useMemo(() => createMaterial(), [])
  return <mesh geometry={geometry} material={material} name="terrain" />
}
