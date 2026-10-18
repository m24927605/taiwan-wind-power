// Builds public/models/turbine.glb: a procedurally modelled 8 MW-class offshore turbine of the
// medium-speed kind installed in the strait (V164/V174 family): a long rounded nacelle with a
// rooftop cooler and a helicopter hoisting deck, a tapered tower on a yellow transition piece and
// platform, standing on a four-legged jacket with a boat landing.
//
// Every vertex carries its albedo (COLOR_0), its surface (_SURFACE: roughness, metalness and how
// much it weathers) and an ambient occlusion term (_AO) ray-traced here against the model, so the
// runtime shades painted steel, galvanised grating and rubber differently with no textures.
//
// Pipeline: three.js geometry -> AO bake (three-mesh-bvh) -> meshoptimizer LOD -> glTF-Transform
// (quantize, reorder, EXT_meshopt_compression). Nodes:
//   Tower, NacelleShell, Internals, Rotor          full detail (hero + near instances)
//   Body_LOD1, Rotor_LOD1                          simplified (far instances)

import * as THREE from 'three'
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { MeshBVH } from 'three-mesh-bvh'
import { Document, NodeIO, type Material } from '@gltf-transform/core'
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions'
import { quantize, reorder } from '@gltf-transform/functions'
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer'
import { mkdir } from 'node:fs/promises'
import { TURBINE } from '../src/scene/turbine/spec.ts'

const { hubHeight, rotorRadius, hubOffsetZ } = TURBINE

// sRGB swatches: marine paint systems as specified for offshore structures (light grey RAL 7035
// above, traffic yellow RAL 1023 on the transition piece and splash zone).
const COLOR = {
  grey: 0xcbd0cc,
  yellow: 0xf0b400,
  galvanized: 0x8f979c,
  grating: 0x6f777c,
  black: 0x1f2225,
  red: 0xd0201a,
  steel: 0x8a929a,
  dark: 0x3a4148,
  copper: 0xb86b3a,
  blue: 0x2f6f9f,
}

/** Roughness, metalness, weathering (0: none, 1: full rain streaks, salt and grime). */
type Surface = readonly [roughness: number, metalness: number, weathering: number]
const SURFACE = {
  // Pigment layers under a gloss lacquer (the lacquer is a material-wide clearcoat).
  topcoat: [0.45, 0, 1],
  coating: [0.5, 0, 1],
  galvanized: [0.38, 0.9, 0.7],
  aluminium: [0.3, 0.95, 0.5],
  rubber: [0.82, 0, 0.4],
  machinery: [0.35, 0.6, 0],
  enamel: [0.42, 0, 0],
  copper: [0.3, 1, 0],
  lamp: [0.15, 0, 0],
} satisfies Record<string, Surface>

function part(geometry: THREE.BufferGeometry, hex: number, surface: Surface): THREE.BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry
  g.deleteAttribute('uv')
  const c = new THREE.Color(hex)
  const n = g.attributes.position.count
  const colors = new Float32Array(n * 3)
  const surfaces = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    colors.set([c.r, c.g, c.b], i * 3)
    surfaces.set(surface, i * 3)
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  g.setAttribute('_surface', new THREE.BufferAttribute(surfaces, 3))
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

/** A round tube between two points. */
function tube(a: THREE.Vector3, b: THREE.Vector3, radius: number, segments = 10): THREE.BufferGeometry {
  const d = new THREE.Vector3().subVectors(b, a)
  const g = new THREE.CylinderGeometry(radius, radius, d.length(), segments, 1, true)
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize()))
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2)
  return g
}

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)))
  if (!merged) throw new Error('mergeGeometries failed')
  return mergeVertices(merged, 1e-4)
}

