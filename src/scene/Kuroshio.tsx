import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { GPUComputationRenderer } from 'three/examples/jsm/misc/GPUComputationRenderer.js'
import type { Elevation } from '../data/elevation'
import { CURRENT_GRID } from '../data/openMeteo'
import { hourIndex, type Weather } from '../data/weather'
import { WORLD } from '../geo/domain'
import { useStore } from '../state'
import { atmosphere } from './atmosphere'

// Visual time compression: 1 m/s of real current moves a particle this many km per second.
const SPEED_SCALE = 7
/** Tracers are hidden below this camera altitude (km) and fully shown above TRACER_HIGH_KM. */
const TRACER_LOW_KM = 2
const TRACER_HIGH_KM = 12

function currentTexture(): THREE.DataTexture {
  const { cols, rows } = CURRENT_GRID
  const t = new THREE.DataTexture(new Uint16Array(cols * rows * 2), cols, rows, THREE.RGFormat, THREE.HalfFloatType)
  t.magFilter = t.minFilter = THREE.LinearFilter
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping
  return t
}

function upload(texture: THREE.DataTexture, frame: Float32Array) {
  const data = texture.image.data as Uint16Array
  for (let i = 0; i < frame.length; i++) data[i] = THREE.DataUtils.toHalfFloat(frame[i])
  texture.needsUpdate = true
}

// Grid samples sit on the domain corners; texel centres sit half a texel in.
const SAMPLE_CURRENT = /* glsl */ `
  uniform sampler2D uCur0;
  uniform sampler2D uCur1;
  uniform float uCurMix;
  vec2 currentAt(vec2 uv) {
    vec2 grid = vec2(${CURRENT_GRID.cols}.0, ${CURRENT_GRID.rows}.0);
    vec2 tc = (uv * (grid - 1.0) + 0.5) / grid;
    return mix(texture2D(uCur0, tc).rg, texture2D(uCur1, tc).rg, uCurMix);
  }
`

const SIMULATION = /* glsl */ `
  uniform float uDt;
  uniform float uSeed;
  uniform vec2 uDomainKm;
  uniform sampler2D uElevation;
  ${SAMPLE_CURRENT}

  float hash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  void main() {
    vec2 ref = gl_FragCoord.xy / resolution.xy;
    vec4 p = texture2D(tParticles, ref);
    vec2 vel = currentAt(p.xy);
    // Domain v grows southward, so northward flow decreases v.
    p.xy += vec2(vel.x, -vel.y) * ${SPEED_SCALE.toFixed(1)} * uDt / uDomainKm;
    p.z += uDt;

    float land = step(-0.004, texture2D(uElevation, p.xy).r);
    bool outside = any(lessThan(p.xy, vec2(0.0))) || any(greaterThan(p.xy, vec2(1.0)));
    if (p.z > p.w || outside || land > 0.5 || length(vel) < 0.03) {
      float a = hash(ref * 913.7 + uSeed);
      float b = hash(ref * 377.1 + uSeed * 1.37);
      p = vec4(a, b, 0.0, 3.0 + 6.0 * hash(ref + uSeed * 0.71));
    }
    gl_FragColor = p;
  }
`

