import { worldToLonLat } from './domain'

/** Great-circle distance in km and initial bearing in degrees between two world points. */
export function geodesic(a: [number, number], b: [number, number]): { km: number; bearing: number } {
  const [lon1, lat1] = worldToLonLat(...a).map((v) => (v * Math.PI) / 180)
  const [lon2, lat2] = worldToLonLat(...b).map((v) => (v * Math.PI) / 180)
  const h = Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2
  const km = 2 * 6371.0088 * Math.asin(Math.sqrt(h))
  const y = Math.sin(lon2 - lon1) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1)
  const bearing = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
  return { km, bearing }
}