/** Posts and two rails around a closed or open polyline, at a deck height. */
function railing(points: THREE.Vector2[], deckY: number, closed: boolean, hex: number): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = []
  const loop = closed ? [...points, points[0]] : points
  for (let i = 0; i < loop.length - 1; i++) {
    const a = loop[i]
    const b = loop[i + 1]
    const length = a.distanceTo(b)
    const posts = Math.max(1, Math.round(length / 1.8))
    for (let k = 0; k < posts; k++) {
      const p = a.clone().lerp(b, k / posts)
      out.push(part(tube(v(p.x, deckY, p.y), v(p.x, deckY + 1.1, p.y), 0.045, 6), hex, SURFACE.coating))
    }
    for (const h of [0.55, 1.1]) out.push(part(tube(v(a.x, deckY + h, a.y), v(b.x, deckY + h, b.y), 0.03, 6), hex, SURFACE.coating))
  }
  return out
}

const square = (half: number, cx = 0, cz = 0) => [
  new THREE.Vector2(cx - half, cz - half),
  new THREE.Vector2(cx + half, cz - half),
  new THREE.Vector2(cx + half, cz + half),
  new THREE.Vector2(cx - half, cz + half),
]

// ---------------------------------------------------------------- foundation, platform, tower

const JACKET = { bottom: -4, top: 17, halfBottom: 10.5, halfTop: 8, leg: 0.8 }
const DECK_Y = 20
const TP_TOP = 25
const TOWER_TOP = hubHeight - 3.2

const jacketHalf = (y: number) =>
  THREE.MathUtils.lerp(JACKET.halfBottom, JACKET.halfTop, (y - JACKET.bottom) / (JACKET.top - JACKET.bottom))

function towerRadius(y: number): number {
  return THREE.MathUtils.lerp(3.3, 2.2, (y - TP_TOP) / (TOWER_TOP - TP_TOP))
}

