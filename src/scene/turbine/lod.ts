// Distance thresholds (world units) between LOD buckets: full mesh, simplified mesh, light point.
export const LOD_NEAR = 7
export const LOD_MID = 70

/** Latest LOD bucket sizes [near, mid, far/culled], written by WindFarms, read by the overlay. */
export const lodCounts: [number, number, number] = [0, 0, 0]
