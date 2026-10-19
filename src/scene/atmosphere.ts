import * as THREE from 'three'

// Physically based atmosphere (Hillaire 2020) in world units, which are kilometres: transmittance,
// multiple-scattering and sky-view lookup tables, rendered by AtmosphereLuts, and the GLSL every
// custom material uses to light itself and to fade into the haze. Shading is in scene radiance
// (the sun's illuminance is SUN_E); materials multiply by uExposure before they write.

/** Solar illuminance in scene units. */
export const SUN_E = 20
/** Mie density over open water, relative to Hillaire's reference aerosol. */
export const HAZE = 0.55
/**
 * Full moon to sun illuminance, raised from the physical 2.5e-6 for night vision but kept low enough
 * that a moonlit sky stays darker than the sky of nautical twilight.
 */
export const MOON_RATIO = 1e-5
/** Below this solar elevation the moon is the key light of the whole scene. */
export const NIGHT_ELEVATION = THREE.MathUtils.degToRad(-12)

const RG = 6360
const RT = 6460

// Uniforms shared by reference across every custom material, updated once per frame.
export const atmosphere = {
  /** The key light: the sun, or the moon after nautical dusk. */
  uSunDir: { value: new THREE.Vector3(0, 1, 0) },
  /** Illuminance of the key light above the atmosphere. */
  uSunE: { value: SUN_E },
  /** The sun itself, for daylight, stars and the moon's phase. */
  uSunTrue: { value: new THREE.Vector3(0, 1, 0) },
  /** 1 while the moon is the key light. */
  uMoonLight: { value: 0 },
  /** 0 at night, 1 in full daylight (from the true sun). */
  uDay: { value: 1 },
  uExposure: { value: 0.3 },
  uTime: { value: 0 },
  uCameraPos: { value: new THREE.Vector3() },
  /** 1 in engineering mode: materials switch to their diagnostic look. */
  uDebug: { value: 0 },
  uTransmittance: { value: null as THREE.Texture | null },
  uMultiScatter: { value: null as THREE.Texture | null },
  /** Sky seen from the camera. */
  uSkyView: { value: null as THREE.Texture | null },
  /** Sky seen from the sea surface: what lights and is reflected by everything on the ground. */
  uGroundSky: { value: null as THREE.Texture | null },
  /** Texel 0: cosine-weighted mean radiance of the ground sky; texel 1: its zenith radiance. */
  uAmbient: { value: null as THREE.Texture | null },
  /** The ground sky with its clouds, mipmapped: what the sea reflects and the turbines are lit by. */
  uGroundEnv: { value: null as THREE.Texture | null },
}

