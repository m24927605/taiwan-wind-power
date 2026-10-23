import * as THREE from 'three'
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'
import { SATELLITE_BOUNDS, worldExtent } from '../geo/domain'

// Cumulus in a spherical shell over the strait, and cirrus above it, in world units (km). Shape
// and erosion after Schneider (Nubis): Perlin-Worley noise carved by Worley detail, generated once
// on the GPU. CLOUDS_GLSL builds on ATMOSPHERE_GLSL (it lights the clouds through the same air) and
// is shared by the cloud pass, the sky, the reflection environment and, for cloud shadows, the
// terrain and the sea. Himawari scans (data/satellite.ts) say where the cloud is, how tall it grows
// and where the cirrus and the overcast of deep convection lie; the noise only breaks their 2 km
// pixels into cloud. Without a scan there is no cloud.

export const CLOUD_BOTTOM = 0.9
export const CLOUD_TOP = 2.9

function satelliteBounds(): THREE.Vector4 {
  const e = worldExtent(SATELLITE_BOUNDS)
  return new THREE.Vector4(e.minX, e.minZ, 1 / e.width, 1 / e.depth)
}

export const clouds = {
  uCloudShape: { value: null as THREE.Texture | null },
  uCloudDetail: { value: null as THREE.Texture | null },
  uCloudWeather: { value: null as THREE.Texture | null },
  /** 1 once the noise volumes exist; until then the sky is clear. */
  uCloudsReady: { value: 0 },
  /** Wind drift of the cloud field, km. */
  uCloudOffset: { value: new THREE.Vector2() },
  /** The Himawari frames on either side of scene time (see data/satellite.ts) and the weight of B. */
  uSatA: { value: null as THREE.Texture | null },
  uSatB: { value: null as THREE.Texture | null },
  uSatBlend: { value: 0 },
  /** 1 while scans are bound, 0 when there is none for the scene time (and so no cloud). */
  uSatWeight: { value: 0 },
  /** World x and z of the scanned area's north-west corner, and the reciprocal of its width and depth. */
  uSatBounds: { value: satelliteBounds() },
  /** World position and radius (km) of what the clouds part over, as seen from the eye. */
  uCloudClear: { value: new THREE.Vector4() },
  /** How far they part there, 0..1. */
  uCloudClearStrength: { value: 0 },
}