function buildTower(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const corners = [
    [1, 1],
    [1, -1],
    [-1, -1],
    [-1, 1],
  ]
  const corner = (c: number[], y: number) => v(c[0] * jacketHalf(y), y, c[1] * jacketHalf(y))
  // Battered legs, X-braced faces and a horizontal ring brace under the deck. Only the part above
  // the trough of the waves is modelled.
  for (const c of corners) parts.push(part(tube(corner(c, JACKET.bottom), corner(c, JACKET.top), JACKET.leg, 14), COLOR.yellow, SURFACE.coating))
  const braceY = [JACKET.bottom, 15]
  for (let i = 0; i < 4; i++) {
    const a = corners[i]
    const b = corners[(i + 1) % 4]
    parts.push(part(tube(corner(a, braceY[0]), corner(b, braceY[1]), 0.42, 10), COLOR.yellow, SURFACE.coating))
    parts.push(part(tube(corner(b, braceY[0]), corner(a, braceY[1]), 0.42, 10), COLOR.yellow, SURFACE.coating))
    parts.push(part(tube(corner(a, braceY[1]), corner(b, braceY[1]), 0.5, 10), COLOR.yellow, SURFACE.coating))
  }
  // Transition piece: a yellow can on the jacket, carrying the tower flange.
  parts.push(part(at(new THREE.CylinderGeometry(3.5, 3.6, TP_TOP - JACKET.top + 1, 48, 1), 0, (TP_TOP + JACKET.top - 1) / 2, 0), COLOR.yellow, SURFACE.coating))
  for (const c of corners) parts.push(part(tube(corner(c, JACKET.top), v(c[0] * 3.3, TP_TOP - 3, c[1] * 3.3), 0.45, 10), COLOR.yellow, SURFACE.coating))
  // Working platform: galvanised grating on a yellow frame, railed all round.
  parts.push(part(at(new THREE.BoxGeometry(17, 0.35, 17), 0, DECK_Y, 0), COLOR.grating, SURFACE.galvanized))
  parts.push(part(at(new THREE.BoxGeometry(17.2, 0.6, 17.2), 0, DECK_Y - 0.45, 0), COLOR.yellow, SURFACE.coating))
  parts.push(...railing(square(8.4), DECK_Y + 0.18, true, COLOR.yellow))
  // Davit crane at one corner.
  parts.push(part(tube(v(-6.6, DECK_Y, -6.6), v(-6.6, DECK_Y + 5.2, -6.6), 0.28, 12), COLOR.yellow, SURFACE.coating))
  parts.push(part(tube(v(-6.6, DECK_Y + 5, -6.6), v(-9.8, DECK_Y + 5.6, -9.8), 0.18, 10), COLOR.yellow, SURFACE.coating))
  parts.push(part(tube(v(-9.8, DECK_Y + 5.6, -9.8), v(-9.8, DECK_Y + 2.4, -9.8), 0.02, 4), COLOR.black, SURFACE.rubber))
  // Boat landing on the +x face: two fendered tubes and a ladder up to the platform.
  const bx = jacketHalf(0) + 2
  for (const z of [-1.3, 1.3]) {
    parts.push(part(tube(v(bx, -3, z), v(bx - 0.6, DECK_Y, z), 0.32, 12), COLOR.yellow, SURFACE.coating))
    parts.push(part(tube(v(bx + 0.05, -1.5, z), v(bx - 0.05, 3.5, z), 0.42, 12), COLOR.black, SURFACE.rubber))
  }
  for (let y = -1; y < DECK_Y; y += 0.32) {
    const x = bx - 0.9 - (0.6 * (y + 3)) / (DECK_Y + 3)
    parts.push(part(tube(v(x, y, -0.4), v(x, y, 0.4), 0.025, 5), COLOR.galvanized, SURFACE.galvanized))
  }
  for (const z of [-0.45, 0.45]) parts.push(part(tube(v(bx - 0.9, -1, z), v(bx - 1.5, DECK_Y, z), 0.05, 6), COLOR.galvanized, SURFACE.galvanized))

  // Tapered tubular tower in three sections, bolted at external-looking flanges.
  const profile = [new THREE.Vector2(0.01, TP_TOP), new THREE.Vector2(towerRadius(TP_TOP), TP_TOP), new THREE.Vector2(towerRadius(TOWER_TOP), TOWER_TOP), new THREE.Vector2(0.01, TOWER_TOP)]
  parts.push(part(new THREE.LatheGeometry(profile, 72), COLOR.grey, SURFACE.topcoat))
  for (const y of [TP_TOP + 0.2, 52, 80, TOWER_TOP - 0.3]) {
    const r = towerRadius(y) + 0.05
    parts.push(part(at(new THREE.CylinderGeometry(r, r, 0.3, 72, 1, true), 0, y, 0), COLOR.grey, SURFACE.topcoat))
  }
  // Tower door with its landing, facing the boat landing.
  const doorR = towerRadius(TP_TOP + 1.6)
  parts.push(part(at(new THREE.BoxGeometry(0.12, 2.2, 1.0), doorR + 0.02, TP_TOP + 1.4, 0), COLOR.dark, SURFACE.enamel))
  parts.push(part(at(new THREE.BoxGeometry(2.4, 0.15, 2.4), doorR + 1.2, TP_TOP + 0.2, 0), COLOR.grating, SURFACE.galvanized))
  return merge(parts)
}

// ---------------------------------------------------------------- nacelle

const NACELLE = { length: 21, width: 8.6, height: 8.2, rearZ: -15, cornerRadius: 1.2 }
const NACELLE_Y = hubHeight + 0.6
const ROOF_Y = NACELLE_Y + NACELLE.height / 2

