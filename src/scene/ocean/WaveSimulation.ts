import * as THREE from 'three'
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'

// Tessendorf ocean: a two-peak directional spectrum (JONSWAP wind sea with Hasselmann spreading,
// plus a narrow, long-crested swell) evolved in time and brought to the spatial
// domain with a GPU Stockham FFT, in three cascades of decreasing tile size. All cascades share
// one 3N x N atlas carrying eight real fields in two complex pairs, so a frame costs
// 1 + 2 log2(N) + 2 full-screen passes regardless of the count.
//
// Per cascade it produces
//   displacement  (x, height, z, Jacobian of the choppy map), metres, for the vertex shader
//   surface       (slope x, slope z, slope², foam), mipmapped: filtering the first two moments keeps
//                 the slope variance that distance averages away, for specular roughness. Foam is
//                 injected where the surface folds and decays over seconds, so whitecaps leave
//                 trails; the target ping-pongs to carry it from frame to frame.

/** Tile sizes in metres. Incommensurate so the cascades never repeat in step. */
export const CASCADES = [512, 97, 17] as const
/** Horizontal displacement scale: sharper crests and earlier folding than linear theory. */
export const CHOP = 1.3

const G = 9.81
/** Peak enhancement: a developing wind sea, and a swell long since sorted by dispersion. */
const WIND_SEA_GAMMA = 3.3
const SWELL_GAMMA = 6
/** cos^2s spreading exponent of the swell. */
const SWELL_SPREAD = 28
/** Each cascade hands over to the next six fundamentals into the next tile. */
const HANDOVER = 6
/** Seconds a foam trail takes to fade to a third, per cascade. */
const FOAM_LIFETIME = [5, 3, 1.2] as const

export interface SeaComponent {
  /** Significant wave height, m. */
  hs: number
  /** Peak period, s. */
  tp: number
  /** Direction the waves travel toward, radians clockwise from north. */
  toward: number
}

export interface SeaState {
  windSea: SeaComponent
  swell: SeaComponent
}

const VERTEX = /* glsl */ `
  in vec3 position;
  void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`

const HEADER = /* glsl */ `
  precision highp float;
  precision highp int;
  precision highp sampler2D;
  const float PI = 3.141592653589793;
  vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
  vec2 iz(vec2 a) { return vec2(-a.y, a.x); }
`

// Spectrum and time evolution. Packs A = (Dx + i Dz, h + i Dxz), B = (hx + i hz, Dxx + i Dzz).
const EVOLVE = /* glsl */ `
  ${HEADER}
  uniform sampler2D uNoise;
  uniform int uN;
  uniform vec3 uTile;
  uniform vec2 uHandover;
  uniform float uTime;
  // Per component: JONSWAP alpha, peak angular frequency, direction of travel.
  uniform vec4 uWindSea;
  uniform vec4 uSwell;
  layout(location = 0) out vec4 outA;
  layout(location = 1) out vec4 outB;

  float jonswap(float w, float alpha, float peak, float gamma) {
    float sigma = w <= peak ? 0.07 : 0.09;
    float d = (w - peak) / (sigma * peak);
    return alpha * ${(G * G).toFixed(4)} / pow(w, 5.0) * exp(-1.25 * pow(peak / w, 4.0)) * pow(gamma, exp(-0.5 * d * d));
  }

  float lgammaStirling(float x) {
    return (x - 0.5) * log(x) - x + 0.9189385 + 1.0 / (12.0 * x) - 1.0 / (360.0 * x * x * x);
  }

  // Normalised cos^2s(theta / 2).
  float spreading(float s, float cosTheta) {
    float halfCos = sqrt(max(0.5 + 0.5 * cosTheta, 0.0));
    return exp(lgammaStirling(s + 1.0) - lgammaStirling(s + 0.5)) / (2.0 * sqrt(PI)) * pow(halfCos, 2.0 * s);
  }

  float spectrum(float w, vec2 dir) {
    float sum = 0.0;
    if (uWindSea.x > 0.0) {
      // Hasselmann: narrow at the peak, broadening on both flanks.
      float f = w / uWindSea.y;
      float s = clamp(f < 1.0 ? 6.97 * pow(f, 4.06) : 9.77 * pow(f, -2.33), 1.0, 24.0);
      sum += jonswap(w, uWindSea.x, uWindSea.y, ${WIND_SEA_GAMMA.toFixed(1)}) * spreading(s, dot(dir, uWindSea.zw));
    }
    if (uSwell.x > 0.0) {
      sum += jonswap(w, uSwell.x, uSwell.y, ${SWELL_GAMMA.toFixed(1)}) * spreading(${SWELL_SPREAD.toFixed(1)}, dot(dir, uSwell.zw));
    }
    return sum;
  }

  vec2 h0(ivec2 texel, vec2 k, float kLen, float dk) {
    float w = sqrt(${G} * kLen);
    float spectrum = spectrum(w, k / kLen) * ${(G / 2).toFixed(4)} / (w * kLen);
    // Each wave vector and its mirror share the variance S(k) dk² between them.
    return texelFetch(uNoise, texel, 0).xy * sqrt(0.5 * spectrum) * dk;
  }

  void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    int c = p.x / uN;
    ivec2 q = ivec2(p.x - c * uN, p.y);
    float L = c == 0 ? uTile.x : c == 1 ? uTile.y : uTile.z;
    float dk = 2.0 * PI / L;
    vec2 n = vec2(q.x < uN / 2 ? q.x : q.x - uN, q.y < uN / 2 ? q.y : q.y - uN);
    vec2 k = n * dk;
    float kLen = length(k);
    float lo = c == 0 ? 0.0 : c == 1 ? uHandover.x : uHandover.y;
    float hi = c == 0 ? uHandover.x : c == 1 ? uHandover.y : 1e9;
    if (kLen < lo || kLen >= hi || kLen < 1e-6) {
      outA = vec4(0.0);
      outB = vec4(0.0);
      return;
    }
    ivec2 mirror = ivec2(c * uN + (uN - q.x) % uN, (uN - q.y) % uN);
    vec2 a = h0(p, k, kLen, dk);
    vec2 b = h0(mirror, -k, kLen, dk);
    float w = sqrt(${G} * kLen);
    vec2 e = vec2(cos(w * uTime), sin(w * uTime));
    // The h0(k) term travels along +k, its conjugate partner along -k.
    vec2 h = cmul(a, vec2(e.x, -e.y)) + cmul(vec2(b.x, -b.y), e);
    vec2 kn = k / kLen;
    vec2 dx = -iz(h) * kn.x;
    vec2 dz = -iz(h) * kn.y;
    // Two real fields per complex FFT: f + i g.
    outA = vec4(dx + iz(dz), h + iz(h * kn.x * k.y));
    outB = vec4(iz(h) * k.x + iz(iz(h) * k.y), h * kn.x * k.x + iz(h * kn.y * k.y));
  }
`

