import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef, type RefObject } from 'react'
import * as THREE from 'three'
import { useStore } from '../state'
import { createEngraving } from './engraving'

// Inkstone proportions: the face is the stone's +z side, uv is a planar projection onto it.
const HALF_W = 1.3
const HALF_H = 1.0
const DEPTH = 0.38
const MASK_SIZE = 1024
const GRID = 48
const BRUSH = 0.075
const DONE_AT = 0.5

function hash(x: number, y: number, z: number) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453
  return s - Math.floor(s)
}

/** Smoothly interpolated lattice noise that tiles with the given period. */
function valueNoise(x: number, y: number, period: number, seed: number) {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy
  const sx = fx * fx * (3 - 2 * fx)
  const sy = fy * fy * (3 - 2 * fy)
  const at = (i: number, j: number) => hash(((i % period) + period) % period, ((j % period) + period) % period, seed)
  const top = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * sx
  const bottom = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * sx
  return top + (bottom - top) * sy
}

function buildGeometry(): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, 160, 120)
  const p = g.attributes.position
  const uv = g.attributes.uv
  const v = new THREE.Vector3()
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i)
    // Squash to a pebble, flatten the face, and add low-frequency irregularity.
    const wobble = 1 + 0.035 * Math.sin(v.x * 3.1 + 1.3) * Math.cos(v.y * 2.7) + 0.02 * Math.sin(v.y * 5.3 + v.x * 2.1)
    const flat = Math.sign(v.z) * Math.pow(Math.abs(v.z), 1.9)
    p.setXYZ(i, v.x * HALF_W * wobble, v.y * HALF_H * wobble, flat * DEPTH)
    uv.setXY(i, p.getX(i) / (2 * HALF_W) + 0.5, p.getY(i) / (2 * HALF_H) + 0.5)
  }
  g.computeVertexNormals()
  return g
}

/** Tiling grain normal map: fine pits and scratches that polishing hides under a clear coat. */
function grainNormalMap(): THREE.DataTexture {
  const size = 512
  const heights = new Float32Array(size * size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let h = 0
      for (let o = 0; o < 5; o++) {
        const f = 2 ** o * 6
        h += valueNoise((x / size) * f, (y / size) * f, f, o) / 2 ** (o * 0.7)
      }
      heights[y * size + x] = h * 0.7 + hash(x, y, 9) * 0.35
    }
  }
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const at = (dx: number, dy: number) => heights[((y + dy + size) % size) * size + ((x + dx + size) % size)]
      const nx = (at(-1, 0) - at(1, 0)) * 1.4
      const ny = (at(0, -1) - at(0, 1)) * 1.4
      const len = Math.hypot(nx, ny, 1)
      const i = (y * size + x) * 4
      data[i] = ((nx / len) * 0.5 + 0.5) * 255
      data[i + 1] = ((ny / len) * 0.5 + 0.5) * 255
      data[i + 2] = (1 / len) * 255
      data[i + 3] = 255
    }
  }
  const t = new THREE.DataTexture(data, size, size)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.repeat.set(3, 3)
  t.generateMipmaps = true
  t.minFilter = THREE.LinearMipmapLinearFilter
  t.needsUpdate = true
  return t
}

export interface StoneHandle {
  progress: number
  finished: boolean
}

interface Props {
  handle: RefObject<StoneHandle>
  onStroke: (speed: number) => void
  onFinish: () => void
}

