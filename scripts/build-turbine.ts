// Builds public/models/turbine.glb: a procedurally modelled 8 MW offshore turbine.
// Pipeline: three.js geometry -> meshoptimizer LOD -> glTF-Transform (weld, quantize,
// reorder, EXT_meshopt_compression). Nodes:
//   Tower, NacelleShell, Internals, Rotor          full detail (hero + near instances)
//   Body_LOD1, Rotor_LOD1                          simplified (far instances)

import * as THREE from 'three'
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { Document, NodeIO, type Material } from '@gltf-transform/core'
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions'
import { quantize, reorder } from '@gltf-transform/functions'
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer'
import { mkdir } from 'node:fs/promises'
import { TURBINE } from '../src/scene/turbine/spec.ts'

const { hubHeight, rotorRadius, hubOffsetZ } = TURBINE

const PAINT = {
  white: 0xe9ecee,
  grey: 0xb9c0c6,
  yellow: 0xf2b705,
  steel: 0x8a929a,
  dark: 0x3a4148,
  copper: 0xb86b3a,
  blue: 0x2f6f9f,
  red: 0xc23b2e,
}

function paint(geometry: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry
  g.deleteAttribute('uv')
  const c = new THREE.Color(hex)
  const colors = new Float32Array(g.attributes.position.count * 3)
  for (let i = 0; i < colors.length; i += 3) colors.set([c.r, c.g, c.b], i)
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  return g
}

function at(g: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) {
  g.applyMatrix4(
    new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
      new THREE.Vector3(1, 1, 1),
    ),
  )
  return g
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts)
  if (!merged) throw new Error('mergeGeometries failed')
  return mergeVertices(merged, 1e-4)
}

// ---------------------------------------------------------------- tower + foundation

function buildTower(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  // Transition piece (yellow) with a working platform, standing on a jacket below the waterline.
  parts.push(paint(at(new THREE.CylinderGeometry(3.6, 3.6, 14, 40, 1), 0, 13, 0), PAINT.yellow))
  parts.push(paint(at(new THREE.CylinderGeometry(7.5, 7.5, 0.8, 48, 1), 0, 20.4, 0), PAINT.grey))
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4
    const leg = new THREE.CylinderGeometry(0.7, 0.9, 30, 10)
    parts.push(paint(at(leg, Math.cos(a) * 6, -9, Math.sin(a) * 6, Math.sin(a) * 0.18, 0, -Math.cos(a) * 0.18), PAINT.yellow))
  }
  // Railing ring.
  parts.push(paint(at(new THREE.TorusGeometry(7.3, 0.12, 6, 64), 0, 21.8, 0, Math.PI / 2), PAINT.yellow))
  // Tapered tubular steel tower.
  const towerTop = hubHeight - 3.2
  const profile = [
    new THREE.Vector2(0.01, 21),
    new THREE.Vector2(3.4, 21),
    new THREE.Vector2(3.1, 50),
    new THREE.Vector2(2.6, 85),
    new THREE.Vector2(2.2, towerTop),
    new THREE.Vector2(0.01, towerTop),
  ]
  parts.push(paint(new THREE.LatheGeometry(profile, 48), PAINT.white))
  return merge(parts)
}

// ---------------------------------------------------------------- nacelle

const NACELLE = { length: 21, width: 8.6, height: 8.2, rearZ: -15, cornerRadius: 1.6 }

function roundedBox(w: number, h: number, d: number, r: number, segments = 6): THREE.BufferGeometry {
  const shape = new THREE.Shape()
  const x = -w / 2 + r
  const y = -h / 2 + r
  shape.moveTo(x, -h / 2)
  shape.lineTo(w / 2 - r, -h / 2)
  shape.quadraticCurveTo(w / 2, -h / 2, w / 2, y)
  shape.lineTo(w / 2, h / 2 - r)
  shape.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2)
  shape.lineTo(x, h / 2)
  shape.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r)
  shape.lineTo(-w / 2, y)
  shape.quadraticCurveTo(-w / 2, -h / 2, x, -h / 2)
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: d - 2 * r * 0.6,
    bevelEnabled: true,
    bevelSize: r * 0.6,
    bevelThickness: r * 0.6,
    bevelSegments: segments,
    curveSegments: segments,
  })
  g.translate(0, 0, -(d - 2 * r * 0.6) / 2)
  return g
}

function buildNacelleShell(): THREE.BufferGeometry {
  const { length, width, height, rearZ, cornerRadius } = NACELLE
  const cz = rearZ + length / 2
  const parts = [
    paint(at(roundedBox(width, height, length, cornerRadius), 0, hubHeight + 0.6, cz), PAINT.white),
    // Rooftop cooler and helihoist deck at the rear.
    paint(at(new THREE.BoxGeometry(6.4, 2.2, 4.5), 0, hubHeight + 5.8, rearZ + 4), PAINT.grey),
    paint(at(new THREE.BoxGeometry(7.6, 0.25, 7), 0, hubHeight + 4.85, rearZ + 4.5), PAINT.grey),
    // Aviation light.
    paint(at(new THREE.SphereGeometry(0.35, 12, 8), 2.6, hubHeight + 5.4, rearZ + 9), PAINT.red),
    // Collar between nacelle and spinner.
    paint(at(new THREE.CylinderGeometry(2.4, 3.0, 2.2, 40, 1, true), 0, hubHeight, rearZ + length + 0.6, Math.PI / 2), PAINT.white),
  ]
  return merge(parts)
}

