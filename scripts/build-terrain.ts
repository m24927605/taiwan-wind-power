// Builds public/models/terrain.glb: the land surface of DOMAIN in world units (km, with the
// scene's vertical exaggeration). A z11 elevation grid is cut down to the cells that touch land,
// then simplified by meshoptimizer to a fixed geometric error, so plains collapse to a few large
// triangles while the Central Range keeps its ridgelines. Shading comes from the imagery and
// normal textures, so the mesh carries positions only.

import { Document, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions'
import { quantize, reorder } from '@gltf-transform/functions'
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer'
import { mkdir } from 'node:fs/promises'
import { VERTICAL_EXAGGERATION, WORLD } from '../src/geo/domain.ts'
import { fetchMosaic, forEachDomainSample, terrarium } from './tiles.ts'

const ZOOM = 11
const GRID = 2048
/** Land sinks below the sea near the domain border so cropped coastlines end softly. */
const EDGE_TAPER = 0.035
/** Land sits a hair above the ocean plane; sea vertices of coastal cells sit below it. */
const LAND_LIFT_KM = 0.004
const SEA_DROP_KM = 0.02
/** Simplification error: 40 m of real relief, in exaggerated world units. */
const MAX_ERROR_KM = (40 * VERTICAL_EXAGGERATION) / 1000

const elevation = await fetchMosaic(ZOOM, terrarium.url(ZOOM), 1, terrarium.decode)
const sample = new Float32Array(1)
const heights = new Float32Array(GRID * GRID)
forEachDomainSample(GRID, (i, j, lon, lat) => {
  elevation.sample(lon, lat, sample)
  const u = i / (GRID - 1)
  const v = j / (GRID - 1)
  const edge = Math.min(u, v, 1 - u, 1 - v) / EDGE_TAPER
  const taper = edge >= 1 ? 1 : edge * edge * (3 - 2 * edge)
  heights[j * GRID + i] = sample[0] > 0 ? sample[0] * taper : 0
})

// Keep cells that touch land, re-indexing only the vertices they use.
const remap = new Int32Array(GRID * GRID).fill(-1)
const positions: number[] = []
const indices: number[] = []
const vertex = (k: number) => {
  if (remap[k] < 0) {
    remap[k] = positions.length / 3
    const i = k % GRID
    const j = Math.floor(k / GRID)
    const h = heights[k]
    positions.push(
      WORLD.minX + (i / (GRID - 1)) * WORLD.width,
      h > 0 ? (h * VERTICAL_EXAGGERATION) / 1000 + LAND_LIFT_KM : -SEA_DROP_KM,
      WORLD.minZ + (j / (GRID - 1)) * WORLD.depth,
    )
  }
  return remap[k]
}
for (let j = 0; j < GRID - 1; j++) {
  for (let i = 0; i < GRID - 1; i++) {
    const a = j * GRID + i
    const b = a + 1
    const c = a + GRID
    const d = c + 1
    if (Math.max(heights[a], heights[b], heights[c], heights[d]) <= 0) continue
    indices.push(vertex(a), vertex(c), vertex(b), vertex(b), vertex(c), vertex(d))
  }
}
console.log(`grid: ${indices.length / 3} triangles`)

await MeshoptSimplifier.ready
await MeshoptEncoder.ready
const position = new Float32Array(positions)
const [simplified] = MeshoptSimplifier.simplify(new Uint32Array(indices), position, 3, 0, MAX_ERROR_KM, ['ErrorAbsolute'])
// Drop vertices the simplifier no longer references.
const used = new Int32Array(position.length / 3).fill(-1)
const compact: number[] = []
const index = new Uint32Array(simplified.length)
simplified.forEach((v, n) => {
  if (used[v] < 0) {
    used[v] = compact.length / 3
    compact.push(position[v * 3], position[v * 3 + 1], position[v * 3 + 2])
  }
  index[n] = used[v]
})
console.log(`simplified: ${index.length / 3} triangles, ${compact.length / 3} vertices`)

const doc = new Document()
const buffer = doc.createBuffer()
const prim = doc
  .createPrimitive()
  .setAttribute('POSITION', doc.createAccessor('position').setType('VEC3').setArray(new Float32Array(compact)).setBuffer(buffer))
  .setIndices(doc.createAccessor('index').setType('SCALAR').setArray(index).setBuffer(buffer))
doc.createScene('Terrain').addChild(doc.createNode('Terrain').setMesh(doc.createMesh('Terrain').addPrimitive(prim)))

await doc.transform(reorder({ encoder: MeshoptEncoder }), quantize({ quantizePosition: 16 }))
doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE })

await mkdir('public/models', { recursive: true })
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder })
await io.write('public/models/terrain.glb', doc)
console.log('wrote public/models/terrain.glb')
