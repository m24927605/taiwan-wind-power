import * as THREE from 'three'
import { TURBINE } from './spec'

// Physically based shading for the turbine model with no textures. Each vertex brings its albedo,
// its surface (roughness, metalness, how much it weathers) and baked ambient occlusion
// (scripts/build-turbine.ts); this patch reads them into MeshStandardMaterial and adds the wear a
// marine paint system shows after a few years at sea, in model space so it stays put as the
// nacelle yaws and the rotor turns: tone variation, rain streaks down vertical faces, grime and
// salt in the splash zone, and the seams between the nacelle's panels.

const VERTEX_HEADER = /* glsl */ `
  attribute vec3 _surface;
  attribute float _ao;
  varying vec3 vSurface;
  varying float vAo;
  varying vec3 vModel;
  varying vec3 vModelNormal;
`

// Captured before any instancing, yaw or spin, so wear is fixed to the steel.
const VERTEX_CAPTURE = /* glsl */ `
  vSurface = _surface;
  vAo = _ao;
  vModel = position;
  vModelNormal = normal;
`

const FRAGMENT_HEADER = /* glsl */ `
  varying vec3 vSurface;
  varying float vAo;
  varying vec3 vModel;
  varying vec3 vModelNormal;

  float wearHash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float wearNoise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(wearHash(i), wearHash(i + vec3(1, 0, 0)), f.x), mix(wearHash(i + vec3(0, 1, 0)), wearHash(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(wearHash(i + vec3(0, 0, 1)), wearHash(i + vec3(1, 0, 1)), f.x), mix(wearHash(i + vec3(0, 1, 1)), wearHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }
  // Thin line at integer values of c, antialiased and faded once lines crowd below a pixel.
  float seam(float c) {
    float w = fwidth(c);
    return (1.0 - smoothstep(0.0, w * 1.5, abs(fract(c + 0.5) - 0.5))) * (1.0 - smoothstep(0.04, 0.2, w));
  }
`

const ALBEDO_WEAR = /* glsl */ `
  float wear = vSurface.z;
  vec3 wp = vModel;
  vec3 wn = normalize(vModelNormal);
  // Broad variation between panels and coats.
  diffuseColor.rgb *= 1.0 + (wearNoise(wp * 0.12) - 0.5) * 0.08 * wear;
  // Rain streaks: long vertical runs on steep faces, strongest under edges.
  vec2 across = normalize(vec2(-wn.z, wn.x) + 1e-5);
  float h = dot(wp.xz, across);
  float streak = wearNoise(vec3(h * 2.2, wp.y * 0.035, 1.7)) * wearNoise(vec3(h * 7.0, wp.y * 0.11, 5.3));
  streak = smoothstep(0.12, 0.55, streak) * (1.0 - abs(wn.y)) * wear;
  diffuseColor.rgb *= 1.0 - streak * 0.16;
  #ifndef ROTOR
  // Splash zone: algae and rust stain at the waterline, salt crust a little above it.
  float splash = (1.0 - smoothstep(0.5, 5.0, wp.y)) * wear;
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.42, 0.46, 0.33), splash * 0.85);
  float salt = smoothstep(0.6, 0.85, wearNoise(wp * 1.6)) * smoothstep(0.5, 2.5, wp.y) * (1.0 - smoothstep(4.0, 10.0, wp.y));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.78, 0.79, 0.76), salt * 0.45 * wear);
  // Rust weeping from bolts and welds down the yellow steel below the platform and tower flange.
  float yellow = smoothstep(0.15, 0.35, vColor.r - vColor.b);
  float rust = smoothstep(0.35, 0.75, wearNoise(vec3(h * 5.0, wp.y * 0.06, 9.1))) * smoothstep(0.3, 0.8, wearNoise(vec3(h * 1.3, wp.y * 0.4, 2.2)));
  rust *= yellow * (1.0 - abs(wn.y)) * (1.0 - smoothstep(26.0, 28.0, wp.y));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.32, 0.13, 0.05), rust * 0.55 * wear);
  // The nacelle housing is assembled from panels: seams every few metres along it and one round it.
  if (wp.y > ${(TURBINE.hubHeight - 3.6).toFixed(1)} && wp.z < 5.5 && wp.z > -14.5 && wear > 0.9) {
    float lines = max(seam((wp.z + 15.0) / 3.5), seam((wp.y - ${(TURBINE.hubHeight + 1.2).toFixed(1)}) / 9.0) * (1.0 - abs(wn.y)));
    diffuseColor.rgb *= 1.0 - lines * 0.28;
  }
  #endif
  // Contact shadow in creases also dims a little of the direct light.
  diffuseColor.rgb *= mix(1.0, vAo, 0.3);
`

const SURFACE_ROUGHNESS = /* glsl */ `
  roughnessFactor = clamp(vSurface.x + (wearNoise(vModel * 0.5) - 0.5) * 0.1 * vSurface.z + streak * 0.12, 0.05, 1.0);
`

const SURFACE_METALNESS = /* glsl */ `
  metalnessFactor = vSurface.y;
`

// Marine topcoats (the grey polyurethane, the yellow epoxy) are high-gloss: a clear lacquer layer
// mirrors the sky and the horizon down the tower and carries the sun's highlight, which is what
// makes painted steel read as steel. Grime and rain streaks dull it.
const CLEARCOAT = /* glsl */ `
  #ifdef USE_CLEARCOAT
  material.clearcoat *= step(vSurface.y, 0.5) * step(0.9, vSurface.z) * (1.0 - streak * 0.6);
  #endif
`

// three's aomap chunk, fed from the baked vertex term.
const VERTEX_AO = /* glsl */ `
  float ambientOcclusion = vAo;
  reflectedLight.indirectDiffuse *= ambientOcclusion;
  #if defined( USE_ENVMAP ) && defined( STANDARD )
    float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
    reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
  #endif
`

/** Patches a MeshStandard/PhysicalMaterial shader in onBeforeCompile; rotor geometry is hub-centred. */
export function applyWeathering(shader: THREE.WebGLProgramParametersWithUniforms, rotor: boolean) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${VERTEX_HEADER}`)
    .replace('#include <color_vertex>', `#include <color_vertex>\n${VERTEX_CAPTURE}`)
  shader.fragmentShader = (rotor ? '#define ROTOR\n' : '') +
    shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_HEADER}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${ALBEDO_WEAR}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${SURFACE_ROUGHNESS}`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n${SURFACE_METALNESS}`)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>\n${CLEARCOAT}`)
      .replace('#include <aomap_fragment>', VERTEX_AO)
}

/** Base parameters: the clear lacquer layer over every painted surface. */
export const TURBINE_PAINT: THREE.MeshPhysicalMaterialParameters = { vertexColors: true, clearcoat: 1, clearcoatRoughness: 0.06 }

/** A weathered turbine material for the hero turbine's parts. */
export function turbineMaterial(rotor: boolean, parameters: THREE.MeshPhysicalMaterialParameters = {}): THREE.MeshPhysicalMaterial {
  const material = new THREE.MeshPhysicalMaterial({ ...TURBINE_PAINT, ...parameters })
  material.customProgramCacheKey = () => `turbine-hero-${rotor ? 'rotor' : 'body'}`
  material.onBeforeCompile = (shader) => applyWeathering(shader, rotor)
  return material
}
