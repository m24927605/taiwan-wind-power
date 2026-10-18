// Builds the land textures draped over the terrain:
//   public/textures/imagery.webp         Sentinel-2 cloudless true colour (EOX, CC BY-NC-SA 4.0)
//                                        over DOMAIN, z11 (~110 m per texel)
//   public/textures/imagery-taiwan.webp  the same over DETAIL (the island), z12 (~50 m per texel)
//   public/textures/normals.webp         surface normals from z11 Terrarium elevation over DOMAIN,
//                                        encoded as (x, z) in RG, y implied.
// Sea pixels are flattened to a constant: the ocean shader draws the water, and flat areas
// compress to almost nothing.

import sharp from 'sharp'
import { mkdir } from 'node:fs/promises'
import { DETAIL, DOMAIN, WORLD, type Bounds } from '../src/geo/domain.ts'
import { fetchMosaic, forEachSample, terrarium } from './tiles.ts'

const ZOOM = 11
/** About 110 m per texel: the resolution of the z11 source over the domain. */
const NORMAL_SIZE = 4096
/** Bathymetry zoom: z11 Terrarium tiles carry no bathymetry and read exactly 0 at sea. */
const SEA_ZOOM = 9

const s2url = (zoom: number) => (x: number, y: number) =>
  `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/${zoom}/${y}/${x}.jpg`

const elevation = await fetchMosaic(ZOOM, terrarium.url(ZOOM), 1, terrarium.decode)
const bathymetry = await fetchMosaic(SEA_ZOOM, terrarium.url(SEA_ZOOM), 1, terrarium.decode)
const h = new Float32Array(1)
const heightAt = (lon: number, lat: number) => (elevation.sample(lon, lat, h), h[0])
// Land wherever either source sees it, so the drape never falls short of the terrain mesh.
const isSea = (lon: number, lat: number) => heightAt(lon, lat) <= 0 && (bathymetry.sample(lon, lat, h), h[0]) <= 0

await mkdir('public/textures', { recursive: true })

// Normals: central differences in metres on the domain grid.
{
  const n = NORMAL_SIZE
  const dLon = (DOMAIN.east - DOMAIN.west) / (n - 1)
  const dLat = (DOMAIN.north - DOMAIN.south) / (n - 1)
  const dx = (WORLD.width / (n - 1)) * 1000
  const dz = (WORLD.depth / (n - 1)) * 1000
  const out = Buffer.alloc(n * n * 3)
  forEachSample(DOMAIN, n, n, (i, j, lon, lat) => {
    const o = (j * n + i) * 3
    if (isSea(lon, lat)) {
      out[o] = out[o + 1] = 128
      return
    }
    // World +x is east, +z is south.
    const gx = (heightAt(lon + dLon, lat) - heightAt(lon - dLon, lat)) / (2 * dx)
    const gz = (heightAt(lon, lat - dLat) - heightAt(lon, lat + dLat)) / (2 * dz)
    const len = Math.hypot(gx, 1, gz)
    out[o] = Math.round((-gx / len) * 127.5 + 127.5)
    out[o + 1] = Math.round((-gz / len) * 127.5 + 127.5)
  })
  await sharp(out, { raw: { width: n, height: n, channels: 3 } })
    .webp({ quality: 92, smartSubsample: false })
    .toFile('public/textures/normals.webp')
  console.log(`wrote normals ${n}²`)
}

async function writeImagery(zoom: number, bounds: Bounds, width: number, height: number, file: string) {
  const imagery = await fetchMosaic(
    zoom,
    s2url(zoom),
    3,
    (rgb, out, offset, pixel) => {
      out[offset] = rgb[pixel * 3]
      out[offset + 1] = rgb[pixel * 3 + 1]
      out[offset + 2] = rgb[pixel * 3 + 2]
    },
    { bounds, bytes: true },
  )
  const out = Buffer.alloc(width * height * 3)
  const rgb = new Float32Array(3)
  forEachSample(bounds, width, height, (i, j, lon, lat) => {
    const o = (j * width + i) * 3
    if (isSea(lon, lat)) {
      out[o] = 18
      out[o + 1] = 38
      out[o + 2] = 46
      return
    }
    imagery.sample(lon, lat, rgb)
    out[o] = Math.round(rgb[0])
    out[o + 1] = Math.round(rgb[1])
    out[o + 2] = Math.round(rgb[2])
  })
  await sharp(out, { raw: { width, height, channels: 3 } })
    .webp({ quality: 82 })
    .toFile(file)
  console.log(`wrote ${file} ${width}x${height}`)
}

await writeImagery(ZOOM, DOMAIN, 4096, 4096, 'public/textures/imagery.webp')
await writeImagery(ZOOM + 1, DETAIL, 4096, 8192, 'public/textures/imagery-taiwan.webp')
