import { Html, Line } from '@react-three/drei'
import { useStore } from '../state'
import { geodesic } from '../geo/geodesic'
import { useT } from '../i18n'
import { compass16 } from '../ui/format'

const LIFT = 0.06

export function Measure() {
  const points = useStore((s) => s.measure)
  const tool = useStore((s) => s.tool)
  const t = useT()
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
                {t.bearing} {compass16(result.bearing, t.lang)} {result.bearing.toFixed(0)}°
              </span>
            </div>
          </Html>
        </>
      )}
    </group>
  )
}
