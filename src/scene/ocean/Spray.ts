import * as THREE from 'three'
import { ATMOSPHERE_GLSL, atmosphere } from '../atmosphere'
import type { WaveSimulation } from './WaveSimulation'

// Spray torn from breaking crests in a gale (spindrift): droplets thrown up off the crests that
// break, carried downwind and falling back within a second or two. Stateless: each particle loops
// through short lives, each born at a fresh spot in a square around the eye, and shows only when
// that spot is a crest breaking now, read from the same wave fields the sea is drawn with.

const COUNT = 20000
/** Side of the square around the eye that spray fills, m. */
const SPAN = 160
/** Particles per plume. */
const BURST = 12
/** Above this altitude (km) spray is finer than a pixel and is not drawn. */
export const SPRAY_BELOW = 0.4

export function sprayGeometry(): THREE.BufferGeometry {
  const seeds = new Float32Array(COUNT * 3)
  for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random()
  const geometry = new THREE.BufferGeometry()
  // Positions are computed in the shader; the attribute only sets the count.
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(COUNT * 3), 3))
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3))
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity)
  return geometry
}

export function createSprayMaterial(waves: WaveSimulation, tileScale: THREE.Vector3) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      ...atmosphere,
      uDisp0: { value: waves.displacement[0] },
      uDisp1: { value: waves.displacement[1] },
      uTileScale: { value: tileScale },
      uEye: { value: new THREE.Vector2() },
      uSeaLevel: { value: 0 },
      // Direction the wind blows toward, world x and z, and its 10 m speed, m/s.
      uWind: { value: new THREE.Vector3(0, 1, 0) },
      uFoamThreshold: { value: 0.5 },
      // 0 (no spray) to 1 (a full gale's), from the wind speed.
      uAmount: { value: 0 },
      uPixelsPerRadian: { value: 1 },
    },
    vertexShader: /* glsl */ `
      ${ATMOSPHERE_GLSL}
      uniform sampler2D uDisp0;
      uniform sampler2D uDisp1;
      uniform vec3 uTileScale;
      uniform vec2 uEye;
      uniform float uSeaLevel;
      uniform vec3 uWind;
      uniform float uFoamThreshold;
      uniform float uAmount;
      uniform float uPixelsPerRadian;
      attribute vec3 aSeed;
      varying float vAlpha;
      varying vec3 vColor;

      vec2 hash2(vec2 p) {
        vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
        q += dot(q, q.yzx + 33.33);
        return fract((q.xx + q.yz) * q.zy);
      }

      void main() {
        // Particles go in bursts of ${BURST}, which share a birthplace and a life: one burst is the
        // plume torn off one crest.
        float burst = floor(aSeed.x * ${(COUNT / BURST).toFixed(1)});
        float life = 0.9 + fract(burst * 0.6180339) * 1.1;
        float clock = uTime / life + fract(burst * 0.7548777) * 17.0;
        float age = fract(clock) * life;
        // A fresh birthplace each life, in metres about the eye, the burst spread over a metre or two.
        vec2 birth = (hash2(vec2(burst * 0.131, floor(clock) * 7.31)) - 0.5) * ${SPAN.toFixed(1)};
        birth += (aSeed.yz - 0.5) * 1.6;
        vec2 xz = uEye + birth * 0.001;
        vec4 d0 = textureLod(uDisp0, xz * uTileScale.x, 0.0);
        vec4 d1 = textureLod(uDisp1, xz * uTileScale.y, 0.0);
        // Breaking where the surface folds, as the whitecaps are drawn.
        float J = 1.0 + (d0.w - 1.0) + (d1.w - 1.0);
        float breaking = clamp((uFoamThreshold - J) * 2.5, 0.0, 1.0);
        float shown = step(fract(burst * 0.5698403), breaking * uAmount);
        // Thrown up at a few m/s, carried at most of the wind's speed, falling under gravity.
        float up = 1.0 + 3.5 * aSeed.y;
        float rise = up * age - 4.9 * age * age;
        vec2 drift = uWind.xy * uWind.z * (0.3 + 0.4 * aSeed.z) * age;
        vec3 crest = vec3(xz.x * 1000.0 + d0.x + d1.x, d0.y + d1.y + uSeaLevel, xz.y * 1000.0 + d0.z + d1.z);
        vec3 world = (crest + vec3(drift.x, max(rise, -0.5), drift.y)) * 0.001;
        vec4 view = viewMatrix * vec4(world, 1.0);
        gl_Position = projectionMatrix * view;
        float dist = max(-view.z, 1e-4);
        // Wisps of droplets a few tenths of a metre across, spreading as they go.
        float size = (0.25 + 0.65 * age / life) * 0.001;
        gl_PointSize = shown * clamp(size / dist * uPixelsPerRadian, 0.0, 20.0);
        vAlpha = shown * smoothstep(0.0, 0.15, age) * (1.0 - smoothstep(0.4, 1.0, age / life)) * smoothstep(-0.5, 0.0, rise)
          // Gone before it would fill the lens.
          * smoothstep(0.004, 0.012, dist);
        vec3 lit = 0.9 / PI * (skyIrradiance() + sunIrradiance(0.0) * max(uSunDir.y, 0.0));
        vColor = aerialPerspective(lit, world) * uExposure;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      varying vec3 vColor;
      void main() {
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        float r = dot(p, p);
        if (r > 1.0) discard;
        gl_FragColor = vec4(vColor, vAlpha * 0.7 * exp(-2.5 * r));
        #include <colorspace_fragment>
      }
    `,
  })
}