function roundedBox(w: number, h: number, d: number, r: number, segments = 8): THREE.BufferGeometry {
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
    steps: 12,
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
  const front = rearZ + length
  const shell = roundedBox(width, height, length, cornerRadius)
  shell.translate(0, 0, rearZ + length / 2)
  // The housing narrows slightly toward the rear and its roof line drops a little.
  const p = shell.attributes.position
  for (let i = 0; i < p.count; i++) {
    const f = THREE.MathUtils.clamp((front - p.getZ(i)) / length, 0, 1)
    p.setX(i, p.getX(i) * (1 - 0.07 * f))
    p.setY(i, p.getY(i) * (1 - 0.05 * f) - 0.25 * f)
  }
  shell.translate(0, NACELLE_Y, 0)
  shell.computeVertexNormals()
  const parts = [
    part(shell, COLOR.grey, SURFACE.topcoat),
    // Collar between nacelle and spinner.
    part(at(new THREE.CylinderGeometry(2.6, 3.2, 2.2, 56, 1, true), 0, hubHeight, front + 0.6, Math.PI / 2), COLOR.grey, SURFACE.topcoat),
  ]
  // Rooftop cooler: a framed box with louvred sides.
  const cooler = { z0: -8.8, z1: -2.6, half: 3.7, height: 3.4 }
  const cz = (cooler.z0 + cooler.z1) / 2
  const cl = cooler.z1 - cooler.z0
  parts.push(part(at(new THREE.BoxGeometry(cooler.half * 2, 0.3, cl), 0, ROOF_Y + cooler.height, cz), COLOR.grey, SURFACE.topcoat))
  for (const x of [-1, 1]) for (const z of [cooler.z0, cooler.z1]) {
    parts.push(part(at(new THREE.BoxGeometry(0.3, cooler.height, 0.3), x * cooler.half, ROOF_Y + cooler.height / 2, z), COLOR.grey, SURFACE.topcoat))
  }
  for (const x of [-1, 1]) {
    for (let k = 0; k < 13; k++) {
      const y = ROOF_Y + 0.35 + k * 0.23
      parts.push(part(at(new THREE.BoxGeometry(0.06, 0.2, cl - 0.3), x * (cooler.half - 0.1), y, cz, 0, 0, x * 0.5), COLOR.galvanized, SURFACE.aluminium))
    }
  }
  parts.push(part(at(new THREE.BoxGeometry(cooler.half * 2 - 0.4, cooler.height - 0.2, cl - 0.5), 0, ROOF_Y + cooler.height / 2, cz), COLOR.dark, SURFACE.enamel))
  // Helicopter hoisting deck at the rear of the roof, railed on three sides.
  const deck = { z0: rearZ + 0.6, z1: -9.6, half: 3.8 }
  parts.push(part(at(new THREE.BoxGeometry(deck.half * 2, 0.25, deck.z1 - deck.z0), 0, ROOF_Y + 0.15, (deck.z0 + deck.z1) / 2), COLOR.grating, SURFACE.galvanized))
  parts.push(
    ...railing(
      [new THREE.Vector2(-deck.half, deck.z1), new THREE.Vector2(-deck.half, deck.z0), new THREE.Vector2(deck.half, deck.z0), new THREE.Vector2(deck.half, deck.z1)],
      ROOF_Y + 0.27,
      false,
      COLOR.yellow,
    ),
  )
  // Met mast with an ultrasonic anemometer, and the two aviation lights on the cooler.
  parts.push(part(tube(v(0, ROOF_Y + 0.3, deck.z0 + 0.8), v(0, ROOF_Y + 5.2, deck.z0 + 0.8), 0.08, 8), COLOR.galvanized, SURFACE.galvanized))
  parts.push(part(at(new THREE.CylinderGeometry(0.35, 0.35, 0.3, 16), 0, ROOF_Y + 5.3, deck.z0 + 0.8), COLOR.dark, SURFACE.enamel))
  for (const x of [-1, 1]) {
    parts.push(part(tube(v(x * 3, ROOF_Y + cooler.height, cooler.z0 + 0.6), v(x * 3, ROOF_Y + cooler.height + 1.2, cooler.z0 + 0.6), 0.06, 6), COLOR.galvanized, SURFACE.galvanized))
    parts.push(part(at(new THREE.SphereGeometry(0.28, 14, 10), x * 3, ROOF_Y + cooler.height + 1.4, cooler.z0 + 0.6), COLOR.red, SURFACE.lamp))
  }
  return merge(parts)
}

