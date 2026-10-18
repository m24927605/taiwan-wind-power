// Builds public/data/taiwan-elevation.bin: an Int16 (metres, little-endian) grid of
// ELEVATION_SIZE x ELEVATION_SIZE samples covering DOMAIN, row 0 at the north edge,
// corner-aligned (first/last samples sit exactly on the domain edges).
// Source: AWS Terrain Tiles (Terrarium encoding), which includes bathymetry.

import { mkdir, writeFile } from 'node:fs/promises'
import { DOMAIN, ELEVATION_SIZE } from '../src/geo/domain.ts'
import { fetchMosaic, forEachSample, terrarium } from './tiles.ts'

const ZOOM = 9

const mosaic = await fetchMosaic(ZOOM, terrarium.url(ZOOM), 1, terrarium.decode)
const out = new Int16Array(ELEVATION_SIZE * ELEVATION_SIZE)
const sample = new Float32Array(1)
let min = Infinity
let max = -Infinity
forEachSample(DOMAIN, ELEVATION_SIZE, ELEVATION_SIZE, (i, j, lon, lat) => {
  mosaic.sample(lon, lat, sample)
  const h = Math.round(sample[0])
  out[j * ELEVATION_SIZE + i] = h
  min = Math.min(min, h)
  max = Math.max(max, h)
})

await mkdir('public/data', { recursive: true })
await writeFile('public/data/taiwan-elevation.bin', new Uint8Array(out.buffer))
console.log(`wrote ${ELEVATION_SIZE}² samples, range ${min}..${max} m`)
