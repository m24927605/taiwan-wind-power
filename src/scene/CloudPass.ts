import { Pass } from 'postprocessing'
import * as THREE from 'three'
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'
import { ATMOSPHERE_GLSL, atmosphere } from './atmosphere'
import { CLOUDS_GLSL, clouds } from './clouds'

// Volumetric clouds over the rendered scene. The clouds are ray-marched at reduced resolution,
// one pixel of each 2x2 block per frame in rotation, and accumulated over frames by reprojection
// through their own depth; the scene's depth buffer stops each ray at whatever it would hit.
// A joint bilateral upsample keeps the horizon crisp, and crepuscular rays are traced through
// gaps in the clouds toward the sun.

const VERTEX = /* glsl */ `
  in vec3 position;
  void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`

const HEADER = /* glsl */ `
  precision highp float;
  precision highp int;
  precision highp sampler2D;
  ${ATMOSPHERE_GLSL}
  ${CLOUDS_GLSL}
  uniform mat4 uProjInv;
  uniform mat4 uCamToWorld;
  vec3 viewDir(vec2 uv) {
    vec4 v = uProjInv * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
    return normalize(mat3(uCamToWorld) * (v.xyz / v.w));
  }
  // Distance (km) to what the scene drew at a pixel; the sky is "infinitely" far.
  float sceneDistance(sampler2D depthTexture, ivec2 px, vec2 size) {
    float depth = texelFetch(depthTexture, px, 0).r;
    if (depth >= 0.999999) return 1e5;
    vec4 v = uProjInv * vec4((vec2(px) + 0.5) / size * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    return length(v.xyz / v.w);
  }
`

const MARCH = /* glsl */ `
  ${HEADER}
  uniform sampler2D uDepth;
  uniform vec2 uSceneSize;
  uniform vec2 uSize;
  uniform float uDiv;
  uniform float uFrame;
  uniform vec2 uOffset;
  layout(location = 0) out vec4 outColor;
  layout(location = 1) out vec4 outDepth;
  // Interleaved gradient noise, advanced by the golden ratio each frame.
  float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
  void main() {
    // One pixel of each 2x2 block per frame, in rotation.
    vec2 pixel = floor(gl_FragCoord.xy) * 2.0 + uOffset + 0.5;
    vec3 dir = viewDir(pixel / uSize);
    ivec2 sp = min(ivec2(pixel * uDiv), ivec2(uSceneSize) - 1);
    float scene = sceneDistance(uDepth, sp, uSceneSize);
    float depth;
    // Seen from above, the layer is a thin slab under every pixel: fewer, coarser steps suffice.
    bool above = uCameraPos.y > CLOUD_TOP + 10.0;
    vec4 c = marchClouds(uCameraPos, dir, scene, above ? 28 : 84, above ? 2 : 4, true, fract(ign(pixel) + uFrame * 0.618034), depth);
    outColor = c;
    outDepth = vec4(depth, scene, 0.0, 1.0);
  }
`

const TEMPORAL = /* glsl */ `
  ${HEADER}
  uniform sampler2D uCurColor;
  uniform sampler2D uCurDepth;
  uniform sampler2D uHistColor;
  uniform mat4 uPrevViewProj;
  uniform vec2 uSize;
  uniform float uReset;
  uniform vec2 uOffset;
  layout(location = 0) out vec4 outColor;
  layout(location = 1) out vec4 outDepth;
  void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    ivec2 maxQ = textureSize(uCurColor, 0) - 1;
    ivec2 q = min(p / 2, maxQ);
    bool fresh = all(equal(p - (p / 2) * 2, ivec2(uOffset)));
    vec4 c = texelFetch(uCurColor, q, 0);
    vec4 cd = texelFetch(uCurDepth, q, 0);
    vec4 lo = c, hi = c;
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
      vec4 n = texelFetch(uCurColor, clamp(q + ivec2(x, y), ivec2(0), maxQ), 0);
      lo = min(lo, n);
      hi = max(hi, n);
    }
    // Reproject through the clouds' own depth; clear sky reprojects as a pure direction.
    vec3 dir = viewDir(gl_FragCoord.xy / uSize);
    float depth = cd.x > 0.0 ? cd.x : 1e4;
    vec4 clip = uPrevViewProj * vec4(uCameraPos + dir * depth, 1.0);
    vec2 puv = clip.xy / clip.w * 0.5 + 0.5;
    bool valid = uReset < 0.5 && clip.w > 0.0 && all(greaterThanEqual(puv, vec2(0.0))) && all(lessThanEqual(puv, vec2(1.0)));
    // A pixel marched this frame refines its history; the other three are carried by reprojection.
    vec4 h = clamp(texture(uHistColor, puv), lo, hi);
    outColor = valid ? mix(h, c, fresh ? 0.3 : 0.0) : c;
    outDepth = cd;
  }
`