function buildInternals(): THREE.BufferGeometry {
  const { rearZ, length } = NACELLE
  const y = hubHeight
  const front = rearZ + length
  const parts = [
    // Yaw bearing ring and bedplate.
    part(at(new THREE.TorusGeometry(2.3, 0.35, 10, 48), 0, hubHeight - 3.4, -2, Math.PI / 2), COLOR.steel, SURFACE.machinery),
    part(at(new THREE.BoxGeometry(5.2, 0.8, 16), 0, y - 3.0, rearZ + 9), COLOR.dark, SURFACE.enamel),
    // Main shaft and main bearing.
    part(at(new THREE.CylinderGeometry(0.9, 1.1, 7, 32), 0, y, front - 3.5, Math.PI / 2), COLOR.steel, SURFACE.machinery),
    part(at(new THREE.CylinderGeometry(1.8, 1.8, 1.6, 40), 0, y, front - 2, Math.PI / 2), COLOR.blue, SURFACE.enamel),
    // Gearbox.
    part(at(new THREE.CylinderGeometry(2.3, 2.6, 4.2, 40), 0, y, front - 8.6, Math.PI / 2), COLOR.blue, SURFACE.enamel),
    part(at(new THREE.CylinderGeometry(1.2, 1.2, 1.8, 24), 0, y + 0.4, front - 11.4, Math.PI / 2), COLOR.steel, SURFACE.machinery),
    // Generator with copper end windings.
    part(at(new THREE.CylinderGeometry(2.2, 2.2, 4.6, 48), 0, y + 0.4, front - 14.6, Math.PI / 2), COLOR.dark, SURFACE.enamel),
    part(at(new THREE.TorusGeometry(1.75, 0.32, 10, 40), 0, y + 0.4, front - 12.3), COLOR.copper, SURFACE.copper),
    part(at(new THREE.TorusGeometry(1.75, 0.32, 10, 40), 0, y + 0.4, front - 16.9), COLOR.copper, SURFACE.copper),
    // Converter and transformer cabinets.
    part(at(new THREE.BoxGeometry(1.4, 3.6, 4.4), 3.3, y - 0.6, rearZ + 3), COLOR.grey, SURFACE.enamel),
    part(at(new THREE.BoxGeometry(1.4, 3.6, 4.4), -3.3, y - 0.6, rearZ + 3), COLOR.grey, SURFACE.enamel),
    part(at(new THREE.BoxGeometry(3.2, 2.6, 2.6), 0, y - 1.6, rearZ + 1.6), COLOR.steel, SURFACE.machinery),
  ]
  return merge(parts)
}

// ---------------------------------------------------------------- rotor

function airfoil(t: number, n: number, roundness: number): THREE.Vector2[] {
  // NACA 4-digit thickness with a little camber, blended toward a circle at the blade root.
  const pts: THREE.Vector2[] = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    const x = 0.5 - 0.5 * Math.cos(a) // 0 at leading edge, 1 at trailing edge
    const side = Math.sin(a) >= 0 ? 1 : -1
    const yt = 5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x ** 2 + 0.2843 * x ** 3 - 0.1036 * x ** 4)
    const camber = 0.04 * Math.sin(Math.PI * x) * (1 - roundness)
    const foil = new THREE.Vector2(x - 0.3, side * yt + camber)
    const circle = new THREE.Vector2(-0.5 * Math.cos(a) + 0.2, 0.5 * Math.sin(a))
    pts.push(foil.lerp(circle, roundness))
  }
  return pts
}

