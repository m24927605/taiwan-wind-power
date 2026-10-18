import * as THREE from 'three'

// Uniforms shared by reference across every custom material, updated once per frame.
export const atmosphere = {
  uSunDir: { value: new THREE.Vector3(0, 1, 0) },
  /** 0 at night, 1 in full daylight. */
  uDay: { value: 1 },
  uTime: { value: 0 },
  uCameraPos: { value: new THREE.Vector3() },
  /** 1 in engineering mode: materials switch to their diagnostic look. */
  uDebug: { value: 0 },
}

// Moon is fixed high in the south-east: a stylised, stable night key light.
export const MOON_DIR = new THREE.Vector3(0.35, 0.75, 0.55).normalize()

export const ATMOSPHERE_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform float uDay;
uniform float uTime;
uniform vec3 uCameraPos;
uniform float uDebug;

const vec3 MOON_DIR = vec3(${MOON_DIR.toArray().map((v) => v.toFixed(4)).join(',')});

float twilight() {
  return exp(-pow(uSunDir.y * 5.5, 2.0));
}

vec3 sunColor() {
  vec3 noon = vec3(1.0, 0.97, 0.92);
  vec3 low = vec3(1.0, 0.55, 0.28);
  return mix(low, noon, smoothstep(0.0, 0.35, uSunDir.y));
}

vec3 skyHorizon(vec3 dir) {
  vec3 night = vec3(0.022, 0.04, 0.075);
  vec3 day = vec3(0.58, 0.70, 0.82);
  vec3 col = mix(night, day, uDay);
  vec2 h = normalize(dir.xz + 1e-5);
  vec2 s = normalize(uSunDir.xz + 1e-5);
  float sunward = pow(max(dot(h, s), 0.0), 3.0);
  col += vec3(0.95, 0.42, 0.18) * twilight() * (0.25 + 0.75 * sunward);
  return col;
}

vec3 skyColor(vec3 dir) {
  vec3 zenithNight = vec3(0.004, 0.009, 0.022);
  vec3 zenithDay = vec3(0.16, 0.36, 0.64);
  vec3 zenith = mix(zenithNight, zenithDay, uDay) + vec3(0.10, 0.07, 0.16) * twilight() * 0.6;
  float t = pow(clamp(dir.y, 0.0, 1.0), 0.45);
  return mix(skyHorizon(dir), zenith, t);
}

// Aerial perspective. Haze density falls off exponentially with height, so the optical depth
// along a ray from altitude y0 to y1 over distance d is β·d·H·(e^(-y0/H) - e^(-y1/H)) / (y1 - y0):
// distant ridges fade into the horizon colour while views from orbit look down through thin air.
const float HAZE_EXTINCTION = 0.04; // per km at sea level: about 100 km visibility
const float HAZE_SCALE_HEIGHT = 1.2; // km

vec3 applyFog(vec3 col, vec3 worldPos) {
  vec3 v = worldPos - uCameraPos;
  float dist = length(v);
  float y0 = max(uCameraPos.y, 0.0);
  float y1 = max(worldPos.y, 0.0);
  float dy = y1 - y0;
  float e0 = exp(-y0 / HAZE_SCALE_HEIGHT);
  float density = abs(dy) < 1e-3 ? e0 : HAZE_SCALE_HEIGHT * (e0 - exp(-y1 / HAZE_SCALE_HEIGHT)) / dy;
  float fog = 1.0 - exp(-HAZE_EXTINCTION * dist * density);
  vec3 dir = v / max(dist, 1e-4);
  // Forward scattering brightens the haze toward the sun.
  vec3 haze = skyHorizon(dir) + sunColor() * pow(max(dot(dir, uSunDir), 0.0), 8.0) * 0.25 * uDay;
  return mix(col, haze, fog);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`