export const CLOUDS_GLSL = /* glsl */ `
precision highp sampler3D;
uniform sampler3D uCloudShape;
uniform sampler3D uCloudDetail;
uniform sampler2D uCloudWeather;
uniform float uCloudsReady;
uniform vec2 uCloudOffset;
uniform sampler2D uSatA;
uniform sampler2D uSatB;
uniform float uSatBlend;
uniform float uSatWeight;
uniform vec4 uSatBounds;
uniform vec4 uCloudClear;
uniform float uCloudClearStrength;

const float CLOUD_BOTTOM = ${CLOUD_BOTTOM.toFixed(2)};
const float CLOUD_TOP = ${CLOUD_TOP.toFixed(2)};
/** Extinction of a fully dense cloud, per km (a visual range of a few tens of metres). */
const float CLOUD_EXT = 45.0;

float remap(float v, float a, float b, float c, float d) { return c + (v - a) / (b - a) * (d - c); }

// Satellite cloud at a world position: low cover, top height within the layer, high cover, deep
// convection.
vec4 satelliteCloud(vec2 xz) {
  vec2 uv = (xz - uSatBounds.xy) * uSatBounds.zw;
  return mix(textureLod(uSatA, uv, 0.0), textureLod(uSatB, uv, 0.0), uSatBlend);
}

// How much of the scan holds here: it fades out at the edge of the scanned area, beyond the widest
// view, where clamped texels would otherwise smear into streaks.
float satelliteWeight(vec2 xz) {
  vec2 uv = (xz - uSatBounds.xy) * uSatBounds.zw;
  vec2 inside = smoothstep(0.0, 0.03, uv) * smoothstep(1.0, 0.97, uv);
  return uSatWeight * inside.x * inside.y;
}

// From the overview the map matters more than the weather: clouds thin out with the eye's altitude.
float cloudFade() { return 1.0 - 0.65 * smoothstep(15.0, 120.0, uCameraPos.y); }

// What is left of the cloud at p where it parts over uCloudClear: open across that disc as the eye
// sees it, closing again over half its radius beyond. Shadows and light see the same gap.
float cloudClearing(vec3 p) {
  if (uCloudClearStrength <= 0.0) return 1.0;
  vec3 toClear = uCloudClear.xyz - uCameraPos;
  float d = length(toClear);
  float radius = atan(uCloudClear.w / d);
  float c = dot(normalize(p - uCameraPos), toClear / d);
  return 1.0 - uCloudClearStrength * smoothstep(cos(radius * 1.5), cos(radius), c);
}

// The world is a flat map, so the layer is flat too: a spherical shell would sink below the map's
// sea a few hundred kilometres out, where the overview looks.
float cloudAltitude(float t, float dy, float h) { return h + dy * t; }

// The part of the ray inside the cloud layer and in front of the sea; x >= y when there is none.
vec2 cloudSegment(vec3 d, float h) {
  if (abs(d.y) < 1e-5) return h > CLOUD_BOTTOM && h < CLOUD_TOP ? vec2(0.0, 1e9) : vec2(1.0, 0.0);
  float tb = (CLOUD_BOTTOM - h) / d.y;
  float tt = (CLOUD_TOP - h) / d.y;
  return vec2(max(min(tb, tt), 0.0), max(tb, tt));
}

// The cloud's shape before fine erosion. Shadows need no more, and leaving the detail volume out of
// them keeps the sea's shader within the GPU's sixteen textures.
float cloudBase(vec3 p) {
  float h01 = (p.y - CLOUD_BOTTOM) / (CLOUD_TOP - CLOUD_BOTTOM);
  if (h01 <= 0.0 || h01 >= 1.0) return 0.0;
  vec2 q = p.xz - uCloudOffset;
  float satW = uSatWeight > 0.0 ? satelliteWeight(p.xz) * cloudClearing(p) : 0.0;
  if (satW <= 0.0) return 0.0;
  // Explicit LOD: ray-march samples jump between neighbouring pixels, so derivatives mean nothing.
  vec3 weather = textureLod(uCloudWeather, q / 52.0, 0.0).rgb;
  // Warp the lookup by a few kilometres so edges follow the noise rather than the 2 km pixels.
  vec3 sat = satelliteCloud(p.xz + (weather.gb - 0.5) * 6.0).rgb;
  // The noise varies the cover inside the satellite's cloud and adds none where it saw clear sky.
  // A trace of cover would only break into specks that wink in and out, so it starts from 15%.
  float cover = smoothstep(0.15, 0.4, sat.r) * sat.r;
  float coverage = clamp(cover * (0.5 + weather.r * 0.6), 0.0, 1.0) * satW;
  float top = mix(0.35, 1.0, sat.g);
  float profile = clamp(h01 / 0.07, 0.0, 1.0) * clamp(remap(h01, top * 0.45, top, 1.0, 0.0), 0.0, 1.0);
  vec4 s = textureLod(uCloudShape, vec3(q.x, p.y, q.y) / 4.8, 0.0);
  float fbm = s.g * 0.625 + s.b * 0.25 + s.a * 0.125;
  float base = remap(s.r, fbm - 1.0, 1.0, 0.0, 1.0) * profile;
  return clamp(remap(base, 1.0 - coverage, 1.0, 0.0, 1.0) * coverage, 0.0, 1.0);
}

// detail, 0..1, is how much fine erosion to apply: full near the eye, fading out with distance so
// no edge sweeps across the clouds as the camera climbs.
float cloudDensity(vec3 p, float detail) {
  float base = cloudBase(p);
  if (base <= 0.0) return 0.0;
  if (detail > 0.0) {
    float h01 = (p.y - CLOUD_BOTTOM) / (CLOUD_TOP - CLOUD_BOTTOM);
    vec2 q = p.xz - uCloudOffset;
    vec3 dn = textureLod(uCloudDetail, vec3(q.x, p.y - uTime * 0.0015, q.y) / 0.72, 0.0).rgb;
    float dfbm = dn.r * 0.625 + dn.g * 0.25 + dn.b * 0.125;
    // Wispy at the base, billowing toward the top.
    float erode = mix(dfbm, 1.0 - dfbm, clamp(h01 * 4.0, 0.0, 1.0));
    base = remap(base, erode * 0.38 * detail, 1.0, 0.0, 1.0);
  }
  return clamp(base, 0.0, 1.0);
}

vec3 cloudLight(vec3 p, float dens, float cosT, int lightSteps, float detail) {
  float h01 = clamp((p.y - CLOUD_BOTTOM) / (CLOUD_TOP - CLOUD_BOTTOM), 0.0, 1.0);
  float od = 0.0;
  float stepL = 0.045;
  vec3 q = p;
  for (int j = 0; j < 6; j++) {
    if (j >= lightSteps) break;
    q += uSunDir * stepL;
    od += cloudDensity(q, j < 2 ? detail : 0.0) * stepL;
    stepL *= 1.85;
  }
  od *= CLOUD_EXT;
  // Wrenninge's multiple-scattering octaves over a forward/back dual-lobe phase.
  float s = 0.0;
  float a = 1.0, b = 1.0, c = 1.0;
  for (int o = 0; o < 4; o++) {
    float ph = mix(hg(0.8 * c, cosT), hg(-0.25 * c, cosT), 0.3);
    s += a * ph * exp(-od * b);
    a *= 0.58; b *= 0.3; c *= 0.5;
  }
  // Powder: thin edges facing away from the sun have not yet scattered light toward the eye.
  s *= mix(1.0, 1.0 - exp(-dens * 6.0), 0.5 * (0.5 - 0.5 * cosT));
  // The blue dome lights the tops; the dim sea and the horizon light the base.
  vec3 ambient = mix(skyIrradiance() / PI * 0.35, mix(skyIrradiance() / PI, skyZenith(), 0.6) * 1.25, h01);
  return sunIrradiance(p.y) * s + ambient;
}

// Luminance and transmittance of the clouds along a ray up to tLimit (km); depth receives the
// transmittance-weighted distance of what was seen, or -1.
vec4 marchClouds(vec3 cam, vec3 dir, float tLimit, int maxSteps, int lightSteps, bool detail, float jitter, out float depth) {
  depth = -1.0;
  if (uCloudsReady < 0.5) return vec4(0.0, 0.0, 0.0, 1.0);
  vec2 seg = cloudSegment(dir, cam.y);
  // At most 160 km of cloud, counted from where the ray enters the layer (the overview is ~300 km up).
  seg.y = min(seg.y, min(tLimit, seg.x + 160.0));
  if (seg.x >= seg.y) return vec4(0.0, 0.0, 0.0, 1.0);
  int steps = int(clamp((seg.y - seg.x) / 0.055, float(maxSteps) / 3.0, float(maxSteps)));
  float dt = (seg.y - seg.x) / float(steps);
  float cosT = dot(dir, uSunDir);
  vec3 L = vec3(0.0);
  float T = 1.0, dsum = 0.0, wsum = 0.0;
  for (int i = 0; i < 160; i++) {
    if (i >= steps) break;
    float t = seg.x + (float(i) + jitter) * dt;
    vec3 p = vec3(cam.x + dir.x * t, cloudAltitude(t, dir.y, cam.y), cam.z + dir.z * t);
    float near = detail ? 1.0 - smoothstep(16.0, 28.0, t) : 0.0;
    float dens = cloudDensity(p, near);
    if (dens <= 0.002) continue;
    float sT = exp(-dens * CLOUD_EXT * dt);
    float w = T * (1.0 - sT);
    L += cloudLight(p, dens, cosT, lightSteps, near) * w;
    dsum += t * w;
    wsum += w;
    T *= sT;
    if (T < 0.01) break;
  }
  if (wsum > 0.0) {
    depth = dsum / wsum;
    vec3 Ta;
    vec3 haze = integrateScattering(max(cam.y, 0.0), dir, depth, 6, Ta);
    L = L * Ta + haze * (1.0 - T);
  }
  return vec4(L, T);
}

/** Height of the high cloud sheet, km. */
const float HIGH_CLOUD = 8.5;

// The high cloud on a flat sheet, as radiance and opacity along d from cam, from below or above:
// wind-combed cirrus, and the dense overcast of deep convection (a typhoon's eyewall and rain
// bands), white from above and dark beneath. From the overview the cirrus thins like the clouds
// below; the overcast mostly stays, since it is the weather worth seeing from there.
vec4 highCloud(vec3 d, vec3 cam) {
  if (uCloudsReady < 0.5 || uSatWeight <= 0.0) return vec4(0.0);
  bool above = cam.y > HIGH_CLOUD;
  if (above ? d.y > -0.004 : d.y < 0.004) return vec4(0.0);
  float t = min((HIGH_CLOUD - cam.y) / d.y, 400.0);
  vec2 xz = cam.xz + d.xz * t;
  vec2 uv = (xz - uCloudOffset * 1.6) / 70.0;
  float n = textureLod(uCloudWeather, uv * vec2(1.0, 3.0), 0.0).b * 0.6 + textureLod(uCloudWeather, uv * vec2(3.0, 11.0) + 0.37, 0.0).b * 0.4;
  vec4 sat = satelliteCloud(xz);
  float w = satelliteWeight(xz) * smoothstep(0.004, 0.09, abs(d.y));
  float cirrus = clamp((n - 1.0 + sat.b * 0.62) * 2.6, 0.0, 0.85) * w * cloudFade();
  float deep = sat.a * mix(0.88, 1.0, n) * w * (1.0 - 0.2 * smoothstep(15.0, 120.0, cam.y));
  float a = max(cirrus, deep);
  if (a <= 0.0) return vec4(0.0);
  float c = dot(d, uSunDir);
  vec3 thin = sunIrradiance(HIGH_CLOUD) * (0.6 * hg(0.75, c) + 0.4 * hg(-0.1, c)) * 0.5 + skyIrradiance() / PI * 0.9;
  vec3 sun = sunIrradiance(HIGH_CLOUD) * max(uSunDir.y, 0.0);
  vec3 thick = above ? (sun + skyIrradiance()) * 0.8 / PI : (sun * 0.04 + skyIrradiance() * 0.3) / PI;
  return vec4(mix(thin, thick, deep / a), a);
}

vec3 applyHighCloud(vec3 col, vec3 d, vec3 cam) {
  vec4 h = highCloud(d, cam);
  return mix(col, h.rgb, h.a);
}

// Sunlight reaching a point on the ground through the cloud layer.
float cloudShadow(vec3 p) {
  if (uCloudsReady < 0.5) return 1.0;
  float sy = max(uSunDir.y, 0.06);
  // Far from the eye one sample through the middle of the layer is as good as four.
  int taps = distance(p, uCameraPos) > 40.0 ? 1 : 4;
  float od = 0.0;
  for (int i = 0; i < 4; i++) {
    if (i >= taps) break;
    float h = mix(CLOUD_BOTTOM, CLOUD_TOP, (float(i) + 0.5) / float(taps));
    vec3 q = p + uSunDir * ((h - p.y) / sy);
    q.y = h;
    od += cloudBase(q);
  }
  float shadow = exp(-od * CLOUD_EXT * (CLOUD_TOP - CLOUD_BOTTOM) / float(taps) / sy * 0.6);
  // The overcast of deep convection lets little through.
  vec2 high = p.xz + uSunDir.xz * ((HIGH_CLOUD - p.y) / sy);
  shadow *= 1.0 - 0.8 * satelliteCloud(high).a * satelliteWeight(high);
  // Thinned like the clouds themselves from the map view (CloudPass), so the map stays readable.
  return mix(1.0, shadow, cloudFade());
}
`

