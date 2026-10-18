// Fetches a Web Mercator tile mosaic covering DOMAIN and resamples it onto the scene's
// equirectangular grid (row 0 at the north edge, corner-aligned samples).

import sharp from 'sharp'
import { DOMAIN } from '../src/geo/domain.ts'

const TILE = 256
const CONCURRENCY = 8

export interface Mosaic {
  /** Bilinear sample of every channel at a lon/lat, written into `out`. */
  sample(lon: number, lat: number, out: Float32Array): void
}

/**
 * @param url   tile URL for x, y at `zoom`
 * @param decode converts one tile's raw RGB bytes into `channels` floats per pixel
 */
export async function fetchMosaic(
  zoom: number,
  url: (x: number, y: number) => string,
  channels: number,
  decode: (rgb: Buffer, out: Float32Array, offset: number, pixel: number) => void,
): Promise<Mosaic> {
  const worldPx = TILE * 2 ** zoom
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
  const width = cols * TILE
  const height = rows * TILE
  const data = new Float32Array(width * height * channels)

  console.log(`fetching ${cols * rows} tiles at z${zoom}`)
  const queue = Array.from({ length: cols * rows }, (_, k) => k)
  let done = 0
  async function worker() {
    for (let k = queue.shift(); k !== undefined; k = queue.shift()) {
      const tx = tx0 + (k % cols)
      const ty = ty0 + Math.floor(k / cols)
      const res = await fetch(url(tx, ty))
      if (!res.ok) throw new Error(`tile ${tx}/${ty}: HTTP ${res.status}`)
      const { data: rgb, info } = await sharp(Buffer.from(await res.arrayBuffer()))
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
      if (info.width !== TILE || info.height !== TILE) throw new Error(`tile ${tx}/${ty}: bad size`)
      const ox = (tx - tx0) * TILE
      const oy = (ty - ty0) * TILE
      for (let y = 0; y < TILE; y++) {
        for (let x = 0; x < TILE; x++) {
          decode(rgb, data, ((oy + y) * width + ox + x) * channels, y * TILE + x)
        }
      }
      if (++done % 100 === 0) console.log(`  ${done}/${cols * rows}`)
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  return {
    sample(lon, lat, out) {
      const x = Math.min(Math.max(lonToPx(lon) - tx0 * TILE - 0.5, 0), width - 1.001)
      const y = Math.min(Math.max(latToPx(lat) - ty0 * TILE - 0.5, 0), height - 1.001)
      const ix = Math.floor(x)
      const iy = Math.floor(y)
      const fx = x - ix
      const fy = y - iy
      const i00 = (iy * width + ix) * channels
      const i10 = i00 + channels
      const i01 = i00 + width * channels
      const i11 = i01 + channels
      for (let c = 0; c < channels; c++) {
        const top = data[i00 + c] * (1 - fx) + data[i10 + c] * fx
        const bottom = data[i01 + c] * (1 - fx) + data[i11 + c] * fx
        out[c] = top * (1 - fy) + bottom * fy
      }
    },
  }
}

/** Calls `fn` for every sample of a size x size grid over DOMAIN. */
export function forEachDomainSample(size: number, fn: (i: number, j: number, lon: number, lat: number) => void) {
  for (let j = 0; j < size; j++) {
    const lat = DOMAIN.north - (j / (size - 1)) * (DOMAIN.north - DOMAIN.south)
    for (let i = 0; i < size; i++) {
      fn(i, j, DOMAIN.west + (i / (size - 1)) * (DOMAIN.east - DOMAIN.west), lat)
    }
  }
}

/** Terrarium elevation tiles (AWS Terrain Tiles), metres, including bathymetry. */
export const terrarium = {
  url: (zoom: number) => (x: number, y: number) =>
    `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${zoom}/${x}/${y}.png`,
  decode: (rgb: Buffer, out: Float32Array, offset: number, pixel: number) => {
    const s = pixel * 3
    out[offset] = rgb[s] * 256 + rgb[s + 1] + rgb[s + 2] / 256 - 32768
  },
}