function createMaterial(elevation: Elevation) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...atmosphere,
      tParticles: { value: null },
      uCur0: { value: null },
      uCur1: { value: null },
      uCurMix: { value: 0 },
      uDomain: { value: new THREE.Vector4(WORLD.minX, WORLD.minZ, WORLD.width, WORLD.depth) },
      uElevation: { value: elevation.texture },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    // Quads are laid flat in XZ, which flips their winding when seen from above.
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      uniform sampler2D tParticles;
      uniform vec4 uDomain;
      uniform vec3 uCameraPos;
      uniform float uDay;
      ${SAMPLE_CURRENT}
      attribute vec2 aRef;
      varying vec2 vQuad;
      varying float vAlpha;
      varying float vSpeed;
      void main() {
        vec4 p = texture2D(tParticles, aRef);
        vec2 vel = currentAt(p.xy);
        float speed = length(vel);
        vec2 dir = speed > 1e-4 ? vec2(vel.x, -vel.y) / speed : vec2(1.0, 0.0);
        vec2 ground = uDomain.xy + p.xy * uDomain.zw;
        vec3 center = vec3(ground.x, 0.03, ground.y);
        float dist = length(center - uCameraPos);
        // Streak length follows speed; width holds a steady on-screen thickness.
        float len = (clamp(speed, 0.0, 1.8) * 4.5 + 0.8) * clamp(dist / 220.0, 0.012, 1.0);
        float width = clamp(dist * 0.0011, 0.008, 0.6);
        vec2 side = vec2(-dir.y, dir.x);
        vec2 offset = dir * position.x * len + side * position.y * width;
        vec3 world = center + vec3(offset.x, 0.0, offset.y);
        gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
        vQuad = position.xy;
        float life = smoothstep(0.0, 0.8, p.z) * (1.0 - smoothstep(p.w - 1.2, p.w, p.z));
        vec2 edge = min(p.xy, 1.0 - p.xy);
        vAlpha = life * smoothstep(0.08, 0.9, speed) * smoothstep(0.0, 0.07, min(edge.x, edge.y));
        // A map device: it fades in as the eye climbs, and down among the turbines it would only
        // read as streaks shooting across the water.
        vAlpha *= smoothstep(${TRACER_LOW_KM.toFixed(1)}, ${TRACER_HIGH_KM.toFixed(1)}, uCameraPos.y);
        vSpeed = speed;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uDay;
      uniform float uDebug;
      varying vec2 vQuad;
      varying float vAlpha;
      varying float vSpeed;
      void main() {
        // Comet profile: bright head at +x, fading tail, soft across.
        float head = smoothstep(-0.5, 0.5, vQuad.x);
        float across = 1.0 - smoothstep(0.0, 0.5, abs(vQuad.y));
        float a = head * head * across * vAlpha;
        vec3 slow = vec3(0.05, 0.30, 0.55);
        vec3 fast = vec3(0.55, 0.95, 1.0);
        vec3 col = mix(slow, fast, smoothstep(0.35, 1.2, vSpeed));
        // A quiet tracer by day so the sea itself reads; it glows at night and in engineering mode.
        float gain = mix(1.5, 0.38, uDay) + uDebug * 1.2;
        gl_FragColor = vec4(col * a * gain, 1.0);
      }
    `,
  })
}

interface Simulation {
  gpu: GPUComputationRenderer
  variable: ReturnType<GPUComputationRenderer['addVariable']>
  cur0: THREE.DataTexture
  cur1: THREE.DataTexture
  mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>
}

function createSimulation(gl: THREE.WebGLRenderer, size: number, elevation: Elevation): Simulation {
  const gpu = new GPUComputationRenderer(size, size, gl)
  const initial = gpu.createTexture()
  const data = initial.image.data as Float32Array
  for (let i = 0; i < data.length; i += 4) {
    data[i] = Math.random()
    data[i + 1] = Math.random()
    data[i + 2] = Math.random() * 6
    data[i + 3] = 3 + Math.random() * 6
  }
  const variable = gpu.addVariable('tParticles', SIMULATION, initial)
  gpu.setVariableDependencies(variable, [variable])
  const cur0 = currentTexture()
  const cur1 = currentTexture()
  Object.assign(variable.material.uniforms, {
    uDt: { value: 0 },
    uSeed: { value: 0 },
    uDomainKm: { value: new THREE.Vector2(WORLD.width, WORLD.depth) },
    uElevation: { value: elevation.texture },
    uCur0: { value: cur0 },
    uCur1: { value: cur1 },
    uCurMix: { value: 0 },
  })
  const error = gpu.init()
  if (error) throw new Error(`Kuroshio GPGPU: ${error}`)

  // One camera-facing-flat streak quad per particle, positioned entirely on the GPU.
  const geometry = new THREE.InstancedBufferGeometry()
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3),
  )
  geometry.setIndex([0, 1, 2, 0, 2, 3])
  const refs = new Float32Array(size * size * 2)
  for (let i = 0; i < size * size; i++) {
    refs[i * 2] = ((i % size) + 0.5) / size
    refs[i * 2 + 1] = (Math.floor(i / size) + 0.5) / size
  }
  geometry.setAttribute('aRef', new THREE.InstancedBufferAttribute(refs, 2))
  geometry.instanceCount = size * size
  const material = createMaterial(elevation)
  material.uniforms.uCur0.value = cur0
  material.uniforms.uCur1.value = cur1
  const mesh = new THREE.Mesh(geometry, material)
  mesh.frustumCulled = false
  mesh.renderOrder = 2
  return { gpu, variable, cur0, cur1, mesh }
}

function disposeSimulation(sim: Simulation) {
  sim.gpu.dispose()
  sim.cur0.dispose()
  sim.cur1.dispose()
  sim.mesh.geometry.dispose()
  sim.mesh.material.dispose()
}

export function Kuroshio({ elevation, weather, size }: { elevation: Elevation; weather: Weather; size: number }) {
  const gl = useThree((s) => s.gl)
  const [sim, setSim] = useState<Simulation | null>(null)
  const loadedHour = useRef(-1)

  useEffect(() => {
    const next = createSimulation(gl, size, elevation)
    loadedHour.current = -1
    setSim(next)
    return () => disposeSimulation(next)
  }, [gl, size, elevation])

  // Refreshed weather may hold different currents for the same hour.
  useEffect(() => {
    loadedHour.current = -1
  }, [weather])

  useFrame(({ camera }, rawDt) => {
    if (!sim) return
    sim.mesh.visible = camera.position.y > TRACER_LOW_KM
    const dt = Math.min(rawDt, 0.05)
    const f = hourIndex(weather, useStore.getState().time)
    const hour = Math.floor(f)
    if (hour !== loadedHour.current) {
      const next = Math.min(hour + 1, weather.currents.length - 1)
      upload(sim.cur0, weather.currents[hour])
      upload(sim.cur1, weather.currents[next])
      loadedHour.current = hour
    }
    const u = sim.variable.material.uniforms
    u.uDt.value = dt
    u.uSeed.value = (u.uSeed.value + 0.6180339) % 1000
    u.uCurMix.value = f - hour
    sim.gpu.compute()
    const m = sim.mesh.material.uniforms
    m.tParticles.value = sim.gpu.getCurrentRenderTarget(sim.variable).texture
    m.uCurMix.value = f - hour
  })

  return sim && <primitive object={sim.mesh} />
}