function buildInternals(): THREE.BufferGeometry {
  const { rearZ, length } = NACELLE
  const y = hubHeight
  const front = rearZ + length
  const parts = [
    // Yaw bearing ring and bedplate.
    paint(at(new THREE.TorusGeometry(2.3, 0.35, 10, 48), 0, hubHeight - 3.4, -2, Math.PI / 2), PAINT.steel),
    paint(at(new THREE.BoxGeometry(5.2, 0.8, 16), 0, y - 3.0, rearZ + 9), PAINT.dark),
    // Main shaft and main bearing.
    paint(at(new THREE.CylinderGeometry(0.9, 1.1, 7, 32), 0, y, front - 3.5, Math.PI / 2), PAINT.steel),
    paint(at(new THREE.CylinderGeometry(1.8, 1.8, 1.6, 40), 0, y, front - 2, Math.PI / 2), PAINT.blue),
    // Gearbox.
    paint(at(new THREE.CylinderGeometry(2.3, 2.6, 4.2, 40), 0, y, front - 8.6, Math.PI / 2), PAINT.blue),
    paint(at(new THREE.CylinderGeometry(1.2, 1.2, 1.8, 24), 0, y + 0.4, front - 11.4, Math.PI / 2), PAINT.steel),
    // Generator with copper end windings.
    paint(at(new THREE.CylinderGeometry(2.2, 2.2, 4.6, 48), 0, y + 0.4, front - 14.6, Math.PI / 2), PAINT.dark),
    paint(at(new THREE.TorusGeometry(1.75, 0.32, 10, 40), 0, y + 0.4, front - 12.3), PAINT.copper),
    paint(at(new THREE.TorusGeometry(1.75, 0.32, 10, 40), 0, y + 0.4, front - 16.9), PAINT.copper),
    // Converter and transformer cabinets.
    paint(at(new THREE.BoxGeometry(1.4, 3.6, 4.4), 3.3, y - 0.6, rearZ + 3), PAINT.grey),
    paint(at(new THREE.BoxGeometry(1.4, 3.6, 4.4), -3.3, y - 0.6, rearZ + 3), PAINT.grey),
    paint(at(new THREE.BoxGeometry(3.2, 2.6, 2.6), 0, y - 1.6, rearZ + 1.6), PAINT.steel),
  ]
  return merge(parts)
}

// ---------------------------------------------------------------- rotor

function airfoil(t: number, n: number, roundness: number): THREE.Vector2[] {
  // NACA 4-digit symmetric thickness, blended toward a circle at the blade root.
  const pts: THREE.Vector2[] = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    const x = 0.5 - 0.5 * Math.cos(a) // 0 at leading edge, 1 at trailing edge
    const side = Math.sin(a) >= 0 ? 1 : -1
    const yt = 5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x ** 2 + 0.2843 * x ** 3 - 0.1036 * x ** 4)
    const foil = new THREE.Vector2(x - 0.3, side * yt)
    const circle = new THREE.Vector2(-0.5 * Math.cos(a) + 0.2, 0.5 * Math.sin(a))
    pts.push(foil.lerp(circle, roundness))
  }
  return pts
}

