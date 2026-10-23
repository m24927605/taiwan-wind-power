import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'
import { ATMOSPHERE_GLSL, atmosphere } from './atmosphere'
import { CLOUDS_GLSL, clouds } from './clouds'

// Renders the atmosphere's lookup tables and meters the exposure. Transmittance and multiple
// scattering depend only on the medium and are drawn once; the two sky views and the ambient
// average follow the key light and the camera every frame (they are small).

const VERTEX = /* glsl */ `
  in vec3 position;
  void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`
const HEADER = /* glsl */ `
  precision highp float;
  precision highp int;
  precision highp sampler2D;
  ${ATMOSPHERE_GLSL}
  out vec4 outColor;
`

const TRANSMITTANCE = /* glsl */ `
  void main() {
    vec2 uv = gl_FragCoord.xy / vec2(256.0, 64.0);
    float H = sqrt(RT * RT - RG * RG);
    float rho = H * uv.y;
    float r = sqrt(rho * rho + RG * RG);
    float dmin = RT - r;
    float dmax = rho + H;
    float d = dmin + uv.x * (dmax - dmin);
    float mu = d < 1e-4 ? 1.0 : clamp((H * H - rho * rho - d * d) / (2.0 * r * d), -1.0, 1.0);
    vec3 od = vec3(0.0);
    float dt = d / 40.0;
    for (int i = 0; i < 40; i++) {
      float t = (float(i) + 0.5) * dt;
      od += mediumAt(sqrt(r * r + t * t + 2.0 * r * mu * t) - RG).ext * dt;
    }
    outColor = vec4(exp(-od), 1.0);
  }
`

// Second-order light averaged over the sphere, summed as a geometric series of further orders.
const MULTISCATTER = /* glsl */ `
  void main() {
    vec2 uv = gl_FragCoord.xy / 32.0;
    float muS = uv.x * 2.0 - 1.0;
    float r = RG + max(uv.y * (RT - RG), 0.01);
    vec3 sun = vec3(sqrt(max(1.0 - muS * muS, 0.0)), muS, 0.0);
    vec3 origin = vec3(0.0, r, 0.0);
    vec3 L2 = vec3(0.0);
    vec3 fms = vec3(0.0);
    for (int i = 0; i < 8; i++) for (int j = 0; j < 8; j++) {
      float cosT = 1.0 - 2.0 * (float(i) + 0.5) / 8.0;
      float sinT = sqrt(1.0 - cosT * cosT);
      float phi = 2.0 * PI * (float(j) + 0.5) / 8.0;
      vec3 dir = vec3(sinT * cos(phi), cosT, sinT * sin(phi));
      bool ground = hitsGround(r, cosT);
      float tMax = ground ? distToGround(r, cosT) : distToTop(r, cosT);
      float dt = tMax / 20.0;
      vec3 T = vec3(1.0);
      for (int s = 0; s < 20; s++) {
        vec3 p = origin + dir * ((float(s) + 0.5) * dt);
        float pr = length(p);
        Medium m = mediumAt(pr - RG);
        vec3 scat = m.scatR + m.scatM;
        vec3 ext = max(m.ext, vec3(1e-7));
        vec3 sampleT = exp(-m.ext * dt);
        vec3 S = scat * sunTransmittance(pr, dot(p, sun) / pr) / (4.0 * PI);
        L2 += T * (S - S * sampleT) / ext;
        fms += T * (scat - scat * sampleT) / ext;
        T *= sampleT;
      }
      if (ground) {
        vec3 p = origin + dir * tMax;
        vec3 n = normalize(p);
        // Mostly sea: a low diffuse albedo.
        L2 += T * sunTransmittance(length(p), dot(n, sun)) * max(dot(n, sun), 0.0) * 0.06 / PI;
      }
    }
    L2 /= 64.0;
    fms /= 64.0;
    outColor = vec4(L2 / (1.0 - fms), 1.0);
  }
`

const SKY_VIEW = /* glsl */ `
  uniform float uViewAlt;
  uniform vec2 uSize;
  void main() {
    vec3 dir = skyDir(gl_FragCoord.xy / uSize);
    float r = RG + uViewAlt;
    float tMax = hitsGround(r, dir.y) ? distToGround(r, dir.y) : distToTop(r, dir.y);
    vec3 T;
    // Airglow and starlight: the floor of the night sky.
    vec3 night = vec3(0.35, 0.5, 1.0) * 8e-5 * smoothstep(-0.1, 0.2, dir.y);
    outColor = vec4(integrateScattering(uViewAlt, dir, tMax, 40, T) + night, 1.0);
  }
`

// Cosine-weighted mean radiance of the ground sky, and its zenith.
const AMBIENT = /* glsl */ `
  void main() {
    if (gl_FragCoord.x > 1.0) {
      outColor = vec4(groundSkyRadiance(vec3(0.0, 1.0, 0.0)), 1.0);
      return;
    }
    vec3 sum = vec3(0.0);
    float wsum = 0.0;
    for (int i = 0; i < 8; i++) for (int j = 0; j < 5; j++) {
      float el = (float(j) + 0.5) / 5.0 * PI * 0.5;
      float az = (float(i) + 0.5) / 8.0 * 2.0 * PI;
      float w = sin(el) * cos(el);
      sum += groundSkyRadiance(vec3(cos(el) * sin(az), sin(el), -cos(el) * cos(az))) * w;
      wsum += w;
    }
    outColor = vec4(sum / wsum, 1.0);
  }
`

