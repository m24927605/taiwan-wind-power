import { useLayoutEffect, useRef, useState } from 'react'
import type { Part } from '../scene/turbine/parts'
import { useTicker } from './format'

// Room kept clear for the side panels; cards that would run under them open to the left.
const SIDE_PANEL_PX = 340

/** Explainer for one nacelle component, opened from its 3D label. */
export function PartCard({ part, farm, onClose }: { part: Part; farm: number; onClose: () => void }) {
  useTicker(250)
  const reading = part.live(farm)
  const ref = useRef<HTMLDivElement>(null)
  const [left, setLeft] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (el && innerWidth > 760) setLeft(el.getBoundingClientRect().right > innerWidth - SIDE_PANEL_PX)
  }, [])
  return (
    <div
      ref={ref}
      className={`part-card glass${left ? ' is-left' : ''}`}
      role="dialog"
      aria-label={part.name}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button className="part-card__close" onClick={onClose} aria-label="關閉">
        ×
      </button>
      <div className="part-card__kicker">{part.en}</div>
      <h3>{part.name}</h3>
      <p>{part.role}</p>
      <div className="part-card__live">
        <span>{reading.label}</span>
        <b>
          {reading.value}
          {reading.unit && <small>{reading.unit}</small>}
        </b>
      </div>
      <dl>
        {part.facts.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <div className="part-card__foot">規格為 8 MW 級離岸風機典型值</div>
    </div>
  )
}