export const ATMOSPHERE_GLSL = /* glsl */ `
#ifndef PI
#define PI 3.141592653589793
#endif
const float RG = ${RG.toFixed(1)};
const float RT = ${RT.toFixed(1)};
uniform vec3 uSunDir;
uniform float uSunE;
uniform vec3 uSunTrue;
uniform float uMoonLight;
uniform float uDay;
uniform float uExposure;
uniform float uTime;
uniform vec3 uCameraPos;
uniform float uDebug;
uniform sampler2D uTransmittance;
uniform sampler2D uMultiScatter;
uniform sampler2D uSkyView;
uniform sampler2D uGroundSky;
uniform sampler2D uAmbient;
uniform sampler2D uGroundEnv;

struct Medium { vec3 scatR; float scatM; vec3 ext; };

Medium mediumAt(float h) {
  h = max(h, 0.0);
  float rayleigh = exp(-h / 8.0);
  float mie = exp(-h / 1.2) * ${HAZE.toFixed(3)};
  float ozone = max(0.0, 1.0 - abs(h - 25.0) / 15.0);
  Medium m;
  m.scatR = vec3(5.802e-3, 13.558e-3, 33.1e-3) * rayleigh;
  m.scatM = 3.996e-3 * mie;
  m.ext = m.scatR + vec3(4.44e-3 * mie) + vec3(0.65e-3, 1.881e-3, 0.085e-3) * ozone;
  return m;
}

float rayleighPhase(float c) { return 3.0 / (16.0 * PI) * (1.0 + c * c); }
float hg(float g, float c) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}
// Cornette-Shanks.
float miePhase(float c) {
  const float g = 0.8;
  float g2 = g * g;
  return 3.0 / (8.0 * PI) * (1.0 - g2) * (1.0 + c * c) / ((2.0 + g2) * pow(1.0 + g2 - 2.0 * g * c, 1.5));
}

// Factored differences of squares keep these accurate at Earth radius in single precision.
float distToTop(float r, float mu) {
  return max(0.0, -r * mu + sqrt(max((RT - r) * (RT + r) + r * r * mu * mu, 0.0)));
}
bool hitsGround(float r, float mu) {
  return mu < 0.0 && (RG - r) * (RG + r) + r * r * mu * mu >= 0.0;
}
float distToGround(float r, float mu) {
  return max(0.0, -r * mu - sqrt(max((RG - r) * (RG + r) + r * r * mu * mu, 0.0)));
}

// Bruneton's transmittance LUT parametrisation.
vec2 transmittanceUV(float r, float mu) {
  float H = sqrt(RT * RT - RG * RG);
  float rho = sqrt(max(r * r - RG * RG, 0.0));
  float d = distToTop(r, mu);
  float dmin = RT - r;
  float dmax = rho + H;
  return vec2((d - dmin) / (dmax - dmin), rho / H);
}
vec3 transmittanceTo(float r, float mu) { return textureLod(uTransmittance, transmittanceUV(min(r, RT), mu), 0.0).rgb; }
// Toward the key light: fades out as its disc sets below the horizon of a point at radius r.
vec3 sunTransmittance(float r, float mu) {
  float s = RG / r;
  float muH = -sqrt(max(1.0 - s * s, 0.0));
  return transmittanceTo(r, mu) * smoothstep(muH - 0.0047, muH + 0.0047, mu);
}
vec3 multiScatter(float r, float mu) {
  return textureLod(uMultiScatter, vec2(mu * 0.5 + 0.5, clamp((r - RG) / (RT - RG), 0.0, 1.0)), 0.0).rgb;
}

// In-scattered radiance along a ray from altitude h0 (km) over [0, tMax] km: single scattering plus
// Hillaire's multiple-scattering term. An eye above the atmosphere starts where the ray enters it.
vec3 integrateScattering(float h0, vec3 dir, float tMax, int steps, out vec3 T) {
  T = vec3(1.0);
  float r0 = RG + h0;
  float t0 = 0.0;
  if (r0 > RT) {
    float b = r0 * dir.y;
    float disc = b * b - (r0 - RT) * (r0 + RT);
    if (b >= 0.0 || disc < 0.0) return vec3(0.0);
    t0 = -b - sqrt(disc);
  }
  if (tMax <= t0) return vec3(0.0);
  float c = dot(dir, uSunDir);
  float pR = rayleighPhase(c);
  float pM = miePhase(c);
  vec3 L = vec3(0.0);
  float span = tMax - t0;
  float tPrev = 0.0;
  for (int i = 0; i < 64; i++) {
    if (i >= steps) break;
    // Samples cluster near the start of the segment.
    float f = (float(i) + 1.0) / float(steps);
    float t1 = span * f * f;
    float dt = t1 - tPrev;
    float t = t0 + tPrev + 0.5 * dt;
    tPrev = t1;
    vec3 p = vec3(dir.x * t, r0 + dir.y * t, dir.z * t);
    float r = length(p);
    float muS = dot(p, uSunDir) / r;
    Medium m = mediumAt(r - RG);
    vec3 sampleT = exp(-m.ext * dt);
    vec3 S = (m.scatR * pR + m.scatM * pM) * sunTransmittance(r, muS) + (m.scatR + m.scatM) * multiScatter(r, muS);
    L += T * (S - S * sampleT) / max(m.ext, vec3(1e-7));
    T *= sampleT;
  }
  return L * uSunE;
}

// Sky-view LUTs: longitude by world azimuth, latitude squeezed toward the horizon.
vec3 skyDir(vec2 uv) {
  float l = uv.y * 2.0 - 1.0;
  float el = sign(l) * l * l * PI * 0.5;
  float az = uv.x * 2.0 * PI;
  return vec3(cos(el) * sin(az), sin(el), -cos(el) * cos(az));
}
vec2 skyUV(vec3 d) {
  float l = asin(clamp(d.y, -1.0, 1.0)) / (PI * 0.5);
  return vec2(fract(atan(d.x, -d.z) / (2.0 * PI)), 0.5 + 0.5 * sign(l) * sqrt(abs(l)));
}

/** The sky seen from the camera, without the sun's disc. */
vec3 skyRadiance(vec3 dir) { return textureLod(uSkyView, skyUV(dir), 0.0).rgb; }
/** The sky seen from the sea surface. */
vec3 groundSkyRadiance(vec3 dir) { return textureLod(uGroundSky, skyUV(dir), 0.0).rgb; }
/** The cloudy sky seen from the sea surface, blurred to a mip level (0: 1.4 degree texels). */
vec3 groundEnvRadiance(vec3 dir, float lod) { return textureLod(uGroundEnv, skyUV(dir), lod).rgb; }
/** Irradiance on a horizontal surface at sea level from the sky alone. */
vec3 skyIrradiance() { return PI * texelFetch(uAmbient, ivec2(0, 0), 0).rgb; }
vec3 skyZenith() { return texelFetch(uAmbient, ivec2(1, 0), 0).rgb; }
/** Irradiance from the key light, normal to it, at altitude h (km). */
vec3 sunIrradiance(float h) { return uSunE * sunTransmittance(RG + max(h, 0.0), uSunDir.y); }

/** Attenuates radiance leaving worldPos toward the camera and adds the haze lit along the way. */
vec3 aerialPerspective(vec3 col, vec3 worldPos) {
  vec3 v = worldPos - uCameraPos;
  float d = length(v);
  vec3 T;
  vec3 L = integrateScattering(max(uCameraPos.y, 0.0), v / max(d, 1e-6), d, 6, T);
  return col * T + L;
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`