export function Stone({ handle, onStroke, onFinish }: Props) {
  const gl = useThree((s) => s.gl)
  const camera = useThree((s) => s.camera)
  const elevation = useStore((s) => s.elevation)
  const mesh = useRef<THREE.Mesh>(null)
  const pointer = useRef<{ down: boolean; last: THREE.Vector2 | null; time: number; speed: number }>({
    down: false,
    last: null,
    time: 0,
    speed: 0,
  })

  const res = useMemo(() => {
    const geometry = buildGeometry()
    const mask = new THREE.WebGLRenderTarget(MASK_SIZE, MASK_SIZE, { depthBuffer: false })
    const finish = { value: 0 }
    const material = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color('#2b322f'),
      roughness: 1,
      metalness: 0,
      roughnessMap: mask.texture,
      clearcoat: 1,
      clearcoatRoughness: 0.04,
      normalMap: grainNormalMap(),
      normalScale: new THREE.Vector2(1.8, 1.8),
      emissive: new THREE.Color('#e3b768'),
      emissiveIntensity: 0,
    })
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uFinish = finish
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uFinish;')
        .replace(
          '#include <roughnessmap_fragment>',
          /* glsl */ `
          float polish = max(texture2D(roughnessMap, vRoughnessMapUv).r, uFinish);
          float roughnessFactor = roughness * mix(1.0, 0.05, smoothstep(0.0, 1.0, polish));`,
        )
        .replace(
          '#include <clearcoat_normal_fragment_maps>',
          /* glsl */ `#include <clearcoat_normal_fragment_maps>
          // Polishing removes the grain: rough areas keep the stone's own normals.
          normal = normalize(mix(normal, nonPerturbedNormal, smoothstep(0.2, 1.0, polish) * 0.85));`,
        )
        .replace(
          '#include <emissivemap_fragment>',
          /* glsl */ `#include <emissivemap_fragment>
          totalEmissiveRadiance *= smoothstep(0.35, 1.0, polish);`,
        )
        .replace(
          '#include <lights_physical_fragment>',
          THREE.ShaderChunk.lights_physical_fragment.replace(
            'material.clearcoat = clearcoat;',
            'material.clearcoat = clearcoat * smoothstep(0.15, 1.0, polish);',
          ),
        )
    }
    material.customProgramCacheKey = () => 'inkstone'

    // Brush stamps are rendered additively into the mask's red channel.
    const brushScene = new THREE.Scene()
    const brushCamera = new THREE.OrthographicCamera(0, 1, 1, 0, -1, 1)
    const brushMaterial = new THREE.ShaderMaterial({
      uniforms: { uStrength: { value: 0 } },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: /* glsl */ `
        uniform float uStrength;
        varying vec2 vUv;
        void main() {
          float d = length(vUv - 0.5) * 2.0;
          float a = (1.0 - smoothstep(0.2, 1.0, d)) * uStrength;
          gl_FragColor = vec4(a, a, a, 1.0);
        }
      `,
    })
    const brush = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), brushMaterial)
    brushScene.add(brush)
    // The mask is in uv space, which is anisotropic on the stone: scale the stamp to stay round.
    brush.scale.set(BRUSH * 2, ((BRUSH * 2) * HALF_W) / HALF_H, 1)

    const coverage = new Float32Array(GRID * GRID)
    const inside: number[] = []
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const x = (i + 0.5) / GRID - 0.5
        const y = (j + 0.5) / GRID - 0.5
        if (x * x + y * y < 0.2) inside.push(j * GRID + i)
      }
    }
    return { geometry, mask, material, finish, brushScene, brushCamera, brush, brushMaterial, coverage, inside }
  }, [])

  // Clear the mask to "unpolished" once the renderer exists.
  useEffect(() => {
    const previous = gl.getRenderTarget()
    gl.setRenderTarget(res.mask)
    gl.setClearColor(0x000000, 1)
    gl.clear(true, false, false)
    gl.setRenderTarget(previous)
    return () => {
      res.mask.dispose()
      res.geometry.dispose()
      res.material.dispose()
      res.brushMaterial.dispose()
    }
  }, [gl, res])

  useEffect(() => {
    if (!elevation) return
    const engraving = createEngraving(elevation, HALF_W / HALF_H)
    res.material.emissiveMap = engraving
    res.material.emissiveIntensity = 1.6
    res.material.needsUpdate = true
    return () => engraving.dispose()
  }, [elevation, res])

  // Strokes are painted straight from pointer events, so fast or coalesced input never skips.
  useEffect(() => {
    const el = gl.domElement
    const ray = new THREE.Raycaster()
    const hits: THREE.Intersection[] = []
    const ndc = new THREE.Vector2()
    const p = pointer.current

    const uvAt = (e: PointerEvent): THREE.Vector2 | null => {
      const m = mesh.current
      if (!m) return null
      const r = el.getBoundingClientRect()
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
      ray.setFromCamera(ndc, camera)
      hits.length = 0
      ray.intersectObject(m, false, hits)
      const hit = hits[0]
      return hit?.uv && hit.face && hit.face.normal.z > 0 ? hit.uv.clone() : null
    }

    const paint = (from: THREE.Vector2, to: THREE.Vector2, strength: number) => {
      const dist = from.distanceTo(to)
      const steps = Math.max(1, Math.ceil(dist / (BRUSH * 0.25)))
      res.brushMaterial.uniforms.uStrength.value = strength
      const previous = gl.getRenderTarget()
      const autoClear = gl.autoClear
      gl.setRenderTarget(res.mask)
      gl.autoClear = false
      for (let s = 1; s <= steps; s++) {
        const t = s / steps
        const x = from.x + (to.x - from.x) * t
        const y = from.y + (to.y - from.y) * t
        res.brush.position.set(x, y, 0)
        gl.render(res.brushScene, res.brushCamera)
        stampCoverage(res.coverage, x, y, strength)
      }
      gl.autoClear = autoClear
      gl.setRenderTarget(previous)
    }

    const onDown = (e: PointerEvent) => {
      p.down = true
      p.last = uvAt(e)
      p.time = e.timeStamp
    }
    const onMove = (e: PointerEvent) => {
      if (!p.down || handle.current.finished) return
      const uv = uvAt(e)
      if (uv && p.last) {
        const dt = Math.max((e.timeStamp - p.time) / 1000, 1 / 240)
        const speed = p.last.distanceTo(uv) / dt
        p.speed += (speed - p.speed) * 0.3
        paint(p.last, uv, 0.05 + Math.min(speed, 3) * 0.035)
      }
      p.last = uv
      p.time = e.timeStamp
    }
    const onUp = () => {
      p.down = false
      p.last = null
    }
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [gl, camera, res, handle])

  useFrame(({ pointer: ndc, clock }, dt) => {
    const m = mesh.current
    if (!m) return
    const p = pointer.current
    // Gentle idle drift; frozen while polishing so strokes land where the finger is.
    if (!p.down) {
      m.rotation.x += (ndc.y * -0.12 + Math.sin(clock.elapsedTime * 0.4) * 0.03 - m.rotation.x) * Math.min(1, dt * 2)
      m.rotation.y += (ndc.x * 0.18 - m.rotation.y) * Math.min(1, dt * 2)
    }
    p.speed *= Math.exp(-dt * 6)
    onStroke(p.down ? Math.min(p.speed / 2.5, 1) : 0)

    const state = handle.current
    if (state.finished) {
      res.finish.value = Math.min(1, res.finish.value + dt * 0.9)
      return
    }
    let done = 0
    for (const i of res.inside) if (res.coverage[i] >= 0.8) done++
    state.progress = Math.min(1, done / res.inside.length / DONE_AT)
    if (state.progress >= 1) {
      state.finished = true
      onFinish()
    }
  })

  return <mesh ref={mesh} geometry={res.geometry} material={res.material} />
}

function stampCoverage(grid: Float32Array, u: number, v: number, strength: number) {
  const r = BRUSH * GRID
  const cx = u * GRID
  const cy = v * GRID
  for (let j = Math.max(0, Math.floor(cy - r)); j <= Math.min(GRID - 1, Math.ceil(cy + r)); j++) {
    for (let i = Math.max(0, Math.floor(cx - r)); i <= Math.min(GRID - 1, Math.ceil(cx + r)); i++) {
      const d = Math.hypot((i + 0.5 - cx) / r, ((j + 0.5 - cy) / r) * (HALF_H / HALF_W))
      if (d < 1) grid[j * GRID + i] = Math.min(1, grid[j * GRID + i] + strength * (1 - d))
    }
  }
}
