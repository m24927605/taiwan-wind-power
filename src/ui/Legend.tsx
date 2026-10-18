import { useT } from '../i18n'

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
      </div>
      <a className="attribution" href="https://s2maps.eu" target="_blank" rel="noreferrer">
        <span className="attribution__long">{t.attributionLong}</span>
        <span className="attribution__short">{t.attributionShort}</span>
      </a>
    </>
  )
}
