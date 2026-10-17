import { Html, Line } from '@react-three/drei'
import { useStore } from '../state'
import { worldToLonLat } from '../geo/domain'

const LIFT = 0.06

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

function compass(deg: number): string {
  const names = ['北', '北北東', '東北', '東北東', '東', '東南東', '東南', '南南東', '南', '南南西', '西南', '西南西', '西', '西北西', '西北', '北北西']
  return names[Math.round(deg / 22.5) % 16]
}

export function Measure() {
  const points = useStore((s) => s.measure)
  const tool = useStore((s) => s.tool)
  if (tool !== 'measure' || points.length === 0) return null
  const [a, b] = points
  const result = b && geodesic(a, b)
  return (
    <group>
      {points.map(([x, z], i) => (
        <Html key={i} position={[x, LIFT, z]} center zIndexRange={[20, 0]}>
          <span className="measure-dot" />
        </Html>
      ))}
      {b && result && (
        <>
          <Line
            points={[
              [a[0], LIFT, a[1]],
              [b[0], LIFT, b[1]],
            ]}
            color="#ffd27a"
            lineWidth={2}
            depthTest={false}
            renderOrder={5}
          />
          <Html position={[(a[0] + b[0]) / 2, LIFT, (a[1] + b[1]) / 2]} center zIndexRange={[20, 0]}>
            <div className="measure-label">
              <b>{result.km < 10 ? result.km.toFixed(2) : result.km.toFixed(1)} km</b>
              <span>
                方位 {compass(result.bearing)} {result.bearing.toFixed(0)}°
              </span>
            </div>
          </Html>
        </>
      )}
    </group>
  )
}