// ------------------------------------------------------------------------------- noise volumes

const NOISE = /* glsl */ `
  precision highp float;
  precision highp int;
  uniform float uSlice;
  uniform float uRes;
  uniform int uKind;
  out vec4 outColor;

  vec3 hash3(vec3 p) {
    p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
    return fract(sin(p) * 43758.5453123);
  }
  // Tileable with the given period, in cells.
  float worley(vec3 p, float period) {
    vec3 id = floor(p);
    vec3 f = fract(p);
    float d = 1.0;
    for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
      vec3 o = vec3(x, y, z);
      vec3 r = o + hash3(mod(id + o, period)) - f;
      d = min(d, dot(r, r));
    }
    return 1.0 - sqrt(d);
  }
  float grad(vec3 i, vec3 f, vec3 c, float period) {
    return dot(normalize(hash3(mod(i + c, period)) * 2.0 - 1.0 + 1e-4), f - c);
  }
  float perlin(vec3 p, float period) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    float x00 = mix(grad(i, f, vec3(0, 0, 0), period), grad(i, f, vec3(1, 0, 0), period), u.x);
    float x10 = mix(grad(i, f, vec3(0, 1, 0), period), grad(i, f, vec3(1, 1, 0), period), u.x);
    float x01 = mix(grad(i, f, vec3(0, 0, 1), period), grad(i, f, vec3(1, 0, 1), period), u.x);
    float x11 = mix(grad(i, f, vec3(0, 1, 1), period), grad(i, f, vec3(1, 1, 1), period), u.x);
    return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z);
  }
  float perlinFbm(vec3 p, float freq, int octaves) {
    float sum = 0.0, amp = 1.0, norm = 0.0;
    for (int o = 0; o < 6; o++) {
      if (o >= octaves) break;
      sum += perlin(p * freq, freq) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2.0;
    }
    return clamp(sum / norm * 0.9 + 0.5, 0.0, 1.0);
  }
  float worleyFbm(vec3 p, float freq) {
    return worley(p * freq, freq) * 0.625 + worley(p * freq * 2.0, freq * 2.0) * 0.25 + worley(p * freq * 4.0, freq * 4.0) * 0.125;
  }

  void main() {
    vec3 p = vec3(gl_FragCoord.xy, uSlice + 0.5) / uRes;
    if (uKind == 0) {
      // Shape: Perlin-Worley, then Worley fbm at three frequencies.
      float w = worleyFbm(p, 4.0);
      float pf = perlinFbm(p, 4.0, 5);
      float pw = clamp(w + pf * (1.0 - w) - 0.35 * (1.0 - pf), 0.0, 1.0);
      outColor = vec4(pw, w, worleyFbm(p, 8.0), worleyFbm(p, 16.0));
    } else if (uKind == 1) {
      // Detail: Worley fbm for erosion.
      outColor = vec4(worleyFbm(p, 2.0), worleyFbm(p, 4.0), worleyFbm(p, 8.0), 1.0);
    } else {
      // Weather (2D): coverage, cloud height, cirrus streaks.
      vec3 q = vec3(p.xy, 0.5);
      float cov = perlinFbm(q, 5.0, 5) * 0.7 + worleyFbm(q, 4.0) * 0.45 - 0.15;
      outColor = vec4(clamp(cov, 0.0, 1.0), perlinFbm(q + 0.31, 3.0, 3), perlinFbm(q + 0.71, 8.0, 6), 1.0);
    }
  }
`

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve))

