import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useState } from 'react'
import * as THREE from 'three'
import type { Elevation } from '../../data/elevation'
import { seaAt, type SeaComponent } from '../../data/weather'
import { WORLD } from '../../geo/domain'
import { useStore } from '../../state'
import { ATMOSPHERE_GLSL, atmosphere } from '../atmosphere'
import { CLOUDS_GLSL, clouds } from '../clouds'
import { farmDynamics } from '../turbine/dynamics'
import { CASCADES, WaveSimulation, type SeaState } from './WaveSimulation'

/** Until the forecast arrives: a moderate north-east monsoon sea over a long swell. */
const DEFAULT_SEA: SeaState = {
  windSea: { hs: 1.0, tp: 5.5, toward: (225 * Math.PI) / 180 },
  swell: { hs: 0.8, tp: 9, toward: (215 * Math.PI) / 180 },
}
/** Log-law reduction from the 100 m hub-height wind to the 10 m wind that raises whitecaps. */
const HUB_TO_10M = 0.78
/** Mean (Tm01) to peak period for a JONSWAP spectrum with γ = 3.3. */
const MEAN_TO_PEAK_PERIOD = 1 / 0.83
/** Kilometres per metre of wave: life size, like the turbines around a camera near the sea. */
const WAVE_SCALE = 0.001

// Radial grid around the eye, rings spaced in proportion to their radius: about 10 m apart under
// the camera, out to well past the domain.
const GRID_RINGS = 540
const GRID_SEGMENTS = 256
const GRID_GROWTH = 1.0245
const GRID_INNER = 0.01

