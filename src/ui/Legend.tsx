import { useT } from '../i18n'

const CONTACT = 'm24927605@gmail.com'

export function Legend() {
  const t = useT()
  return (
    <>
      <div className="legend" aria-label={t.legend}>
        <div className="legend__row">
          <span className="legend__ramp" />
          <span>{t.legendCurrent}</span>
        </div>
        <div className="legend__row">
          <span className="legend__blink" />
          <span>{t.legendLights}</span>
        </div>
        <div className="legend__row">
          <svg className="legend__idle" viewBox="-10 -10 20 20" aria-hidden="true">
            {[0, 120, 240].map((a) => (
              <path key={a} d="M-1.2 0 L0 -9 L1.2 0 Z" transform={`rotate(${a})`} />
            ))}
            <circle r="1.8" />
          </svg>
          <span>{t.legendIdle}</span>
        </div>
      </div>
      <div className="attribution">
        <a href="https://s2maps.eu" target="_blank" rel="noreferrer">
          <span className="attribution__long">{t.attributionLong}</span>
          <span className="attribution__short">{t.attributionShort}</span>
        </a>
        {' · '}
        <a href={`mailto:${CONTACT}`}>
          {t.contact} {CONTACT}
        </a>
      </div>
    </>
  )
}
