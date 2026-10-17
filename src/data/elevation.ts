import * as THREE from 'three'
import { ELEVATION_SIZE, ELEVATION_URL, worldToDomainUv } from '../geo/domain'

export interface Elevation {
  /** Metres, row 0 at the north edge, corner-aligned over the domain. */
  data: Int16Array
  /** Elevation in kilometres (R channel, half float) for shaders, sampled with domain uv. */
  texture: THREE.DataTexture
  /** Bilinear elevation in metres at a world position; deep ocean outside the domain. */
  heightAt(x: number, z: number): number
}

export async function loadElevation(): Promise<Elevation> {
  const res = await fetch(ELEVATION_URL)
  if (!res.ok) throw new Error(`elevation: HTTP ${res.status}`)
  const data = new Int16Array(await res.arrayBuffer())
  const n = ELEVATION_SIZE

  const half = new Uint16Array(n * n)
  for (let i = 0; i < data.length; i++) half[i] = THREE.DataUtils.toHalfFloat(data[i] / 1000)
  const texture = new THREE.DataTexture(half, n, n, THREE.RedFormat, THREE.HalfFloatType)
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearFilter
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping
  // Row 0 is north; domain uv has v = 0 at north, so no flip is needed when sampling.
  texture.flipY = false
  texture.needsUpdate = true

  function heightAt(x: number, z: number): number {
    const [u, v] = worldToDomainUv(x, z)
    if (u < 0 || u > 1 || v < 0 || v > 1) return -4000
    const fx = u * (n - 1)
    const fy = v * (n - 1)
    const ix = Math.min(Math.floor(fx), n - 2)
    const iy = Math.min(Math.floor(fy), n - 2)
    const tx = fx - ix
    const ty = fy - iy
    const i = iy * n + ix
    const top = data[i] * (1 - tx) + data[i + 1] * tx
    const bottom = data[i + n] * (1 - tx) + data[i + n + 1] * tx
    return top * (1 - ty) + bottom * ty
  }

  return { data, texture, heightAt }
}
