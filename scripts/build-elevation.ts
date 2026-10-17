// Builds public/data/taiwan-elevation.bin: an Int16 (metres, little-endian) grid of
// ELEVATION_SIZE x ELEVATION_SIZE samples covering DOMAIN, row 0 at the north edge,
// corner-aligned (first/last samples sit exactly on the domain edges).
// Source: AWS Terrain Tiles (Terrarium encoding), which includes bathymetry.

import sharp from 'sharp'
import { mkdir, writeFile } from 'node:fs/promises'
import { DOMAIN, ELEVATION_SIZE } from '../src/geo/domain.ts'

const ZOOM = 9
const TILE = 256
const TILE_URL = (x: number, y: number) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${ZOOM}/${x}/${y}.png`

const worldPx = TILE * 2 ** ZOOM
const lonToPx = (lon: number) => ((lon + 180) / 360) * worldPx
const latToPx = (lat: number) => {
  const r = (lat * Math.PI) / 180
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * worldPx
}

const tx0 = Math.floor(lonToPx(DOMAIN.west) / TILE)
const tx1 = Math.floor(lonToPx(DOMAIN.east) / TILE)
const ty0 = Math.floor(latToPx(DOMAIN.north) / TILE)
const ty1 = Math.floor(latToPx(DOMAIN.south) / TILE)
const cols = tx1 - tx0 + 1
const rows = ty1 - ty0 + 1
const mosaicW = cols * TILE
const mosaicH = rows * TILE

console.log(`fetching ${cols * rows} tiles at z${ZOOM}`)
const elevation = new Float32Array(mosaicW * mosaicH)

await Promise.all(
  Array.from({ length: cols * rows }, async (_, k) => {
    const tx = tx0 + (k % cols)
    const ty = ty0 + Math.floor(k / cols)
    const res = await fetch(TILE_URL(tx, ty))
    if (!res.ok) throw new Error(`tile ${tx}/${ty}: HTTP ${res.status}`)
    const { data, info } = await sharp(Buffer.from(await res.arrayBuffer()))
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    if (info.width !== TILE || info.height !== TILE) throw new Error(`tile ${tx}/${ty}: bad size`)
    const ox = (tx - tx0) * TILE
    const oy = (ty - ty0) * TILE
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const s = (y * TILE + x) * 3
        elevation[(oy + y) * mosaicW + ox + x] = data[s] * 256 + data[s + 1] + data[s + 2] / 256 - 32768
      }
    }
  }),
)

function sampleMosaic(px: number, py: number): number {
  const x = Math.min(Math.max(px - 0.5, 0), mosaicW - 1.001)
  const y = Math.min(Math.max(py - 0.5, 0), mosaicH - 1.001)
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy
  const i = iy * mosaicW + ix
  const top = elevation[i] * (1 - fx) + elevation[i + 1] * fx
  const bottom = elevation[i + mosaicW] * (1 - fx) + elevation[i + mosaicW + 1] * fx
  return top * (1 - fy) + bottom * fy
}

const out = new Int16Array(ELEVATION_SIZE * ELEVATION_SIZE)
let min = Infinity
let max = -Infinity
for (let j = 0; j < ELEVATION_SIZE; j++) {
  const lat = DOMAIN.north - (j / (ELEVATION_SIZE - 1)) * (DOMAIN.north - DOMAIN.south)
  const py = latToPx(lat) - ty0 * TILE
  for (let i = 0; i < ELEVATION_SIZE; i++) {
    const lon = DOMAIN.west + (i / (ELEVATION_SIZE - 1)) * (DOMAIN.east - DOMAIN.west)
    const h = Math.round(sampleMosaic(lonToPx(lon) - tx0 * TILE, py))
    out[j * ELEVATION_SIZE + i] = h
    min = Math.min(min, h)
    max = Math.max(max, h)
  }
}

await mkdir('public/data', { recursive: true })
await writeFile('public/data/taiwan-elevation.bin', new Uint8Array(out.buffer))
console.log(`wrote ${ELEVATION_SIZE}² samples, range ${min}..${max} m`)
