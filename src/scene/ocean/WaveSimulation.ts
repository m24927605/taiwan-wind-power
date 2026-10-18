import * as THREE from 'three'
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'

// Tessendorf ocean: a directional JONSWAP spectrum evolved in time and brought to the spatial
// domain with a GPU Stockham FFT, in three cascades of decreasing tile size. All cascades share
// one 3N x N atlas, so a frame costs 1 + 2 log2(N) + 1 full-screen passes regardless of count.

/** Tile sizes in metres. Incommensurate so the cascades never repeat in step. */
export const CASCADES = [512, 97, 17] as const

const G = 9.81
const GAMMA = 3.3
/** Each cascade hands over to the next six fundamentals into the next tile. */
const HANDOVER = 6

export interface SeaState {
  /** Significant wave height, m. */
  hs: number
  /** Peak period, s. */
  tp: number
  /** Direction the waves travel toward, radians clockwise from north. */
  toward: number
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
`

// Spectrum and time evolution in one pass. Writes the packed spectra of four real fields,
// (slope x + i slope z, Jxx + i Jzz), where Jxx and Jzz are the diagonal derivatives of the
// horizontal (choppy) displacement used for the foam Jacobian. The cross term is second order
// and left out, which keeps the whole FFT in a single half-float target.
const EVOLVE = /* glsl */ `
  ${HEADER}
  uniform sampler2D uNoise;
  uniform int uN;
  uniform vec3 uTile;
  uniform vec2 uHandover;
  uniform float uTime;
  uniform float uAlpha;
  uniform float uPeak;
  uniform vec2 uToward;
  layout(location = 0) out vec4 outA;

  float jonswap(float w) {
    float sigma = w <= uPeak ? 0.07 : 0.09;
    float d = (w - uPeak) / (sigma * uPeak);
    float r = exp(-0.5 * d * d);
    return uAlpha * ${(G * G).toFixed(4)} / pow(w, 5.0) * exp(-1.25 * pow(uPeak / w, 4.0)) * pow(${GAMMA.toFixed(2)}, r);
  }

  float lgammaStirling(float x) {
    return (x - 0.5) * log(x) - x + 0.9189385 + 1.0 / (12.0 * x) - 1.0 / (360.0 * x * x * x);
  }

  // Hasselmann spreading: narrow at the peak, broadening on both flanks.
  float spreading(float w, float cosTheta) {
    float f = w / uPeak;
    float s = clamp(f < 1.0 ? 6.97 * pow(f, 4.06) : 9.77 * pow(f, -2.33), 1.0, 24.0);
    float halfCos = sqrt(max(0.5 + 0.5 * cosTheta, 0.0));
    return exp(lgammaStirling(s + 1.0) - lgammaStirling(s + 0.5)) / (2.0 * sqrt(PI)) * pow(halfCos, 2.0 * s);
  }

  vec2 h0(ivec2 texel, vec2 k, float kLen, float dk) {
    if (kLen < 1e-6) return vec2(0.0);
    float w = sqrt(${G} * kLen);
    float spectrum = jonswap(w) * spreading(w, dot(k / kLen, uToward)) * ${(G / 2).toFixed(4)} / (w * kLen);
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
      return;
    }
    ivec2 mirror = ivec2(c * uN + (uN - q.x) % uN, (uN - q.y) % uN);
    vec2 a = h0(p, k, kLen, dk);
    vec2 b = h0(mirror, -k, kLen, dk);
    float w = sqrt(${G} * kLen);
    vec2 e = vec2(cos(w * uTime), sin(w * uTime));
    // The h0(k) term travels along +k, its conjugate partner along -k.
    vec2 h = cmul(a, vec2(e.x, -e.y)) + cmul(vec2(b.x, -b.y), e);

    vec2 ih = vec2(-h.y, h.x);
    vec2 slopeX = ih * k.x;
    vec2 slopeZ = ih * k.y;
    vec2 jxx = h * (k.x * k.x / kLen);
    vec2 jzz = h * (k.y * k.y / kLen);
    // Two real fields per complex FFT: f + i g.
    outA = vec4(slopeX + vec2(-slopeZ.y, slopeZ.x), jxx + vec2(-jzz.y, jzz.x));
  }
`

// One radix-2 Stockham stage of the inverse FFT, along rows (per tile) or columns.
const FFT = /* glsl */ `
  ${HEADER}
  uniform sampler2D uA;
  uniform int uN;
  uniform int uSub;
  uniform bool uHorizontal;
  layout(location = 0) out vec4 outA;

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
    vec4 e = texelFetch(uA, pe, 0);
    vec4 o = texelFetch(uA, po, 0);
    outA = vec4(e.xy + cmul(tw, o.xy), e.zw + cmul(tw, o.zw));
  }