// One radix-2 Stockham stage of the inverse FFT, along rows (per tile) or columns.
const FFT = /* glsl */ `
  ${HEADER}
  uniform sampler2D uA;
  uniform sampler2D uB;
  uniform int uN;
  uniform int uSub;
  uniform bool uHorizontal;
  layout(location = 0) out vec4 outA;
  layout(location = 1) out vec4 outB;

  void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    int index = uHorizontal ? p.x % uN : p.y;
    int base = uHorizontal ? p.x - index : 0;
    int half_ = uSub / 2;
    int even = (index / uSub) * half_ + index % half_;
    ivec2 pe = uHorizontal ? ivec2(base + even, p.y) : ivec2(p.x, even);
    ivec2 po = uHorizontal ? ivec2(base + even + uN / 2, p.y) : ivec2(p.x, even + uN / 2);
    float angle = 2.0 * PI * float(index) / float(uSub);
    vec2 tw = vec2(cos(angle), sin(angle));
    vec4 ea = texelFetch(uA, pe, 0);
    vec4 oa = texelFetch(uA, po, 0);
    vec4 eb = texelFetch(uB, pe, 0);
    vec4 ob = texelFetch(uB, po, 0);
    outA = vec4(ea.xy + cmul(tw, oa.xy), ea.zw + cmul(tw, oa.zw));
    outB = vec4(eb.xy + cmul(tw, ob.xy), eb.zw + cmul(tw, ob.zw));
  }
`

const RESOLVE_COMMON = /* glsl */ `
  ${HEADER}
  uniform sampler2D uA;
  uniform sampler2D uB;
  uniform int uN;
  uniform float uChop;
  layout(location = 0) out vec4 out0;
  layout(location = 1) out vec4 out1;
  layout(location = 2) out vec4 out2;
  // Negative lambda pulls points toward the crests (trochoidal, not inverted).
  struct Field { vec4 a; vec4 b; float jxx; float jzz; float jacobian; };
  Field field(int c) {
    ivec2 p = ivec2(gl_FragCoord.xy) + ivec2(c * uN, 0);
    Field f;
    f.a = texelFetch(uA, p, 0);
    f.b = texelFetch(uB, p, 0);
    float l = -uChop;
    f.jxx = 1.0 + l * f.b.z;
    f.jzz = 1.0 + l * f.b.w;
    float jxz = l * f.a.w;
    f.jacobian = f.jxx * f.jzz - jxz * jxz;
    return f;
  }
`

