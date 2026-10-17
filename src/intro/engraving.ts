import * as THREE from 'three'
import type { Elevation } from '../data/elevation'
import { ELEVATION_SIZE } from '../geo/domain'

/**
 * Gold-leaf engraving of Taiwan for the inkstone: coastline plus 300 m contours, drawn from
 * the same elevation grid as the main scene so the intro can match-cut into it.
 * The domain square is centred in a texture whose aspect matches the stone's face.
 */
export function createEngraving(elevation: Elevation, aspect: number): THREE.CanvasTexture {
  const height = 1024
  const width = Math.round(height * aspect)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  const image = ctx.createImageData(width, height)
  const { data } = elevation
  const n = ELEVATION_SIZE
  // The square domain spans this fraction of the stone's height.
  const span = height * 0.86
  const x0 = (width - span) / 2
  const y0 = (height - span) / 2

  const sample = (px: number, py: number) => {
    const u = (px - x0) / span
    const v = (py - y0) / span
    if (u < 0 || u > 1 || v < 0 || v > 1) return -1000
    return data[Math.round(v * (n - 1)) * n + Math.round(u * (n - 1))]
  }

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const h = sample(x, y)
      const right = sample(x + 1, y)
      const down = sample(x, y + 1)
      const band = (v: number) => Math.floor(v / 300)
      let a = 0
      if (h > 0 !== right > 0 || h > 0 !== down > 0) a = 1
      else if (h > 0 && (band(h) !== band(right) || band(h) !== band(down))) a = 0.42
      else if (h > 0) a = 0.05
      const i = (y * width + x) * 4
      image.data[i] = image.data[i + 1] = image.data[i + 2] = Math.round(a * 255)
      image.data[i + 3] = 255
    }
  }
  ctx.putImageData(image, 0, 0)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  return texture
}
