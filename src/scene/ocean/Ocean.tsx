import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import type { Elevation } from '../../data/elevation'
import { seaAt, seaLevelAt, type SeaComponent } from '../../data/weather'
import { TIDAL_FLATS, WORLD, worldExtent } from '../../geo/domain'
import { useStore } from '../../state'
import { ATMOSPHERE_GLSL, atmosphere } from '../atmosphere'
import { CLOUDS_GLSL, clouds } from '../clouds'
import { windNear } from '../turbine/dynamics'
import { SPRAY_BELOW, createSprayMaterial, sprayGeometry } from './Spray'
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

const FLATS_WORLD = worldExtent(TIDAL_FLATS)
/** Until the tidal flats load, or if they fail to: none anywhere. */
const NO_FLATS = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1)
NO_FLATS.needsUpdate = true

const SEABED_GLSL = /* glsl */ `
  uniform sampler2D uElevation;
  uniform vec4 uDomain;
  uniform sampler2D uFlats;
  uniform vec4 uFlatsRect;
  // Sea level against mean sea level, tides included, m.
  uniform float uSeaLevel;
  // Seabed elevation in metres (x) and how far inside the data domain we are (y, 0..1).
  vec2 seabed(vec2 xz) {
    vec2 uv = (xz - uDomain.xy) / uDomain.zw;
    vec2 e = min(uv, 1.0 - uv);
    float inside = smoothstep(0.0, 0.09, min(e.x, e.y));
    float h = textureLod(uElevation, clamp(uv, 0.0, 1.0), 0.0).r * 1000.0;
    return vec2(mix(-2500.0, min(h, 0.0), inside), inside);
  }
  // The tidal flats (see TIDAL_FLATS): elevation about mean sea level in metres (x), and how much
  // of the texel is flat (y, 0..1), which fades their edges into the bathymetry.
  vec2 tidalFlat(vec2 xz) {
    vec2 uv = (xz - uFlatsRect.xy) / uFlatsRect.zw;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec2(${TIDAL_FLATS.min.toFixed(1)}, 0.0);
    float v = textureLod(uFlats, uv, 0.0).r * 255.0;
    return vec2(${TIDAL_FLATS.min.toFixed(1)} + max(v - 1.0, 0.0) / 254.0 * ${(TIDAL_FLATS.max - TIDAL_FLATS.min).toFixed(1)}, min(v, 1.0));
  }
`