const RESOLVE_DISPLACEMENT = /* glsl */ `
  ${RESOLVE_COMMON}
  vec4 cascade(int c) {
    Field f = field(c);
    return vec4(-uChop * f.a.x, f.a.z, -uChop * f.a.y, f.jacobian);
  }
  void main() { out0 = cascade(0); out1 = cascade(1); out2 = cascade(2); }
`

const RESOLVE_SURFACE = /* glsl */ `
  ${RESOLVE_COMMON}
  uniform sampler2D uPrev0;
  uniform sampler2D uPrev1;
  uniform sampler2D uPrev2;
  uniform vec3 uDecay;
  uniform vec3 uFoamThreshold;
  vec4 cascade(int c, float previous, float decay, float threshold) {
    Field f = field(c);
    // Slopes of the displaced surface, not of the undisplaced grid.
    vec2 slope = vec2(f.b.x / max(f.jxx, 0.3), f.b.y / max(f.jzz, 0.3));
    float inject = clamp((threshold - f.jacobian) * 4.0, 0.0, 1.0);
    return vec4(slope, dot(slope, slope), max(previous * decay, inject));
  }
  void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    out0 = cascade(0, texelFetch(uPrev0, p, 0).w, uDecay.x, uFoamThreshold.x);
    out1 = cascade(1, texelFetch(uPrev1, p, 0).w, uDecay.y, uFoamThreshold.y);
    out2 = cascade(2, texelFetch(uPrev2, p, 0).w, uDecay.z, uFoamThreshold.z);
  }
`

function gaussianNoise(width: number, height: number): THREE.DataTexture {
  // Deterministic, so the sea looks the same on every load.
  let seed = 0x2f6b1a3d
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const data = new Float32Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    const r = Math.sqrt(-2 * Math.log(1 - random()))
    const a = 2 * Math.PI * random()
    // Complex unit-variance gaussian: real and imaginary parts each N(0, 1/2).
    data[i * 4] = (r * Math.cos(a)) / Math.SQRT2
    data[i * 4 + 1] = (r * Math.sin(a)) / Math.SQRT2
  }
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType)
  texture.needsUpdate = true
  return texture
}

/** JONSWAP α that yields the requested significant wave height (Hs = 4 √m0). */
function jonswapAlpha({ hs, tp }: SeaComponent, gamma: number): number {
  const peak = (2 * Math.PI) / tp
  let m0 = 0
  const steps = 2000
  const w0 = 0.3 * peak
  const w1 = 12 * peak
  const dw = (w1 - w0) / steps
  for (let i = 0; i < steps; i++) {
    const w = w0 + (i + 0.5) * dw
    const sigma = w <= peak ? 0.07 : 0.09
    const r = Math.exp(-0.5 * ((w - peak) / (sigma * peak)) ** 2)
    m0 += ((G * G) / w ** 5) * Math.exp(-1.25 * (peak / w) ** 4) * gamma ** r * dw
  }
  return (hs * hs) / (16 * m0)
}

// Half floats halve the bandwidth of the 2 log2(N) passes, which dominate the cost; their 11-bit
// mantissa is ample for metre-scale displacement and for slopes.
function fftTarget(width: number, height: number) {
  return new THREE.WebGLRenderTarget(width, height, {
    count: 2,
    type: THREE.HalfFloatType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: false,
    generateMipmaps: false,
  })
}

function fieldTarget(renderer: THREE.WebGLRenderer, n: number) {
  return new THREE.WebGLRenderTarget(n, n, {
    count: CASCADES.length,
    type: THREE.HalfFloatType,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    // Grazing views need some anisotropy; beyond 4x the cascade taps cost more than they show.
    anisotropy: Math.min(4, renderer.capabilities.getMaxAnisotropy()),
    depthBuffer: false,
    generateMipmaps: true,
  })
}