// What the sea reflects: the ground sky with cirrus and the clouds seen from the surface.
const GROUND_ENV = /* glsl */ `
  ${CLOUDS_GLSL}
  uniform vec3 uOrigin;
  void main() {
    vec3 d = skyDir(gl_FragCoord.xy / vec2(256.0, 128.0));
    vec3 col = texelFetch(uGroundSky, ivec2(gl_FragCoord.xy), 0).rgb;
    col = applyHighCloud(col, d, uOrigin);
    if (d.y > -0.01) {
      float depth;
      vec4 c = marchClouds(uOrigin, d, 1e9, 30, 3, false, 0.5, depth);
      col = col * c.a + c.rgb;
    }
    outColor = vec4(col, 1.0);
  }
`

/**
 * Exposure from the mean sky radiance, the way a camera meters a scene that is mostly sky and
 * sea. Partial adaptation, so dusk still looks like dusk.
 */
const EXPOSURE_KEY = 0.083
const EXPOSURE_ADAPTATION = 0.82
const MAX_EXPOSURE = 3000

const target = (w: number, h: number, options: THREE.RenderTargetOptions = {}) =>
  new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    depthBuffer: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
    ...options,
  })

export function AtmosphereLuts() {
  const gl = useThree((s) => s.gl)

  const luts = useMemo(() => {
    const raw = (fragment: string, uniforms: Record<string, THREE.IUniform> = {}) =>
      new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: VERTEX,
        fragmentShader: HEADER + fragment,
        uniforms: { ...atmosphere, ...clouds, ...uniforms },
        depthTest: false,
        depthWrite: false,
      })
    return {
      quad: new FullScreenQuad(),
      transmittance: target(256, 64),
      multiScatter: target(32, 32),
      skyView: target(256, 128, { wrapS: THREE.RepeatWrapping }),
      groundSky: target(256, 128, { wrapS: THREE.RepeatWrapping }),
      ambient: target(2, 1, { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter }),
      groundEnv: target(256, 128, { wrapS: THREE.RepeatWrapping, minFilter: THREE.LinearMipmapLinearFilter, generateMipmaps: true }),
      frame: 0,
      materials: {
        transmittance: raw(TRANSMITTANCE),
        multiScatter: raw(MULTISCATTER),
        skyView: raw(SKY_VIEW, { uViewAlt: { value: 0 }, uSize: { value: new THREE.Vector2(256, 128) } }),
        ambient: raw(AMBIENT),
        groundEnv: raw(GROUND_ENV, { uOrigin: { value: new THREE.Vector3() } }),
      },
      drawn: false,
      reading: false,
      ambientMean: new Float32Array(8),
      exposureTarget: atmosphere.uExposure.value,
    }
  }, [])

  useEffect(() => {
    atmosphere.uTransmittance.value = luts.transmittance.texture
    atmosphere.uMultiScatter.value = luts.multiScatter.texture
    atmosphere.uSkyView.value = luts.skyView.texture
    atmosphere.uGroundSky.value = luts.groundSky.texture
    atmosphere.uAmbient.value = luts.ambient.texture
    atmosphere.uGroundEnv.value = luts.groundEnv.texture
    return () => {
      luts.quad.dispose()
      for (const t of [luts.transmittance, luts.multiScatter, luts.skyView, luts.groundSky, luts.ambient, luts.groundEnv]) t.dispose()
      for (const m of Object.values(luts.materials)) m.dispose()
      luts.drawn = false
    }
  }, [luts])

  useFrame(({ camera }, dt) => {
    const previous = gl.getRenderTarget()
    const draw = (material: THREE.Material, renderTarget: THREE.WebGLRenderTarget) => {
      luts.quad.material = material
      gl.setRenderTarget(renderTarget)
      luts.quad.render(gl)
    }
    const m = luts.materials
    if (!luts.drawn) {
      draw(m.transmittance, luts.transmittance)
      draw(m.multiScatter, luts.multiScatter)
      luts.drawn = true
    }
    m.skyView.uniforms.uViewAlt.value = Math.max(camera.position.y, 0.001)
    draw(m.skyView, luts.skyView)
    m.skyView.uniforms.uViewAlt.value = 0.002
    draw(m.skyView, luts.groundSky)
    draw(m.ambient, luts.ambient)
    // Clouds drift slowly and the reflection is blurred: refresh it every fourth frame.
    if (luts.frame++ % 4 === 0) {
      m.groundEnv.uniforms.uOrigin.value.set(camera.position.x, 0.002, camera.position.z)
      draw(m.groundEnv, luts.groundEnv)
    }
    gl.setRenderTarget(previous)

    if (!luts.reading) {
      luts.reading = true
      gl.readRenderTargetPixelsAsync(luts.ambient, 0, 0, 2, 1, luts.ambientMean)
        .then(() => {
          const a = luts.ambientMean
          const luminance = 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2]
          luts.exposureTarget = Math.min(EXPOSURE_KEY / Math.max(luminance, 1e-9) ** EXPOSURE_ADAPTATION, MAX_EXPOSURE)
        })
        .finally(() => (luts.reading = false))
    }
    // Eyes adapt over a second or two.
    const e = atmosphere.uExposure
    e.value += (luts.exposureTarget - e.value) * Math.min(1, Math.min(dt, 0.1) * 2)
  })

  return null
}