function createMaterial(elevation: Elevation, flats: THREE.Texture, waves: WaveSimulation, n: number) {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: {
      ...atmosphere,
      ...clouds,
      uElevation: { value: elevation.texture },
      uDomain: { value: new THREE.Vector4(WORLD.minX, WORLD.minZ, WORLD.width, WORLD.depth) },
      uFlats: { value: flats },
      uFlatsRect: { value: new THREE.Vector4(FLATS_WORLD.minX, FLATS_WORLD.minZ, FLATS_WORLD.width, FLATS_WORLD.depth) },
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
      uFoamWind: { value: new THREE.Vector2(0, 1) },
      uSeaLevel: { value: 0 },
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
      // The fragment shader has a texture unit for the 40 m flats only if the 800 m bathymetry,
      // which loses nothing by it, is read per vertex.
      varying vec2 vBed;
      void main() {
        vec2 xz = position.xz + uOrigin;
        vBed = seabed(xz);
        vec2 flat_ = tidalFlat(xz);
        // Each cascade is read at the mip matching the local grid spacing, so far rings stay calm
        // instead of aliasing.
        float spacing = ${(GRID_GROWTH - 1).toFixed(4)} * (length(position.xz) + ${GRID_INNER.toFixed(3)});
        vec3 lod = log2(max(spacing * ${n.toFixed(1)} * uTileScale, 1.0));
        vec3 d = textureLod(uDisp0, xz * uTileScale.x, lod.x).xyz + textureLod(uDisp1, xz * uTileScale.y, lod.y).xyz
          + textureLod(uDisp2, xz * uTileScale.z, lod.z).xyz;
        // Waves lie down in the shallows, so they never climb the coast.
        // The bottom: the flats where they lie, else the bathymetry.
        d *= smoothstep(1.0, 20.0, uSeaLevel - mix(vBed.x, flat_.x, flat_.y));
        vHeight = d.y;
        d *= ${WAVE_SCALE.toFixed(5)};
        // The tide raises and lowers the whole surface; land stands above its range (see Terrain).
        vec3 w = vec3(xz.x + d.x, d.y + uSeaLevel * 0.001, xz.y + d.z);
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
      // Direction the wind sea travels, world x and z.
      uniform vec2 uFoamWind;
      varying vec3 vWorld;
      varying vec2 vXZ;
      varying float vHeight;
      varying vec2 vBed;

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

      // Value noise for the lace of foam. Coordinates wrap every 512 m to keep their precision.
      float hash(vec2 p) {
        vec3 q = fract(vec3(p.xyx) * 0.1031);
        q += dot(q, q.yzx + 33.33);
        return fract((q.x + q.y) * q.z);
      }
      float valueNoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
      }
      // Foam is not a haze over the water but patches and streaks of bubbles with water between:
      // where the eye can resolve them, thin cover is scattered lace and dense cover solid white,
      // drawn out downwind as gales draw it. Farther out, where the pattern is finer than a pixel,
      // it is its average.
      float lace(float cover, vec2 xz, float metresPerPixel) {
        vec2 m = mod(xz * 1000.0, 512.0);
        // Along and across the wind, stretched threefold along it.
        m = vec2(dot(m, uFoamWind), dot(m, vec2(-uFoamWind.y, uFoamWind.x)) * 3.0);
        float n = valueNoise(m / 4.0) * 0.55 + valueNoise(m / 1.2) * 0.3 + valueNoise(m / 0.4) * 0.15;
        // The noise gathers about its middle: spread it to roughly even cover.
        n = clamp((n - 0.5) * 2.2 + 0.5, 0.0, 1.0);
        float edge = max(0.04, metresPerPixel * 0.2);
        float density = cover * cover * (0.5 + 0.5 * cover);
        float pattern = smoothstep(n - edge, n + edge, cover * cover) * (0.5 + 0.5 * cover);
        return mix(pattern, density, smoothstep(0.3, 1.5, metresPerPixel));
      }

      void main() {
        vec3 toCam = uCameraPos - vWorld;
        float dist = length(toCam);
        vec3 V = toCam / dist;
        vec2 bed = vBed;
        vec2 flat_ = tidalFlat(vXZ);
        float depth = uSeaLevel - mix(bed.x, flat_.x, flat_.y);
        // Flats the tide has left: a few centimetres of fade at the water's edge.
        float exposed = smoothstep(-0.03, 0.03, flat_.x - uSeaLevel) * flat_.y;
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
        // Light scattered back up out of the water column: a reflectance of a few per cent of
        // what falls on the facet, so the faces of the waves turned toward the sun read brighter.
        vec3 body = waterColor(depth) * (skyIrradiance() + sun * max(dot(N, uSunDir), 0.0)) * 0.135;
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
        float foam = max(max(whitecap, surf), s0.w * resolved.x + s1.w * 0.7 * resolved.y + s2.w * 0.4 * resolved.z) * (1.0 - exposed);
        foam = lace(foam, vXZ, footprint * 1000.0);
        col = mix(col, 0.9 / PI * (downwelling + sun * max(dot(N, uSunDir), 0.0) * 0.3), foam * 0.9);

        // Exposed silt: dark and glossy with water just off it, paler where it has drained, with a
        // film of water mirroring the sky near the edge.
        float drained = smoothstep(0.0, 1.2, flat_.x - uSeaLevel);
        vec3 silt = mix(srgb(vec3(0.27, 0.27, 0.25)), srgb(vec3(0.45, 0.43, 0.39)), drained);
        vec3 mud = silt / PI * (sun * max(uSunDir.y, 0.0) + skyIrradiance());
        float film = (1.0 - drained) * (0.02 + 0.98 * pow(1.0 - max(V.y, 0.0), 5.0));
        mud = mix(mud, groundEnvRadiance(reflect(-V, vec3(0.0, 1.0, 0.0)), 3.0), film * 0.6);
        col = mix(col, mud, exposed);

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

  // The flats load beside the sea, which draws without them until they come.
  const [flats, setFlats] = useState<THREE.Texture>(NO_FLATS)
  useEffect(() => {
    let texture: THREE.Texture | undefined
    new THREE.TextureLoader().load(
      TIDAL_FLATS.url,
      (t) => {
        t.flipY = false
        t.generateMipmaps = false
        t.minFilter = THREE.LinearFilter
        texture = t
        setFlats(t)
      },
      undefined,
      (error) => console.error('[scene] tidal flats failed to load:', error),
    )
    return () => texture?.dispose()
  }, [])

  const material = useMemo(() => waves && createMaterial(elevation, flats, waves, waveResolution), [elevation, flats, waves, waveResolution])
  useEffect(() => () => material?.dispose(), [material])
  const geometry = useMemo(oceanGeometry, [])
  useEffect(() => () => geometry.dispose(), [geometry])
  const spray = useMemo(() => material && createSprayMaterial(waves!, material.uniforms.uTileScale.value), [material, waves])
  useEffect(() => () => spray?.dispose(), [spray])
  const sprayPoints = useMemo(sprayGeometry, [])
  useEffect(() => () => sprayPoints.dispose(), [sprayPoints])
  const size = useThree((s) => s.size)
  const sprayRef = useRef<THREE.Points>(null)

  useFrame(({ camera }, dt) => {
    if (!waves || !material || !spray) return
    const { weather, time } = useStore.getState()
    let sea = DEFAULT_SEA
    let level = 0
    if (weather) {
      level = seaLevelAt(weather, time, camera.position.x, camera.position.z)
      // The sea where the eye is: one wave field covers the view, and up close the local sea counts.
      const { windSea, swell } = seaAt(weather, time, camera.position.x, camera.position.z)
      // Quantised so the spectrum normalisation only reruns when the forecast actually moves.
      const component = (c: SeaComponent) => ({
        hs: Math.round(c.hs * 50) / 50,
        tp: Math.max(Math.round(c.tm * MEAN_TO_PEAK_PERIOD * 20) / 20, 1.5),
        toward: Math.round((c.fromRad + Math.PI) * 200) / 200,
      })
      sea = { windSea: component(windSea), swell: component(swell) }
    }
    waves.setSeaState(sea)

    const u10 = windNear(camera.position.x, camera.position.z) * HUB_TO_10M
    // Whitecaps start around 4 m/s and spread steeply with wind (Monahan); micro-roughness follows Cox–Munk.
    const whitecaps = THREE.MathUtils.smoothstep(u10, 3, 20)
    waves.update(gl, atmosphere.uTime.value, Math.min(dt, 0.1), whitecaps)

    const u = material.uniforms
    u.uSurf0.value = waves.surface[0]
    u.uSurf1.value = waves.surface[1]
    u.uSurf2.value = waves.surface[2]
    u.uHs.value = Math.hypot(sea.windSea.hs, sea.swell.hs)
    // World +x is east and -z north.
    u.uFoamWind.value.set(Math.sin(sea.windSea.toward), -Math.cos(sea.windSea.toward))
    u.uSeaLevel.value = level
    u.uFoamThreshold.value = THREE.MathUtils.lerp(0.3, 1.0, whitecaps)
    u.uMicroVariance.value = 0.002 + 0.0012 * u10
    // The grid follows the eye in whole metres so its vertices do not swim through the waves.
    u.uOrigin.value.set(Math.round(camera.position.x * 1000) / 1000, Math.round(camera.position.z * 1000) / 1000)

    const s = spray.uniforms
    s.uEye.value.set(camera.position.x, camera.position.z)
    s.uSeaLevel.value = level
    s.uWind.value.set(u.uFoamWind.value.x, u.uFoamWind.value.y, u10)
    s.uFoamThreshold.value = u.uFoamThreshold.value
    // Spindrift starts in a gale, Beaufort 8, and fills the air by a storm.
    s.uAmount.value = camera.position.y < SPRAY_BELOW ? THREE.MathUtils.smoothstep(u10, 14, 26) : 0
    if (sprayRef.current) sprayRef.current.visible = s.uAmount.value > 0
    s.uPixelsPerRadian.value = size.height / (2 * Math.tan(THREE.MathUtils.degToRad((camera as THREE.PerspectiveCamera).fov) / 2))
  }, -10)

  if (!material || !spray) return null
  return (
    <>
      <mesh geometry={geometry} material={material} frustumCulled={false} name="ocean" />
      <points ref={sprayRef} geometry={sprayPoints} material={spray} frustumCulled={false} name="spray" />
    </>
  )
}