`

// Unpacks each cascade into its own tileable, mipmapped texture:
// (slope x, slope z, slope x² + slope z², Jacobian). Mip filtering then yields the mean slope
// and, from the second moment, the unresolved slope variance used as specular roughness.
const RESOLVE = /* glsl */ `
  ${HEADER}
  uniform sampler2D uA;
  uniform int uN;
  uniform float uChop;
  layout(location = 0) out vec4 out0;
  layout(location = 1) out vec4 out1;
  layout(location = 2) out vec4 out2;

  vec4 cascade(int c) {
    ivec2 p = ivec2(gl_FragCoord.xy) + ivec2(c * uN, 0);
    vec4 a = texelFetch(uA, p, 0);
    vec2 slope = a.xy;
    float jacobian = (1.0 - uChop * a.z) * (1.0 - uChop * a.w);
    return vec4(slope, dot(slope, slope), jacobian);
  }

  void main() {
    out0 = cascade(0);
    out1 = cascade(1);
    out2 = cascade(2);
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
function jonswapAlpha({ hs, tp }: SeaState): number {
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
    m0 += ((G * G) / w ** 5) * Math.exp(-1.25 * (peak / w) ** 4) * GAMMA ** r * dw
  }
  return (hs * hs) / (16 * m0)
}

// Half floats halve the bandwidth of the 2 log2(N) passes, which dominate the frame cost;
// their 11-bit mantissa is ample for shading slopes.
function fftTarget(width: number, height: number) {
  return new THREE.WebGLRenderTarget(width, height, {
    type: THREE.HalfFloatType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: false,
    generateMipmaps: false,
  })
}

export class WaveSimulation {
  readonly textures: THREE.Texture[]
  private readonly quad = new FullScreenQuad()
  private readonly noise: THREE.DataTexture
  private readonly ping: THREE.WebGLRenderTarget
  private readonly pong: THREE.WebGLRenderTarget
  private readonly output: THREE.WebGLRenderTarget
  private readonly evolve: THREE.RawShaderMaterial
  private readonly fft: THREE.RawShaderMaterial
  private readonly resolve: THREE.RawShaderMaterial
  private readonly n: number
  private sea: SeaState | null = null

  constructor(renderer: THREE.WebGLRenderer, n: number) {
    this.n = n
    this.noise = gaussianNoise(n * CASCADES.length, n)
    this.ping = fftTarget(n * CASCADES.length, n)
    this.pong = fftTarget(n * CASCADES.length, n)
    this.output = new THREE.WebGLRenderTarget(n, n, {
      count: CASCADES.length,
      type: THREE.HalfFloatType,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      // Grazing views need some anisotropy; beyond 4x the three wave taps cost more than they show.
      anisotropy: Math.min(4, renderer.capabilities.getMaxAnisotropy()),
      depthBuffer: false,
      generateMipmaps: true,
    })
    this.textures = this.output.textures

    const raw = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>) =>
      new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VERTEX, fragmentShader, uniforms })
    const [l0, l1, l2] = CASCADES
    this.evolve = raw(EVOLVE, {
      uNoise: { value: this.noise },
      uN: { value: n },
      uTile: { value: new THREE.Vector3(l0, l1, l2) },
      uHandover: { value: new THREE.Vector2(((2 * Math.PI) / l1) * HANDOVER, ((2 * Math.PI) / l2) * HANDOVER) },
      uTime: { value: 0 },
      uAlpha: { value: 0 },
      uPeak: { value: 1 },
      uToward: { value: new THREE.Vector2(0, -1) },
    })
    this.fft = raw(FFT, {
      uA: { value: null },
      uN: { value: n },
      uSub: { value: 2 },
      uHorizontal: { value: true },
    })
    this.resolve = raw(RESOLVE, { uA: { value: null }, uN: { value: n }, uChop: { value: 1 } })
  }

  setSeaState(sea: SeaState) {
    const s = this.sea
    if (s && s.hs === sea.hs && s.tp === sea.tp && s.toward === sea.toward) return
    this.sea = sea
    const u = this.evolve.uniforms
    u.uAlpha.value = jonswapAlpha(sea)
    u.uPeak.value = (2 * Math.PI) / sea.tp
    // World +x is east and -z is north.
    u.uToward.value.set(Math.sin(sea.toward), -Math.cos(sea.toward))
  }

  update(renderer: THREE.WebGLRenderer, time: number) {
    const previous = renderer.getRenderTarget()
    this.evolve.uniforms.uTime.value = time
    this.run(renderer, this.evolve, this.ping)

    let src = this.ping
    let dst = this.pong
    for (const horizontal of [true, false]) {
      for (let sub = 2; sub <= this.n; sub *= 2) {
        const u = this.fft.uniforms
        u.uA.value = src.texture
        u.uSub.value = sub
        u.uHorizontal.value = horizontal
        this.run(renderer, this.fft, dst)
        ;[src, dst] = [dst, src]
      }
    }

    this.resolve.uniforms.uA.value = src.texture
    this.run(renderer, this.resolve, this.output)
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
    this.output.dispose()
    this.evolve.dispose()
    this.fft.dispose()
    this.resolve.dispose()
  }
}
