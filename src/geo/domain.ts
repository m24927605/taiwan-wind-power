// Geographic domain of the scene and the mapping between lon/lat and world units.
// World units are kilometres on a local equirectangular projection centred on Taiwan:
// +x points east, -z points north, +y is up.

// Wide enough east-west that a north-up view of the whole island on a wide screen shows nothing
// but mapped data (see camera.ts); centred on 120.8 E like the island and the farms.
export const DOMAIN = {
  west: 116.6,
  east: 125.0,
  south: 21.4,
  north: 25.8,
} as const

export interface Bounds {
  west: number
  east: number
  south: number
  north: number
}

/**
 * Where the clouds come from Himawari-9 scans: everything the camera can see, from the widest
 * zoom-out (about 117-131 E, 20-32 N) plus the 160 km a ray marches through the cloud layer.
 */
export const SATELLITE_BOUNDS = {
  west: 113.5,
  east: 131.5,
  south: 16.5,
  north: 33.0,
} as const

/** Main island, Green Island and Orchid Island: draped with sharper imagery than the rest. */
export const DETAIL = {
  west: 119.95,
  east: 122.05,
  south: 21.85,
  north: 25.35,
} as const

export const ELEVATION_SIZE = 1024
export const ELEVATION_URL = 'data/taiwan-elevation.png'

/**
 * The tidal flats of the Changhua and Yunlin coast (scripts/build-tidal-flats.ts): elevation about
 * mean sea level, one byte per texel over this box, row 0 at the north. 0 is no flat; 1 to 255
 * span TIDAL_FLATS.min to TIDAL_FLATS.max metres. Read as a linear texture, no flat reads as
 * TIDAL_FLATS.min, below any tide that comes, so blending at the flats' edges never uncovers sea.
 */
export const TIDAL_FLATS = {
  west: 120.05,
  east: 120.5,
  south: 23.6,
  north: 24.25,
  /** Degrees per texel, about 40 m. */
  step: 0.0004,
  min: -2.5,
  max: 2.5,
  url: 'data/tidal-flats.png',
} as const

const ORIGIN_LON = (DOMAIN.west + DOMAIN.east) / 2
const ORIGIN_LAT = (DOMAIN.south + DOMAIN.north) / 2
const KM_PER_DEG_LAT = 110.574
const KM_PER_DEG_LON = 111.32 * Math.cos((ORIGIN_LAT * Math.PI) / 180)

export function lonLatToWorld(lon: number, lat: number): [x: number, z: number] {
  return [(lon - ORIGIN_LON) * KM_PER_DEG_LON, -(lat - ORIGIN_LAT) * KM_PER_DEG_LAT]
}

export function worldToLonLat(x: number, z: number): [lon: number, lat: number] {
  return [x / KM_PER_DEG_LON + ORIGIN_LON, -z / KM_PER_DEG_LAT + ORIGIN_LAT]
}

/** Extents of a lon/lat box in world units. */
export function worldExtent(b: Bounds) {
  const [x0, z0] = lonLatToWorld(b.west, b.north)
  const [x1, z1] = lonLatToWorld(b.east, b.south)
  return { minX: x0, maxX: x1, minZ: z0, maxZ: z1, width: x1 - x0, depth: z1 - z0 }
}

/** Domain extents in world units. */
export const WORLD = worldExtent(DOMAIN)

/** Normalised domain uv (0..1, v = 0 at the north edge) for a world position. */
export function worldToDomainUv(x: number, z: number): [u: number, v: number] {
  return [(x - WORLD.minX) / WORLD.width, (z - WORLD.minZ) / WORLD.depth]
}
