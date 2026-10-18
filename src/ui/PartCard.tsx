import { useLayoutEffect, useRef, useState } from 'react'
import type { Part } from '../scene/turbine/parts'
import { useT } from '../i18n'
import { useTicker } from './format'

// Room kept clear for the side panels; cards that would run under them open to the left.
const SIDE_PANEL_PX = 340

/** Explainer for one nacelle component, opened from its 3D label. */
export function PartCard({ part, farm, onClose }: { part: Part; farm: number; onClose: () => void }) {
  useTicker(250)
  const t = useT()
  const reading = part.live(farm, t.lang)
  const text = part.text[t.lang]
  // In Chinese the English name rides along as a kicker; in English the name stands alone.
  const kicker = t.lang === 'zh' ? part.text.en.name : null
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
      aria-label={text.name}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button className="part-card__close" onClick={onClose} aria-label={t.close}>
        ×
      </button>
      {kicker && <div className="part-card__kicker">{kicker}</div>}
      <h3>{text.name}</h3>
      <p>{text.role}</p>
      <div className="part-card__live">
        <span>{reading.label}</span>
        <b>
          {reading.value}
          {reading.unit && <small>{reading.unit}</small>}
        </b>
      </div>
      <dl>
        {text.facts.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <div className="part-card__foot">{t.partFoot}</div>
    </div>
  )
}
