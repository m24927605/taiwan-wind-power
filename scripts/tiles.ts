// Fetches a Web Mercator tile mosaic covering a lon/lat box and resamples it onto the scene's
// equirectangular grid (row 0 at the north edge, corner-aligned samples).

import sharp from 'sharp'
import { DOMAIN, type Bounds } from '../src/geo/domain.ts'

const TILE = 256
const CONCURRENCY = 8

export interface Mosaic {
  /** Bilinear sample of every channel at a lon/lat, written into `out`. */
  sample(lon: number, lat: number, out: Float32Array): void
}

type Store = Float32Array | Uint8Array

/**
 * @param url    tile URL for x, y at `zoom`
 * @param decode converts one tile's raw RGB bytes into `channels` values per pixel
 * @param bytes  store values as bytes (imagery) instead of floats (elevation)
 */
export async function fetchMosaic(
  zoom: number,
  url: (x: number, y: number) => string,
  channels: number,
  decode: (rgb: Buffer, out: Store, offset: number, pixel: number) => void,
  { bounds = DOMAIN, bytes = false }: { bounds?: Bounds; bytes?: boolean } = {},
): Promise<Mosaic> {
  const worldPx = TILE * 2 ** zoom
  const lonToPx = (lon: number) => ((lon + 180) / 360) * worldPx
  const latToPx = (lat: number) => {
    const r = (lat * Math.PI) / 180
    return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * worldPx
  }
  const tx0 = Math.floor(lonToPx(bounds.west) / TILE)
  const tx1 = Math.floor(lonToPx(bounds.east) / TILE)
  const ty0 = Math.floor(latToPx(bounds.north) / TILE)
  const ty1 = Math.floor(latToPx(bounds.south) / TILE)
  const cols = tx1 - tx0 + 1
  const rows = ty1 - ty0 + 1
  const width = cols * TILE
  const height = rows * TILE
  const data = bytes ? new Uint8Array(width * height * channels) : new Float32Array(width * height * channels)

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

/** Calls `fn` for every sample of a width x height grid over a lon/lat box. */
export function forEachSample(
  bounds: Bounds,
  width: number,
  height: number,
  fn: (i: number, j: number, lon: number, lat: number) => void,
) {
  for (let j = 0; j < height; j++) {
    const lat = bounds.north - (j / (height - 1)) * (bounds.north - bounds.south)
    for (let i = 0; i < width; i++) {
      fn(i, j, bounds.west + (i / (width - 1)) * (bounds.east - bounds.west), lat)
    }
  }
}

/** Terrarium elevation tiles (AWS Terrain Tiles), metres, including bathymetry. */
export const terrarium = {
  url: (zoom: number) => (x: number, y: number) =>
    `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${zoom}/${x}/${y}.png`,
  decode: (rgb: Buffer, out: Store, offset: number, pixel: number) => {
    const s = pixel * 3
    out[offset] = rgb[s] * 256 + rgb[s + 1] + rgb[s + 2] / 256 - 32768
  },
}