function oceanGeometry(): THREE.BufferGeometry {
  const positions = new Float32Array((GRID_RINGS + 1) * GRID_SEGMENTS * 3)
  for (let j = 0; j <= GRID_RINGS; j++) {
    const r = GRID_INNER * (GRID_GROWTH ** j - 1)
    for (let i = 0; i < GRID_SEGMENTS; i++) {
      const a = (i / GRID_SEGMENTS) * 2 * Math.PI
      positions.set([r * Math.cos(a), 0, r * Math.sin(a)], (j * GRID_SEGMENTS + i) * 3)
    }
  }
  const index = new Uint32Array(GRID_RINGS * GRID_SEGMENTS * 6)
  for (let j = 0, k = 0; j < GRID_RINGS; j++) {
    for (let i = 0; i < GRID_SEGMENTS; i++, k += 6) {
      const a = j * GRID_SEGMENTS + i
      const b = j * GRID_SEGMENTS + ((i + 1) % GRID_SEGMENTS)
      index.set([a, b, a + GRID_SEGMENTS, b, b + GRID_SEGMENTS, a + GRID_SEGMENTS], k)
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setIndex(new THREE.BufferAttribute(index, 1))
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity)
  return geometry
}

const SEABED_GLSL = /* glsl */ `
  uniform sampler2D uElevation;
  uniform vec4 uDomain;
  // Seabed elevation in metres (x) and how far inside the data domain we are (y, 0..1).
  vec2 seabed(vec2 xz) {
    vec2 uv = (xz - uDomain.xy) / uDomain.zw;
    vec2 e = min(uv, 1.0 - uv);
    float inside = smoothstep(0.0, 0.09, min(e.x, e.y));
    float h = textureLod(uElevation, clamp(uv, 0.0, 1.0), 0.0).r * 1000.0;
    return vec2(mix(-2500.0, min(h, 0.0), inside), inside);
  }
`

function createMaterial(elevation: Elevation, waves: WaveSimulation, n: number) {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: {
      ...atmosphere,
      ...clouds,
      uElevation: { value: elevation.texture },
      uDomain: { value: new THREE.Vector4(WORLD.minX, WORLD.minZ, WORLD.width, WORLD.depth) },
      uDisp0: { value: waves.displacement[0] },
      uDisp1: { value: waves.displacement[1] },
      uDisp2: { value: waves.displacement[2] },
      uSurf0: { value: waves.surface[0] },
      uSurf1: { value: waves.surface[1] },
      uSurf2: { value: waves.surface[2] },
      // Tiles per world unit (km) for each cascade.
      uTileScale: { value: new THREE.Vector3(...CASCADES.map((l) => 1 / (l * WAVE_SCALE))) },
      uOrigin: { value: new THREE.Vector2() },
      uFoamThreshold: { value: 0.5 },
      uMicroVariance: { value: 0.004 },
      uHs: { value: 1 },
    },
    vertexShader: /* glsl */ `
      ${SEABED_GLSL}
      uniform sampler2D uDisp0;
      uniform sampler2D uDisp1;
      uniform sampler2D uDisp2;
      uniform vec3 uTileScale;
      uniform vec2 uOrigin;
      varying vec3 vWorld;
      varying vec2 vXZ;
      varying float vHeight;
      void main() {
        vec2 xz = position.xz + uOrigin;
        // Each cascade is read at the mip matching the local grid spacing, so far rings stay calm
        // instead of aliasing.
        float spacing = ${(GRID_GROWTH - 1).toFixed(4)} * (length(position.xz) + ${GRID_INNER.toFixed(3)});
        vec3 lod = log2(max(spacing * ${n.toFixed(1)} * uTileScale, 1.0));
        vec3 d = textureLod(uDisp0, xz * uTileScale.x, lod.x).xyz + textureLod(uDisp1, xz * uTileScale.y, lod.y).xyz
          + textureLod(uDisp2, xz * uTileScale.z, lod.z).xyz;
        // Waves lie down in the shallows, so they never climb the coast.
        d *= smoothstep(1.0, 20.0, -seabed(xz).x);
        vHeight = d.y;
        d *= ${WAVE_SCALE.toFixed(5)};
        vec3 w = vec3(xz.x + d.x, d.y, xz.y + d.z);
        vWorld = w;
        vXZ = xz;
        gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      ${ATMOSPHERE_GLSL}
      ${CLOUDS_GLSL}
      ${SEABED_GLSL}
      uniform sampler2D uDisp0;
      uniform sampler2D uDisp1;
      uniform sampler2D uDisp2;
      uniform sampler2D uSurf0;
      uniform sampler2D uSurf1;
      uniform sampler2D uSurf2;
      uniform vec3 uTileScale;
      uniform float uFoamThreshold;
      uniform float uMicroVariance;
      uniform float uHs;
      varying vec3 vWorld;
      varying vec2 vXZ;
      varying float vHeight;

      vec3 srgb(vec3 c) { return pow(c, vec3(2.2)); }

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
        vec2 bed = seabed(vXZ);
        float depth = -bed.x;
        float footprint = length(fwidth(vXZ));

        // Filtered wave slopes. Mip averaging flattens the mean slope with distance while the
        // second moment keeps what was averaged away, so far water turns rough, not mirror-flat.
        // A cascade whose tile spans only a dozen pixels would read as a repeating grid, so it
        // hands its slopes over to roughness before that point.
        vec4 s0 = texture(uSurf0, vXZ * uTileScale.x);
        vec4 s1 = texture(uSurf1, vXZ * uTileScale.y);
        vec4 s2 = texture(uSurf2, vXZ * uTileScale.z);
        vec3 resolved = 1.0 - smoothstep(vec3(1.0 / 40.0), vec3(1.0 / 10.0), footprint * uTileScale);
        vec2 slope = s0.xy * resolved.x + s1.xy * resolved.y + s2.xy * resolved.z;
        vec3 total = vec3(s0.z, s1.z, s2.z);
        vec3 mean = vec3(dot(s0.xy, s0.xy), dot(s1.xy, s1.xy), dot(s2.xy, s2.xy));
        float variance = dot(max(total - mean * resolved, 0.0), vec3(1.0)) + uMicroVariance;
        vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));
        float NoV = max(dot(N, V), 0.02);

        vec3 sun = sunIrradiance(0.0) * cloudShadow(vWorld);
        vec3 downwelling = skyIrradiance() + sun * max(uSunDir.y, 0.0);
        // Light scattered back up out of the water column: a reflectance of a few per cent.
        vec3 body = waterColor(depth) * downwelling * 0.135;
        // Light through the thin, raised crests of waves seen against the sun.
        float crest = clamp(vHeight / max(uHs, 0.25) * 0.7 + 0.45, 0.0, 1.6);
        body += srgb(vec3(0.08, 0.42, 0.40)) * sun * crest * resolved.x
          * (0.35 * pow(max(dot(uSunDir, -V), 0.0), 4.0) * pow(0.5 - 0.5 * dot(uSunDir, N), 3.0) + 0.02 * NoV * NoV * max(uSunDir.y, 0.0));

        vec3 R = reflect(-V, N);
        R.y = abs(R.y);
        float fresnel = 0.02 + 0.98 * pow(1.0 - NoV, 5.0);
        // Unresolved roughness hides part of the grazing reflection behind neighbouring facets.
        fresnel /= 1.0 + 4.0 * variance;
        // The reflected lobe spans about sqrt(variance) radians; a base-level texel spans 2 pi / 256.
        vec3 col = mix(body, groundEnvRadiance(R, clamp(log2(sqrt(variance) * 40.7), 0.0, 7.0)), fresnel);

        // Sun glitter: microfacet specular over the full slope distribution.
        vec3 H = normalize(V + uSunDir);
        float NoL = dot(N, uSunDir);
        float Fh = 0.02 + 0.98 * pow(1.0 - max(dot(H, V), 0.0), 5.0);
        float spec = beckmann(max(dot(N, H), 1e-3), variance) * Fh / (4.0 * NoV) * step(0.0, NoL);
        col += sun * min(spec, 400.0);

        // Whitecaps where the folds of all cascades add up, the trails they leave, and
        // depth-limited breaking on the shoals, which spill once waves grow to a fraction of the depth.
        float J = 1.0 + (texture(uDisp0, vXZ * uTileScale.x).w - 1.0) * resolved.x
          + (texture(uDisp1, vXZ * uTileScale.y).w - 1.0) * resolved.y + (texture(uDisp2, vXZ * uTileScale.z).w - 1.0) * resolved.z;
        // Breakers need water: the surf zone is where waves reach a fraction of the depth, not the
        // wet flats of the shallowest shore, which the bathymetry grid reads as almost no depth.
        float breaking = smoothstep(0.4, 0.9, uHs / max(depth, 0.1)) * smoothstep(0.2, 0.8, depth);
        float whitecap = clamp((uFoamThreshold - J) * 2.5, 0.0, 1.0);
        // Surf shows its pattern only where the waves are resolved; farther out, where the pattern
        // is finer than a pixel and would shimmer from frame to frame, it is its average cover.
        float surf = clamp((uFoamThreshold + 0.9 - J) * 2.5, 0.0, 1.0) * breaking * resolved.x + breaking * 0.3 * (1.0 - resolved.x);
        float foam = max(max(whitecap, surf), s0.w * resolved.x + s1.w * 0.7 * resolved.y + s2.w * 0.4 * resolved.z);
        col = mix(col, 0.9 / PI * (downwelling + sun * max(dot(N, uSunDir), 0.0) * 0.3), foam * 0.9);

        // Cartographic isobaths: 50 m on the shelf, 500 m on the slope, only in the map view.
        float lines = isobath(depth, 50.0) * (1.0 - smoothstep(150.0, 300.0, depth)) + isobath(depth, 500.0) * 0.8;
        lines *= smoothstep(0.5, 1.0, bed.y) * smoothstep(0.004, 0.03, footprint);
        // The night tint is given in display units, so it reads under any exposure.
        col = mix(col, mix(vec3(0.3, 0.8, 0.95) * 0.12 / uExposure, col * 1.12, uDay), lines * 0.22);

        col = aerialPerspective(col, vWorld) * uExposure;
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

  const material = useMemo(() => waves && createMaterial(elevation, waves, waveResolution), [elevation, waves, waveResolution])
  useEffect(() => () => material?.dispose(), [material])
  const geometry = useMemo(oceanGeometry, [])
  useEffect(() => () => geometry.dispose(), [geometry])

  useFrame(({ camera }, dt) => {
    if (!waves || !material) return
    const { weather, time } = useStore.getState()
    let sea = DEFAULT_SEA
    if (weather) {
      const { windSea, swell } = seaAt(weather, time)
      // Quantised so the spectrum normalisation only reruns when the forecast actually moves.
      const component = (c: SeaComponent) => ({
        hs: Math.round(c.hs * 50) / 50,
        tp: Math.max(Math.round(c.tm * MEAN_TO_PEAK_PERIOD * 20) / 20, 1.5),
        toward: Math.round((c.fromRad + Math.PI) * 200) / 200,
      })
      sea = { windSea: component(windSea), swell: component(swell) }
    }
    waves.setSeaState(sea)

    let wind = 0
    for (const w of farmDynamics.wind) wind += w
    const u10 = (wind / farmDynamics.wind.length) * HUB_TO_10M
    // Whitecaps start around 4 m/s and spread steeply with wind (Monahan); micro-roughness follows Cox–Munk.
    const whitecaps = THREE.MathUtils.smoothstep(u10, 3, 20)
    waves.update(gl, atmosphere.uTime.value, Math.min(dt, 0.1), whitecaps)

    const u = material.uniforms
    u.uSurf0.value = waves.surface[0]
    u.uSurf1.value = waves.surface[1]
    u.uSurf2.value = waves.surface[2]
    u.uHs.value = Math.hypot(sea.windSea.hs, sea.swell.hs)
    u.uFoamThreshold.value = THREE.MathUtils.lerp(0.3, 1.0, whitecaps)
    u.uMicroVariance.value = 0.002 + 0.0012 * u10
    // The grid follows the eye in whole metres so its vertices do not swim through the waves.
    u.uOrigin.value.set(Math.round(camera.position.x * 1000) / 1000, Math.round(camera.position.z * 1000) / 1000)
  }, -10)

  if (!material) return null
  return <mesh geometry={geometry} material={material} frustumCulled={false} name="ocean" />
}