/** An 81 m blade: cylindrical root, maximum chord at a fifth of the span, prebent upwind. */
function buildBlade(): THREE.BufferGeometry {
  const stations = 40
  const ring = 28
  const rootR = 3.4
  const positions: number[] = []
  const indices: number[] = []
  for (let s = 0; s < stations; s++) {
    const f = s / (stations - 1)
    const r = rootR + f ** 1.15 * (rotorRadius - rootR)
    const span = (r - rootR) / (rotorRadius - rootR)
    const chord =
      span < 0.04
        ? 3.3
        : span < 0.2
          ? THREE.MathUtils.lerp(3.3, 4.6, THREE.MathUtils.smoothstep(span, 0.04, 0.2))
          : 4.6 * (1 - (span - 0.2) / 0.8) ** 0.95 + 0.45
    const roundness = 1 - THREE.MathUtils.smoothstep(span, 0.03, 0.18)
    const thickness = THREE.MathUtils.lerp(0.42, 0.18, THREE.MathUtils.smoothstep(span, 0.05, 0.5)) - 0.04 * span
    const twist = THREE.MathUtils.degToRad(14 * (1 - span) ** 1.7)
    const prebend = 3.2 * span ** 2.2
    for (const p of airfoil(thickness, ring, roundness)) {
      const x = p.x * chord
      const z = p.y * chord
      const cx = x * Math.cos(twist) - z * Math.sin(twist)
      const cz = x * Math.sin(twist) + z * Math.cos(twist) + prebend
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
  positions.push(0.4, rotorRadius + 0.25, 3.2)
  for (let i = 0; i < ring; i++) indices.push((stations - 1) * ring + i, tip, (stations - 1) * ring + ((i + 1) % ring))
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  g.setIndex(indices)
  g.computeVertexNormals()
  return g
}

function buildRotor(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  // Spinner: a blunt ogive nose over a cylindrical hub cover.
  const spinner = new THREE.SphereGeometry(3.4, 56, 28, 0, Math.PI * 2, 0, Math.PI / 2)
  spinner.scale(1, 1.35, 1)
  parts.push(part(at(spinner, 0, 0, 0.2, Math.PI / 2), COLOR.grey, SURFACE.topcoat))
  parts.push(part(at(new THREE.CylinderGeometry(3.4, 3.2, 2.4, 56, 1, true), 0, 0, -1, Math.PI / 2), COLOR.grey, SURFACE.topcoat))
  const blade = buildBlade()
  for (let k = 0; k < 3; k++) {
    const angle = (k / 3) * Math.PI * 2
    parts.push(at(part(blade.clone(), COLOR.grey, SURFACE.topcoat), 0, 0, -0.8, 0, 0, angle))
    // Root fairing where the blade enters the spinner.
    parts.push(at(part(at(new THREE.CylinderGeometry(1.75, 2.1, 1.6, 32, 1, true), 0, 3.2, 0), COLOR.grey, SURFACE.topcoat), 0, 0, -0.8, 0, 0, angle))
  }
  return merge(parts)
}

// ---------------------------------------------------------------- ambient occlusion

/** Hemisphere directions, Hammersley-distributed and cosine-weighted, around +y. */
function hemisphere(count: number): THREE.Vector3[] {
  const dirs: THREE.Vector3[] = []
  for (let i = 0; i < count; i++) {
    let bits = i
    bits = ((bits << 16) | (bits >>> 16)) >>> 0
    bits = (((bits & 0x55555555) << 1) | ((bits & 0xaaaaaaaa) >>> 1)) >>> 0
    bits = (((bits & 0x33333333) << 2) | ((bits & 0xcccccccc) >>> 2)) >>> 0
    bits = (((bits & 0x0f0f0f0f) << 4) | ((bits & 0xf0f0f0f0) >>> 4)) >>> 0
    bits = (((bits & 0x00ff00ff) << 8) | ((bits & 0xff00ff00) >>> 8)) >>> 0
    const u = (i + 0.5) / count
    const w = bits / 4294967296
    const r = Math.sqrt(u)
    const phi = 2 * Math.PI * w
    dirs.push(new THREE.Vector3(r * Math.cos(phi), Math.sqrt(1 - u), r * Math.sin(phi)))
  }
  return dirs
}

const AO_RAYS = hemisphere(48)
const AO_RANGE = 14

/** Occlusion of each vertex of target by the occluder geometry, within AO_RANGE metres. */
function bakeAO(target: THREE.BufferGeometry, occluder: THREE.BufferGeometry) {
  const bvh = new MeshBVH(occluder.index ? occluder : mergeVertices(occluder))
  const p = target.attributes.position
  const n = target.attributes.normal
  const ao = new Float32Array(p.count)
  const ray = new THREE.Ray()
  const normal = new THREE.Vector3()
  const basis = new THREE.Quaternion()
  const up = new THREE.Vector3(0, 1, 0)
  for (let i = 0; i < p.count; i++) {
    normal.set(n.getX(i), n.getY(i), n.getZ(i)).normalize()
    basis.setFromUnitVectors(up, normal)
    let open = 0
    for (const d of AO_RAYS) {
      ray.direction.copy(d).applyQuaternion(basis)
      ray.origin.set(p.getX(i), p.getY(i), p.getZ(i)).addScaledVector(normal, 0.02)
      const hit = bvh.raycastFirst(ray, THREE.DoubleSide, 0, AO_RANGE)
      // Near occluders darken fully, far ones only a little.
      open += hit ? (hit.distance / AO_RANGE) ** 0.5 : 1
    }
    ao[i] = open / AO_RAYS.length
  }
  target.setAttribute('_ao', new THREE.BufferAttribute(ao, 1))
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
// Shading comes from the vertex surfaces; the material only carries defaults.
const material = doc.createMaterial('Turbine').setRoughnessFactor(1).setMetallicFactor(0)

function addNode(name: string, g: THREE.BufferGeometry, mat: Material, translation: [number, number, number] = [0, 0, 0]) {
  const geometry = g.index ? g : mergeVertices(g, 1e-4)
  const prim = doc.createPrimitive().setMaterial(mat)
  const attributes: [string, string, 'VEC3' | 'SCALAR'][] = [
    ['POSITION', 'position', 'VEC3'],
    ['NORMAL', 'normal', 'VEC3'],
    ['COLOR_0', 'color', 'VEC3'],
    ['_SURFACE', '_surface', 'VEC3'],
    ['_AO', '_ao', 'SCALAR'],
  ]
  for (const [semantic, key, type] of attributes) {
    const array = new Float32Array(geometry.attributes[key].array)
    prim.setAttribute(semantic, doc.createAccessor(`${name}_${key}`).setType(type).setArray(array).setBuffer(buffer))
  }
  prim.setIndices(doc.createAccessor(`${name}_index`).setType('SCALAR').setArray(new Uint32Array(geometry.index!.array)).setBuffer(buffer))
  const mesh = doc.createMesh(name).addPrimitive(prim)
  scene.addChild(doc.createNode(name).setMesh(mesh).setTranslation(translation))
  return { triangles: geometry.index!.count / 3, vertices: geometry.attributes.position.count }
}

const hub: [number, number, number] = [0, hubHeight, hubOffsetZ]
const tower = buildTower()
const shell = buildNacelleShell()
const internals = buildInternals()
const rotor = buildRotor()

console.time('ambient occlusion')
// The rotor turns, so it neither shades nor is shaded by the body; the sealed nacelle shades its
// machinery, which shows once the hero turbine is cut open.
const body = merge([tower, shell, internals])
for (const g of [tower, shell, internals]) bakeAO(g, body)
bakeAO(rotor, rotor)
console.timeEnd('ambient occlusion')

const bodyOuter = merge([tower, shell])
const stats = {
  Tower: addNode('Tower', tower, material),
  NacelleShell: addNode('NacelleShell', shell, material),
  Internals: addNode('Internals', internals, material),
  Rotor: addNode('Rotor', rotor, material, hub),
  Body_LOD1: addNode('Body_LOD1', simplify(bodyOuter, 0.1, 0.02), material),
  Rotor_LOD1: addNode('Rotor_LOD1', simplify(rotor, 0.1, 0.02), material, hub),
}
console.table(stats)

await doc.transform(
  reorder({ encoder: MeshoptEncoder }),
  quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeColor: 8, quantizeGeneric: 8 }),
)
doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE })

await mkdir('public/models', { recursive: true })
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder })
await io.write('public/models/turbine.glb', doc)
console.log('wrote public/models/turbine.glb')