// The same medium on the CPU, for three.js lights.
function extinctionAt(h: number, out: number[]) {
  h = Math.max(h, 0)
  const rayleigh = Math.exp(-h / 8)
  const mie = Math.exp(-h / 1.2) * HAZE
  const ozone = Math.max(0, 1 - Math.abs(h - 25) / 15)
  out[0] = 5.802e-3 * rayleigh + 4.44e-3 * mie + 0.65e-3 * ozone
  out[1] = 13.558e-3 * rayleigh + 4.44e-3 * mie + 1.881e-3 * ozone
  out[2] = 33.1e-3 * rayleigh + 4.44e-3 * mie + 0.085e-3 * ozone
}

const ext = [0, 0, 0]

/** Transmittance from sea level to space along a direction whose cosine of zenith is mu. */
export function seaLevelTransmittance(mu: number, out: THREE.Color): THREE.Color {
  const r = RG + 0.002
  const s = RG / r
  const muH = -Math.sqrt(1 - s * s)
  if (mu < muH - 0.0047) return out.setRGB(0, 0, 0)
  const d = -r * mu + Math.sqrt(Math.max((RT - r) * (RT + r) + r * r * mu * mu, 0))
  const steps = 40
  const dt = d / steps
  let o0 = 0
  let o1 = 0
  let o2 = 0
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * dt
    extinctionAt(Math.sqrt(r * r + t * t + 2 * r * mu * t) - RG, ext)
    o0 += ext[0] * dt
    o1 += ext[1] * dt
    o2 += ext[2] * dt
  }
  const fade = THREE.MathUtils.smoothstep(mu, muH - 0.0047, muH + 0.0047)
  return out.setRGB(Math.exp(-o0) * fade, Math.exp(-o1) * fade, Math.exp(-o2) * fade)
}
