import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useState } from 'react'
import * as THREE from 'three'
import type { Elevation } from '../../data/elevation'
import { seaAt } from '../../data/weather'
import { WORLD } from '../../geo/domain'
import { useStore } from '../../state'
import { ATMOSPHERE_GLSL, atmosphere } from '../atmosphere'
import { farmDynamics } from '../turbine/dynamics'
import { CASCADES, WaveSimulation, type SeaState } from './WaveSimulation'

const SIZE = 8000
/** Until the forecast arrives: a moderate north-east monsoon sea. */
const DEFAULT_SEA: SeaState = { hs: 1.2, tp: 6.5, toward: (225 * Math.PI) / 180 }
/** Log-law reduction from the 100 m hub-height wind to the 10 m wind that raises whitecaps. */
const HUB_TO_10M = 0.78
/** Mean (Tm01) to peak period for a JONSWAP spectrum with γ = 3.3. */
const MEAN_TO_PEAK_PERIOD = 1 / 0.83

function createMaterial(elevation: Elevation, waves: THREE.Texture[]) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...atmosphere,
      uElevation: { value: elevation.texture },
      uDomain: { value: new THREE.Vector4(WORLD.minX, WORLD.minZ, WORLD.width, WORLD.depth) },
      uWave0: { value: waves[0] },
      uWave1: { value: waves[1] },
      uWave2: { value: waves[2] },
      // World units are km; cascade tiles are in metres.
      uTileScale: { value: new THREE.Vector3(...CASCADES.map((l) => 1000 / l)) },
      uFoamThreshold: { value: -1 },
      uMicroVariance: { value: 0.004 },
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
      uniform sampler2D uWave0;
      uniform sampler2D uWave1;
      uniform sampler2D uWave2;
      uniform vec3 uTileScale;
      uniform float uFoamThreshold;
      uniform float uMicroVariance;
      varying vec3 vWorld;

      const float PI = 3.141592653589793;

      vec3 srgb(vec3 c) { return pow(c, vec3(2.2)); }

      // Seabed elevation in metres (x) and how far inside the data domain we are (y, 0..1).
      vec2 seabed(vec2 xz) {
        vec2 uv = (xz - uDomain.xy) / uDomain.zw;
        vec2 e = min(uv, 1.0 - uv);
        float inside = smoothstep(0.0, 0.09, min(e.x, e.y));
        float h = texture2D(uElevation, clamp(uv, 0.0, 1.0)).r * 1000.0;
        return vec2(mix(-2500.0, min(h, 0.0), inside), inside);
      }

      // Upwelling colour of the water column: turbid green over the shelf, Kuroshio indigo offshore.
      vec3 waterColor(float depth) {
        float t = log(1.0 + depth) / log(6000.0);
        vec3 c = srgb(vec3(0.17, 0.34, 0.31));
        c = mix(c, srgb(vec3(0.07, 0.22, 0.25)), smoothstep(0.30, 0.48, t));
        c = mix(c, srgb(vec3(0.03, 0.13, 0.22)), smoothstep(0.50, 0.66, t));
        c = mix(c, srgb(vec3(0.012, 0.06, 0.15)), smoothstep(0.68, 0.90, t));
        return c;
      }

      float isobath(float depth, float interval) {
        float c = depth / interval;
        float w = fwidth(c);
        float line = 1.0 - min(abs(fract(c - 0.5) - 0.5) / max(w, 1e-4), 1.0);
        return line * (1.0 - smoothstep(0.1, 0.4, w));
      }

      // Beckmann facet distribution for an isotropic slope variance m2.
      float beckmann(float NoH, float m2) {
        float c2 = NoH * NoH;
        return exp((c2 - 1.0) / (c2 * m2)) / (PI * m2 * c2 * c2);
      }

      void main() {
        vec3 toCam = uCameraPos - vWorld;
        float dist = length(toCam);
        vec3 V = toCam / dist;
        vec2 bed = seabed(vWorld.xz);
        float depth = -bed.x;
        float footprint = length(fwidth(vWorld.xz));

        // Filtered wave slopes. Mip averaging flattens the mean slope with distance while the
        // second moment keeps what was averaged away, so far water turns rough, not mirror-flat.
        // A cascade whose tile spans only a dozen pixels would read as a repeating grid, so it
        // hands its slopes over to roughness before that point.
        float metresPerPixel = footprint * 1000.0;
        vec4 w0 = texture2D(uWave0, vWorld.xz * uTileScale.x);
        vec4 w1 = texture2D(uWave1, vWorld.xz * uTileScale.y);
        vec4 w2 = texture2D(uWave2, vWorld.xz * uTileScale.z);
        vec3 resolved = 1.0 - smoothstep(vec3(1.0 / 48.0), vec3(1.0 / 12.0), metresPerPixel * uTileScale / 1000.0);
        vec2 slope = w0.xy * resolved.x + w1.xy * resolved.y + w2.xy * resolved.z;
        vec3 total = vec3(w0.z, w1.z, w2.z);
        vec3 mean = vec3(dot(w0.xy, w0.xy), dot(w1.xy, w1.xy), dot(w2.xy, w2.xy));
        float variance = dot(max(total - mean * resolved, 0.0), vec3(1.0)) + uMicroVariance;
        vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));
        float NoV = max(dot(N, V), 0.02);

        float sunUp = smoothstep(-0.04, 0.1, uSunDir.y);
        float lit = mix(0.035, 1.0, uDay);
        vec3 body = waterColor(depth) * lit * (0.75 + 0.25 * sunUp);

        // Light leaking through the thin crests of waves that face away from the sun.
        float back = pow(max(dot(V, -normalize(uSunDir + N * 0.6)), 0.0), 4.0);
        float crest = smoothstep(0.02, 0.25, length(slope));
        body += srgb(vec3(0.08, 0.42, 0.40)) * back * crest * sunUp * 0.6;

        vec3 R = reflect(-V, N);
        R.y = abs(R.y);
        float fresnel = 0.02 + 0.98 * pow(1.0 - NoV, 5.0);
        // Unresolved roughness hides part of the grazing reflection behind neighbouring facets.
        fresnel /= 1.0 + 4.0 * variance;
        vec3 col = mix(body, skyColor(R), fresnel);

        // Sun glitter: microfacet specular over the full slope distribution.
        vec3 H = normalize(V + uSunDir);
        float NoL = dot(N, uSunDir);
        float Fh = 0.02 + 0.98 * pow(1.0 - max(dot(H, V), 0.0), 5.0);
        float spec = beckmann(max(dot(N, H), 1e-3), variance) * Fh / (4.0 * NoV) * step(0.0, NoL);
        col += sunColor() * min(spec, 60.0) * 3.2 * sunUp;
        vec3 Hm = normalize(V + MOON_DIR);
        float moonSpec = beckmann(max(dot(N, Hm), 1e-3), variance) * 0.02 / (4.0 * NoV);
        col += vec3(0.75, 0.82, 1.0) * min(moonSpec, 30.0) * 0.12 * (1.0 - uDay);

        // Whitecaps where the choppy surface folds over (Jacobian below threshold).
        float foam = clamp((uFoamThreshold - w0.w) * 2.5, 0.0, 1.0) * resolved.x
          + clamp((uFoamThreshold - w1.w) * 2.5, 0.0, 1.0) * 0.6 * resolved.y
          + clamp((uFoamThreshold - w2.w) * 2.5, 0.0, 1.0) * 0.3 * resolved.z;

        // Surf where the seabed shoals, drifting shoreward.
        float shore = 1.0 - smoothstep(0.0, 22.0, depth);
        float surf = smoothstep(0.6, 1.0, sin(depth * 0.55 + uTime * 1.4) * 0.5 + 0.5) * shore;
        surf *= smoothstep(0.35, 0.8, hash12(floor(vWorld.xz * 40.0)));
        // Surf breaks on a scale of metres; from altitude it would only read as speckle.
        foam = clamp(foam + (surf * 0.6 + shore * 0.05) * (1.0 - smoothstep(0.01, 0.06, footprint)), 0.0, 1.0);
        vec3 foamLight = sunColor() * max(uSunDir.y, 0.0) * 0.9 + mix(vec3(0.02, 0.03, 0.05), vec3(0.35, 0.42, 0.5), uDay);
        col = mix(col, vec3(0.92, 0.95, 0.96) * foamLight, foam * 0.85);

        // Cartographic isobaths: 50 m on the shelf, 500 m on the slope, only in the map view.
        float lines = isobath(depth, 50.0) * (1.0 - smoothstep(150.0, 300.0, depth)) + isobath(depth, 500.0) * 0.8;
        lines *= smoothstep(0.5, 1.0, bed.y) * smoothstep(0.004, 0.03, footprint);
        col = mix(col, mix(vec3(0.3, 0.8, 0.95) * 0.12, col * 1.12 + 0.01, uDay), lines * 0.22);

        col = applyFog(col, vWorld);
        col = mix(col, vec3(0.02, 0.05, 0.09) + vec3(0.1, 0.9, 1.0) * lines * 0.6 + vec3(0.6) * foam, uDebug);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }
    `,
  })
}

export function Ocean({ elevation, waveResolution }: { elevation: Elevation; waveResolution: number }) {
  const gl = useThree((s) => s.gl)
  // GPU resources live and die in one effect, so StrictMode's double mount cannot orphan them.
  const [waves, setWaves] = useState<WaveSimulation | null>(null)
  useEffect(() => {
    const sim = new WaveSimulation(gl, waveResolution)
    setWaves(sim)
    return () => sim.dispose()
  }, [gl, waveResolution])

  const material = useMemo(() => waves && createMaterial(elevation, waves.textures), [elevation, waves])
  useEffect(() => () => material?.dispose(), [material])

  useFrame(() => {
    if (!waves || !material) return
    const { weather, time } = useStore.getState()
    let sea = DEFAULT_SEA
    if (weather) {
      const s = seaAt(weather, time)
      // Quantised so the spectrum normalisation only reruns when the forecast actually moves.
      sea = {
        hs: Math.max(Math.round(s.hs * 50) / 50, 0.1),
        tp: Math.max(Math.round(s.tm * MEAN_TO_PEAK_PERIOD * 20) / 20, 2),
        toward: Math.round((s.fromRad + Math.PI) * 200) / 200,
      }
    }
    waves.setSeaState(sea)
    waves.update(gl, atmosphere.uTime.value)

    let wind = 0
    for (const w of farmDynamics.wind) wind += w
    const u10 = (wind / farmDynamics.wind.length) * HUB_TO_10M
    // Whitecaps start around 4 m/s and spread with wind (Monahan); micro-roughness follows Cox–Munk.
    material.uniforms.uFoamThreshold.value = THREE.MathUtils.lerp(-0.4, 0.7, THREE.MathUtils.smoothstep(u10, 4, 16))
    material.uniforms.uMicroVariance.value = 0.002 + 0.0012 * u10
  }, -10)

  if (!material) return null
  return (
    <mesh rotation-x={-Math.PI / 2} material={material} name="ocean">
      <planeGeometry args={[SIZE, SIZE, 1, 1]} />
    </mesh>
  )
}