export class WaveSimulation {
  readonly displacement: THREE.Texture[]
  /** The surface fields written by the latest update. */
  surface: THREE.Texture[]
  private readonly quad = new FullScreenQuad()
  private readonly noise: THREE.DataTexture
  private readonly ping: THREE.WebGLRenderTarget
  private readonly pong: THREE.WebGLRenderTarget
  private readonly displacementTarget: THREE.WebGLRenderTarget
  private readonly surfaceTargets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget]
  private readonly evolve: THREE.RawShaderMaterial
  private readonly fft: THREE.RawShaderMaterial
  private readonly resolveDisplacement: THREE.RawShaderMaterial
  private readonly resolveSurface: THREE.RawShaderMaterial
  private readonly n: number
  private seaKey = ''
  private frame = 0

  constructor(renderer: THREE.WebGLRenderer, n: number) {
    this.n = n
    this.noise = gaussianNoise(n * CASCADES.length, n)
    this.ping = fftTarget(n * CASCADES.length, n)
    this.pong = fftTarget(n * CASCADES.length, n)
    this.displacementTarget = fieldTarget(renderer, n)
    this.surfaceTargets = [fieldTarget(renderer, n), fieldTarget(renderer, n)]
    this.displacement = this.displacementTarget.textures
    this.surface = this.surfaceTargets[0].textures

    const raw = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>) =>
      new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VERTEX, fragmentShader, uniforms })
    const [l0, l1, l2] = CASCADES
    this.evolve = raw(EVOLVE, {
      uNoise: { value: this.noise },
      uN: { value: n },
      uTile: { value: new THREE.Vector3(l0, l1, l2) },
      uHandover: { value: new THREE.Vector2(((2 * Math.PI) / l1) * HANDOVER, ((2 * Math.PI) / l2) * HANDOVER) },
      uTime: { value: 0 },
      uWindSea: { value: new THREE.Vector4() },
      uSwell: { value: new THREE.Vector4() },
    })
    this.fft = raw(FFT, {
      uA: { value: null },
      uB: { value: null },
      uN: { value: n },
      uSub: { value: 2 },
      uHorizontal: { value: true },
    })
    const resolve = () => ({ uA: { value: null }, uB: { value: null }, uN: { value: n }, uChop: { value: CHOP } })
    this.resolveDisplacement = raw(RESOLVE_DISPLACEMENT, resolve())
    this.resolveSurface = raw(RESOLVE_SURFACE, {
      ...resolve(),
      uPrev0: { value: null },
      uPrev1: { value: null },
      uPrev2: { value: null },
      uDecay: { value: new THREE.Vector3(1, 1, 1) },
      uFoamThreshold: { value: new THREE.Vector3() },
    })
  }

  setSeaState(sea: SeaState) {
    const key = JSON.stringify(sea)
    if (key === this.seaKey) return
    this.seaKey = key
    const set = (target: THREE.Vector4, c: SeaComponent, gamma: number) =>
      c.hs > 0.02
        ? // World +x is east and -z north.
          target.set(jonswapAlpha(c, gamma), (2 * Math.PI) / c.tp, Math.sin(c.toward), -Math.cos(c.toward))
        : target.set(0, 1, 0, -1)
    set(this.evolve.uniforms.uWindSea.value, sea.windSea, WIND_SEA_GAMMA)
    set(this.evolve.uniforms.uSwell.value, sea.swell, SWELL_GAMMA)
  }

  /** @param whitecaps 0 (none) to 1 (gale): where each cascade's own folds leave foam trails */
  update(renderer: THREE.WebGLRenderer, time: number, dt: number, whitecaps: number) {
    const previous = renderer.getRenderTarget()
    this.evolve.uniforms.uTime.value = time
    this.run(renderer, this.evolve, this.ping)

    let src = this.ping
    let dst = this.pong
    for (const horizontal of [true, false]) {
      for (let sub = 2; sub <= this.n; sub *= 2) {
        const u = this.fft.uniforms
        u.uA.value = src.textures[0]
        u.uB.value = src.textures[1]
        u.uSub.value = sub
        u.uHorizontal.value = horizontal
        this.run(renderer, this.fft, dst)
        ;[src, dst] = [dst, src]
      }
    }

    for (const m of [this.resolveDisplacement, this.resolveSurface]) {
      m.uniforms.uA.value = src.textures[0]
      m.uniforms.uB.value = src.textures[1]
    }
    this.run(renderer, this.resolveDisplacement, this.displacementTarget)

    const before = this.surfaceTargets[this.frame % 2]
    const after = this.surfaceTargets[(this.frame + 1) % 2]
    const u = this.resolveSurface.uniforms
    u.uPrev0.value = before.textures[0]
    u.uPrev1.value = before.textures[1]
    u.uPrev2.value = before.textures[2]
    u.uDecay.value.set(...FOAM_LIFETIME.map((t) => Math.exp(-dt / t)))
    const lerp = THREE.MathUtils.lerp
    u.uFoamThreshold.value.set(lerp(0.5, 0.8, whitecaps), lerp(0.5, 0.8, whitecaps), lerp(0.4, 0.75, whitecaps))
    this.run(renderer, this.resolveSurface, after)
    this.surface = after.textures
    this.frame++
    renderer.setRenderTarget(previous)
  }

  private run(renderer: THREE.WebGLRenderer, material: THREE.Material, target: THREE.WebGLRenderTarget) {
    this.quad.material = material
    renderer.setRenderTarget(target)
    this.quad.render(renderer)
  }

  dispose() {
    this.quad.dispose()
    this.noise.dispose()
    this.ping.dispose()
    this.pong.dispose()
    this.displacementTarget.dispose()
    for (const t of this.surfaceTargets) t.dispose()
    this.evolve.dispose()
    this.fft.dispose()
    this.resolveDisplacement.dispose()
    this.resolveSurface.dispose()
  }
}
