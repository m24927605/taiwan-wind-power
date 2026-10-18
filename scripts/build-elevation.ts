// Builds public/data/taiwan-elevation.png: an ELEVATION_SIZE x ELEVATION_SIZE grid of whole metres
// covering DOMAIN, row 0 at the north edge, corner-aligned (first/last samples sit exactly on the
// domain edges). Encoded like its source, AWS Terrain Tiles (Terrarium, with bathymetry):
// metres = R * 256 + G - 32768, so a plain PNG carries it losslessly to any static host.

import sharp from 'sharp'
import { mkdir } from 'node:fs/promises'
import { DOMAIN, ELEVATION_SIZE } from '../src/geo/domain.ts'
import { fetchMosaic, forEachSample, terrarium } from './tiles.ts'

const ZOOM = 9

const mosaic = await fetchMosaic(ZOOM, terrarium.url(ZOOM), 1, terrarium.decode)
const out = Buffer.alloc(ELEVATION_SIZE * ELEVATION_SIZE * 3)
const sample = new Float32Array(1)
let min = Infinity
let max = -Infinity
forEachSample(DOMAIN, ELEVATION_SIZE, ELEVATION_SIZE, (i, j, lon, lat) => {
  mosaic.sample(lon, lat, sample)
  const h = Math.round(sample[0])
  const encoded = h + 32768
  const o = (j * ELEVATION_SIZE + i) * 3
  out[o] = encoded >> 8
  out[o + 1] = encoded & 255
  min = Math.min(min, h)
  max = Math.max(max, h)
})

await mkdir('public/data', { recursive: true })
await sharp(out, { raw: { width: ELEVATION_SIZE, height: ELEVATION_SIZE, channels: 3 } })
  .png({ compressionLevel: 9 })
  .toFile('public/data/taiwan-elevation.png')
console.log(`wrote ${ELEVATION_SIZE}² samples, range ${min}..${max} m`)