const COMPOSITE = /* glsl */ `
  ${HEADER}
  uniform sampler2D uScene;
  uniform sampler2D uDepth;
  uniform sampler2D uCloudColor;
  uniform sampler2D uCloudDepth;
  uniform vec2 uSceneSize;
  uniform vec2 uCloudSize;
  uniform vec3 uSunScreen;
  out vec4 outColor;
  void main() {
    ivec2 px = ivec2(gl_FragCoord.xy);
    vec2 uv = gl_FragCoord.xy / uSceneSize;
    vec4 s = texelFetch(uScene, px, 0);
    float scene = sceneDistance(uDepth, px, uSceneSize);

    // Joint bilateral upsampling: low-resolution cloud texels only count where they saw the same
    // scene depth, so the horizon and the turbines stay crisp against the sky.
    vec2 cp = uv * uCloudSize - 0.5;
    ivec2 i0 = ivec2(floor(cp));
    vec2 f = fract(cp);
    ivec2 maxP = ivec2(uCloudSize) - 1;
    vec4 acc = vec4(0.0);
    float wsum = 0.0;
    for (int k = 0; k < 4; k++) {
      ivec2 o = ivec2(k & 1, k >> 1);
      ivec2 q = clamp(i0 + o, ivec2(0), maxP);
      float wb = (o.x == 1 ? f.x : 1.0 - f.x) * (o.y == 1 ? f.y : 1.0 - f.y);
      float sd = texelFetch(uCloudDepth, q, 0).y;
      float wd = 1.0 / (0.02 + abs(sd - scene) / max(min(sd, scene), 1e-4));
      float w = wb * wd + 1e-5;
      acc += texelFetch(uCloudColor, q, 0) * w;
      wsum += w;
    }
    vec4 cl = acc / wsum;
    vec3 col = s.rgb * cl.a + cl.rgb * uExposure;

    // Crepuscular rays: haze lit through gaps in the clouds between the pixel and the sun.
    if (uSunScreen.z > 0.0 && scene > 1e4) {
      vec2 delta = (uSunScreen.xy - uv) / 24.0;
      vec2 q = uv + delta * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
      float lit = 0.0, norm = 0.0, decay = 1.0;
      for (int i = 0; i < 24; i++) {
        q += delta;
        float open = texture(uCloudColor, q).a * step(1e4, texture(uCloudDepth, q).y);
        lit += open * decay;
        norm += decay;
        decay *= 0.93;
      }
      lit /= norm;
      float c = max(dot(viewDir(uv), uSunDir), 0.0);
      col += sunIrradiance(uCameraPos.y) * lit * pow(c, 10.0) * 0.0066 * uSunScreen.z * uExposure;
    }
    col = mix(s.rgb, col, cloudFade());
    // Seen from above, the high cloud lies over everything below it (from below it is in the sky).
    if (uCameraPos.y > HIGH_CLOUD) {
      vec4 h = highCloud(viewDir(uv), uCameraPos);
      col = mix(col, h.rgb * uExposure, h.a);
    }
    outColor = vec4(col, s.a);
  }
`

/** The order in which each 2x2 block of cloud pixels gets marched. */
const CHECKER: [number, number][] = [
  [0, 0],
  [1, 1],
  [1, 0],
  [0, 1],
]