/**
 * Generates the noise volumes, a few slices per frame (one long burst of heavy draws can trip
 * the GPU watchdog), and publishes them in `clouds`. Resolves to a disposer.
 */
export async function generateCloudNoise(renderer: THREE.WebGLRenderer, cancelled: () => boolean): Promise<() => void> {
  const quad = new FullScreenQuad()
  const material = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: /* glsl */ `
      in vec3 position;
      void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: NOISE,
    uniforms: { uSlice: { value: 0 }, uRes: { value: 0 }, uKind: { value: 0 } },
    depthTest: false,
    depthWrite: false,
  })
  const targets: (THREE.WebGL3DRenderTarget | THREE.WebGLRenderTarget)[] = []
  const draw = (target: THREE.WebGLRenderTarget | THREE.WebGL3DRenderTarget, layer = 0) => {
    quad.material = material
    const previous = renderer.getRenderTarget()
    renderer.setRenderTarget(target, layer)
    quad.render(renderer)
    renderer.setRenderTarget(previous)
  }
  const volume = async (res: number, kind: number) => {
    const target = new THREE.WebGL3DRenderTarget(res, res, res, { depthBuffer: false })
    Object.assign(target.texture, {
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      wrapR: THREE.RepeatWrapping,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
    })
    targets.push(target)
    material.uniforms.uRes.value = res
    material.uniforms.uKind.value = kind
    for (let z = 0; z < res && !cancelled(); z++) {
      material.uniforms.uSlice.value = z
      draw(target, z)
      if (z % 8 === 7) await nextFrame()
    }
    return target.texture
  }
  const dispose = () => {
    for (const t of targets) t.dispose()
    material.dispose()
    quad.dispose()
  }
  const shape = await volume(128, 0)
  const detail = await volume(32, 1)
  if (cancelled()) return dispose
  const weather = new THREE.WebGLRenderTarget(512, 512, {
    depthBuffer: false,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: true,
  })
  targets.push(weather)
  material.uniforms.uRes.value = 512
  material.uniforms.uKind.value = 2
  material.uniforms.uSlice.value = 0
  draw(weather)
  clouds.uCloudShape.value = shape
  clouds.uCloudDetail.value = detail
  clouds.uCloudWeather.value = weather.texture
  clouds.uCloudsReady.value = 1
  return () => {
    clouds.uCloudsReady.value = 0
    clouds.uCloudShape.value = clouds.uCloudDetail.value = clouds.uCloudWeather.value = null
    dispose()
  }
}
