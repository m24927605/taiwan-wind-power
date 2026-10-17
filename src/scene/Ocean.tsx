import { useMemo } from 'react'
import * as THREE from 'three'
import type { Elevation } from '../data/elevation'
import { WORLD } from '../geo/domain'
import { ATMOSPHERE_GLSL, atmosphere } from './atmosphere'

const SIZE = 8000

function createMaterial(elevation: Elevation) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...atmosphere,
      uElevation: { value: elevation.texture },
      uDomain: { value: new THREE.Vector4(WORLD.minX, WORLD.minZ, WORLD.width, WORLD.depth) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      ${ATMOSPHERE_GLSL}
      uniform sampler2D uElevation;
      uniform vec4 uDomain;
      varying vec3 vWorld;

      vec3 srgb(vec3 c) { return pow(c, vec3(2.2)); }

      // Seabed elevation in metres (x) and how far inside the data domain we are (y, 0..1).
      vec2 seabed(vec2 xz) {
        vec2 uv = (xz - uDomain.xy) / uDomain.zw;
        vec2 e = min(uv, 1.0 - uv);
        float inside = smoothstep(0.0, 0.09, min(e.x, e.y));
        float h = texture2D(uElevation, clamp(uv, 0.0, 1.0)).r * 1000.0;
        return vec2(mix(-2500.0, min(h, 0.0), inside), inside);
      }

      vec3 waterColor(float depth) {
        float t = log(1.0 + depth) / log(6000.0);
        vec3 c = srgb(vec3(0.22, 0.55, 0.54));
        c = mix(c, srgb(vec3(0.09, 0.36, 0.44)), smoothstep(0.30, 0.48, t));
        c = mix(c, srgb(vec3(0.04, 0.22, 0.38)), smoothstep(0.50, 0.66, t));
        c = mix(c, srgb(vec3(0.02, 0.11, 0.25)), smoothstep(0.68, 0.86, t));
        c = mix(c, srgb(vec3(0.012, 0.06, 0.15)), smoothstep(0.88, 1.0, t));
        return c;
      }

      // Analytic slope of a sum of directional waves, band-limited by pixel footprint.
      vec2 waveSlope(vec2 p, float footprint) {
        vec2 s = vec2(0.0);
        float t = uTime;
        const int N = 6;
        vec3 waves[N];
        waves[0] = vec3(0.90, 0.42, 0.42);  // dir.x, dir.y, wavelength km
        waves[1] = vec3(0.62, 0.78, 0.23);
        waves[2] = vec3(0.98, -0.2, 0.13);
        waves[3] = vec3(0.30, 0.95, 0.071);
        waves[4] = vec3(0.80, -0.6, 0.043);
        waves[5] = vec3(-0.2, 0.98, 0.027);
        for (int i = 0; i < N; i++) {
          vec2 d = normalize(waves[i].xy);
          float L = waves[i].z;
          float k = 6.2831 / L;
          float c = sqrt(9.81 * 0.001 / k) * 18.0;
          float atten = exp(-footprint / L * 1.6);
          s += d * cos(dot(d, p) * k - t * c * k + hash12(vec2(float(i))) * 6.2831) * 0.045 * atten;
        }
        return s;
      }

      float isobath(float depth, float interval) {
        float c = depth / interval;
        float w = fwidth(c);
        float line = 1.0 - min(abs(fract(c - 0.5) - 0.5) / max(w, 1e-4), 1.0);
        return line * (1.0 - smoothstep(0.1, 0.4, w));
      }

      void main() {
        vec3 toCam = uCameraPos - vWorld;
        float dist = length(toCam);
        vec3 V = toCam / dist;
        vec2 bed = seabed(vWorld.xz);
        float depth = -bed.x;
        float footprint = length(fwidth(vWorld.xz));

        vec2 slope = waveSlope(vWorld.xz, footprint);
        vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));

        float lit = mix(0.04, 1.0, uDay);
        vec3 body = waterColor(depth) * lit;
        body *= 0.85 + 0.3 * max(dot(N, uSunDir), 0.0) * uDay;

        vec3 R = reflect(-V, N);
        R.y = abs(R.y);
        float fresnel = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
        vec3 col = mix(body, skyColor(R), fresnel * 0.85);

        float sunSpec = pow(max(dot(R, uSunDir), 0.0), 600.0) * 30.0 + pow(max(dot(R, uSunDir), 0.0), 40.0) * 0.25;
        col += sunColor() * sunSpec * smoothstep(-0.02, 0.06, uSunDir.y);
        float moonSpec = pow(max(dot(R, MOON_DIR), 0.0), 300.0) * 4.0 + pow(max(dot(R, MOON_DIR), 0.0), 18.0) * 0.06;
        col += vec3(0.75, 0.82, 1.0) * moonSpec * (1.0 - uDay);

        // Surf where the seabed shoals, drifting shoreward.
        float shore = 1.0 - smoothstep(0.0, 22.0, depth);
        float foam = smoothstep(0.55, 1.0, sin(depth * 0.55 + uTime * 1.4) * 0.5 + 0.5) * shore;
        foam *= smoothstep(0.35, 0.8, hash12(floor(vWorld.xz * 40.0)));
        col = mix(col, vec3(0.85, 0.9, 0.92) * (0.15 + 0.85 * lit), foam * 0.45 + shore * 0.08);

        // Cartographic isobaths: 50 m on the shelf, 500 m on the slope.
        float lines = isobath(depth, 50.0) * (1.0 - smoothstep(150.0, 300.0, depth)) + isobath(depth, 500.0) * 0.8;
        lines *= smoothstep(0.5, 1.0, bed.y);
        col = mix(col, mix(vec3(0.3, 0.8, 0.95) * 0.12, col * 1.35 + 0.02, uDay), lines * 0.35);

        col = applyFog(col, vWorld);
        col = mix(col, vec3(0.02, 0.05, 0.09) + vec3(0.1, 0.9, 1.0) * lines * 0.6, uDebug);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }
    `,
  })
}

export function Ocean({ elevation }: { elevation: Elevation }) {
  const material = useMemo(() => createMaterial(elevation), [elevation])
  return (
    <mesh rotation-x={-Math.PI / 2} material={material} name="ocean">
      <planeGeometry args={[SIZE, SIZE, 1, 1]} />
    </mesh>
  )
}