function buildBlade(): THREE.BufferGeometry {
  const stations = 24
  const ring = 18
  const rootR = 3.2
  const positions: number[] = []
  const indices: number[] = []
  for (let s = 0; s < stations; s++) {
    const f = s / (stations - 1)
    const r = rootR + f * (rotorRadius - rootR)
    const span = (r - rootR) / (rotorRadius - rootR)
    const chord = span < 0.18 ? 3.6 + (span / 0.18) * 2.0 : 5.6 * (1 - (span - 0.18) / 0.82) ** 0.85 + 0.6
    const roundness = Math.max(0, 1 - span / 0.16)
    const thickness = 0.36 - 0.24 * Math.min(1, span / 0.6)
    const twist = THREE.MathUtils.degToRad(13 * (1 - span) ** 1.6)
    const sweep = 0.9 * span ** 2
    for (const p of airfoil(thickness, ring, roundness)) {
      const x = p.x * chord
      const z = p.y * chord
      const cx = x * Math.cos(twist) - z * Math.sin(twist) + sweep
      const cz = x * Math.sin(twist) + z * Math.cos(twist)
      positions.push(cx, r, cz)
    }
  }
  for (let s = 0; s < stations - 1; s++) {
    for (let i = 0; i < ring; i++) {
      const a = s * ring + i
      const b = s * ring + ((i + 1) % ring)
      indices.push(a, a + ring, b, b, a + ring, b + ring)
    }
  }
  const tip = positions.length / 3
  positions.push(0.9, rotorRadius + 0.3, 0)
  for (let i = 0; i < ring; i++) {
    indices.push((stations - 1) * ring + i, tip, (stations - 1) * ring + ((i + 1) % ring))
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  g.setIndex(indices)
  g.computeVertexNormals()
  return g
}

function buildRotor(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const spinner = new THREE.SphereGeometry(3.1, 40, 24, 0, Math.PI * 2, 0, Math.PI / 2)
  spinner.scale(1, 1.25, 1)
  parts.push(paint(at(spinner, 0, 0, 0, Math.PI / 2), PAINT.white))
  parts.push(paint(at(new THREE.CylinderGeometry(3.1, 3.1, 1.8, 40), 0, 0, -0.9, Math.PI / 2), PAINT.white))
  const blade = buildBlade()
  for (let k = 0; k < 3; k++) {
    const b = blade.clone()
    // Red tip marking on every blade for aviation visibility.
    const colors = new Float32Array(b.attributes.position.count * 3)
    const white = new THREE.Color(PAINT.white)
    const red = new THREE.Color(PAINT.red)
    for (let i = 0; i < b.attributes.position.count; i++) {
      const c = b.attributes.position.getY(i) > rotorRadius - 6 ? red : white
      colors.set([c.r, c.g, c.b], i * 3)
    }
    b.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    parts.push(at(b, 0, 0, -0.8, 0, 0, (k / 3) * Math.PI * 2))
  }
  return merge(parts.map((p) => (p.index ? p.toNonIndexed() : p)))
}

// ---------------------------------------------------------------- LOD

await MeshoptSimplifier.ready
await MeshoptEncoder.ready

function simplify(g: THREE.BufferGeometry, ratio: number, error: number): THREE.BufferGeometry {
  const welded = mergeVertices(g.clone(), 1e-3)
  const index = new Uint32Array(welded.index!.array)
  const position = new Float32Array(welded.attributes.position.array)
  const target = Math.floor((index.length * ratio) / 3) * 3
  const [out] = MeshoptSimplifier.simplify(index, position, 3, target, error, ['LockBorder'])
  welded.setIndex(new THREE.BufferAttribute(out, 1))
  welded.deleteAttribute('normal')
  welded.computeVertexNormals()
  return welded
}

// ---------------------------------------------------------------- glTF document

const doc = new Document()
const buffer = doc.createBuffer()
const scene = doc.createScene('Turbine')

const paintMaterial = doc.createMaterial('Paint').setRoughnessFactor(0.42).setMetallicFactor(0.0)
const machineryMaterial = doc.createMaterial('Machinery').setRoughnessFactor(0.35).setMetallicFactor(0.55)

function addNode(name: string, g: THREE.BufferGeometry, material: Material, translation: [number, number, number] = [0, 0, 0]) {
  const geometry = g.index ? g : mergeVertices(g, 1e-4)
  const prim = doc.createPrimitive().setMaterial(material)
  const attr = (key: string, array: Float32Array, type: 'VEC3') =>
    doc.createAccessor(`${name}_${key}`).setType(type).setArray(array).setBuffer(buffer)
  prim.setAttribute('POSITION', attr('position', new Float32Array(geometry.attributes.position.array), 'VEC3'))
  prim.setAttribute('NORMAL', attr('normal', new Float32Array(geometry.attributes.normal.array), 'VEC3'))
  prim.setAttribute('COLOR_0', attr('color', new Float32Array(geometry.attributes.color.array), 'VEC3'))
  prim.setIndices(doc.createAccessor(`${name}_index`).setType('SCALAR').setArray(new Uint32Array(geometry.index!.array)).setBuffer(buffer))
  const mesh = doc.createMesh(name).addPrimitive(prim)
  const node = doc.createNode(name).setMesh(mesh).setTranslation(translation)
  scene.addChild(node)
  return { triangles: geometry.index!.count / 3 }
}

const hub: [number, number, number] = [0, hubHeight, hubOffsetZ]
const tower = buildTower()
const shell = buildNacelleShell()
const rotor = buildRotor()
const body = merge([tower.toNonIndexed(), shell.toNonIndexed()])

const stats = {
  Tower: addNode('Tower', tower, paintMaterial),
  NacelleShell: addNode('NacelleShell', shell, paintMaterial),
  Internals: addNode('Internals', buildInternals(), machineryMaterial),
  Rotor: addNode('Rotor', rotor, paintMaterial, hub),
  Body_LOD1: addNode('Body_LOD1', simplify(body, 0.12, 0.02), paintMaterial),
  Rotor_LOD1: addNode('Rotor_LOD1', simplify(rotor, 0.1, 0.02), paintMaterial, hub),
}
console.table(Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, v.triangles])))

await doc.transform(
  reorder({ encoder: MeshoptEncoder }),
  quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeColor: 8 }),
)
doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE })

await mkdir('public/models', { recursive: true })
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder })
await io.write('public/models/turbine.glb', doc)
console.log('wrote public/models/turbine.glb')