export class CloudPass extends Pass {
  private readonly quad = new FullScreenQuad()
  private readonly current: THREE.WebGLRenderTarget
  private readonly history: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget]
  private readonly march: THREE.RawShaderMaterial
  private readonly temporal: THREE.RawShaderMaterial
  private readonly composite: THREE.RawShaderMaterial
  private readonly prevViewProj = new THREE.Matrix4()
  private readonly sceneSize = new THREE.Vector2(1, 1)
  private readonly cloudSize = new THREE.Vector2(1, 1)
  private readonly offset = new THREE.Vector2()
  private readonly sun = new THREE.Vector3()
  private readonly forward = new THREE.Vector3()
  private index = 0
  private frame = 0
  private reset = true
  /** Cloud pixels per scene pixel along each axis. */
  divisor = 2

  private readonly view: THREE.PerspectiveCamera

  constructor(view: THREE.PerspectiveCamera) {
    super('CloudPass')
    this.view = view
    this.needsDepthTexture = true
    const pair = () =>
      new THREE.WebGLRenderTarget(1, 1, {
        count: 2,
        type: THREE.HalfFloatType,
        depthBuffer: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      })
    this.current = pair()
    this.history = [pair(), pair()]
    const shared = {
      ...atmosphere,
      ...clouds,
      uProjInv: { value: view.projectionMatrixInverse },
      uCamToWorld: { value: view.matrixWorld },
    }
    const raw = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>) =>
      new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: VERTEX,
        fragmentShader,
        uniforms: { ...shared, ...uniforms },
        depthTest: false,
        depthWrite: false,
      })
    const depth = { value: null as THREE.Texture | null }
    const offset = { value: this.offset }
    this.march = raw(MARCH, {
      uDepth: depth,
      uSceneSize: { value: this.sceneSize },
      uSize: { value: this.cloudSize },
      uDiv: { value: 2 },
      uFrame: { value: 0 },
      uOffset: offset,
    })
    this.temporal = raw(TEMPORAL, {
      uCurColor: { value: null },
      uCurDepth: { value: null },
      uHistColor: { value: null },
      uPrevViewProj: { value: this.prevViewProj },
      uSize: { value: this.cloudSize },
      uReset: { value: 1 },
      uOffset: offset,
    })
    this.composite = raw(COMPOSITE, {
      uScene: { value: null },
      uDepth: depth,
      uCloudColor: { value: null },
      uCloudDepth: { value: null },
      uSceneSize: { value: this.sceneSize },
      uCloudSize: { value: this.cloudSize },
      uSunScreen: { value: new THREE.Vector3() },
    })
  }

  override setDepthTexture(depthTexture: THREE.Texture) {
    this.march.uniforms.uDepth.value = depthTexture
  }

  override setSize(width: number, height: number) {
    const div = this.divisor
    this.march.uniforms.uDiv.value = div
    this.sceneSize.set(width, height)
    this.cloudSize.set(Math.ceil(width / div), Math.ceil(height / div))
    this.current.setSize(Math.ceil(this.cloudSize.x / 2), Math.ceil(this.cloudSize.y / 2))
    for (const h of this.history) h.setSize(this.cloudSize.x, this.cloudSize.y)
    this.reset = true
  }

  override render(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget, outputBuffer: THREE.WebGLRenderTarget | null) {
    const draw = (material: THREE.Material, target: THREE.WebGLRenderTarget | null) => {
      this.quad.material = material
      renderer.setRenderTarget(target)
      this.quad.render(renderer)
    }
    const camera = this.view
    this.march.uniforms.uFrame.value = this.frame % 4096
    this.offset.fromArray(CHECKER[this.frame % 4])
    this.frame++
    draw(this.march, this.current)

    const previous = this.history[this.index]
    const next = this.history[1 - this.index]
    const t = this.temporal.uniforms
    t.uCurColor.value = this.current.textures[0]
    t.uCurDepth.value = this.current.textures[1]
    t.uHistColor.value = previous.textures[0]
    t.uReset.value = this.reset ? 1 : 0
    draw(this.temporal, next)

    const c = this.composite.uniforms
    c.uScene.value = inputBuffer.texture
    c.uCloudColor.value = next.textures[0]
    c.uCloudDepth.value = next.textures[1]
    const sunPoint = this.sun.copy(camera.position).addScaledVector(atmosphere.uSunDir.value, 1e4).project(camera)
    const facing = camera.getWorldDirection(this.forward).dot(atmosphere.uSunDir.value)
    c.uSunScreen.value.set(sunPoint.x * 0.5 + 0.5, sunPoint.y * 0.5 + 0.5, THREE.MathUtils.smoothstep(facing, 0.2, 0.6))
    draw(this.composite, this.renderToScreen ? null : outputBuffer)

    this.index = 1 - this.index
    this.reset = false
    this.prevViewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
  }

  override dispose() {
    super.dispose()
    this.quad.dispose()
    this.current.dispose()
    for (const h of this.history) h.dispose()
    this.march.dispose()
    this.temporal.dispose()
    this.composite.dispose()
  }
}
