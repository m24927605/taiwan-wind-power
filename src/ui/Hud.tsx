import { WIND_FARMS } from '../data/windfarms'
import { hourIndex } from '../data/weather'
import { farmDynamics, totalOutputMW } from '../scene/turbine/dynamics'
import { useT } from '../i18n'
import { useStore } from '../state'
import { compass8, formatDay, formatNumber, formatTime, useTicker } from './format'

const CAPACITY_MW = WIND_FARMS.reduce((sum, f) => sum + f.turbines * f.ratedMW, 0)
const TURBINE_COUNT = WIND_FARMS.reduce((sum, f) => sum + f.turbines, 0)

export function Title() {
  const live = useStore((s) => s.live)
  const weather = useStore((s) => s.weather)
  const snapshot = weather?.source === 'snapshot'
  const t = useT()
  return (
    <header className="title">
      <h1>
        風與潮<span>Wind &amp; Tide</span>
      </h1>
      <p className="title__sub">{t.subtitle}</p>
      <p className={`title__live ${live && !snapshot ? 'is-live' : ''}`}>
        <i />
        {!live ? t.replay : snapshot ? t.snapshot(`${formatDay(weather.fetchedAt, t.lang)} ${formatTime(weather.fetchedAt, t.lang)}`) : t.live}
      </p>
    </header>
  )
}

function peakCurrent(): number {
  const { weather, time } = useStore.getState()
  if (!weather) return 0
  const frame = weather.currents[Math.round(hourIndex(weather, time))]
  let peak = 0
  for (let i = 0; i < frame.length; i += 2) peak = Math.max(peak, Math.hypot(frame[i], frame[i + 1]))
  return peak
}

export function Metrics() {
  useTicker(250)
  const weather = useStore((s) => s.weather)
  const error = useStore((s) => s.error)
  const t = useT()
  if (error) return <aside className="metrics glass metrics--error">{t.loadFailed(error)}</aside>
  if (!weather) return <aside className="metrics glass metrics--loading">{t.loading}</aside>

  const output = totalOutputMW()
  let windSum = 0
  let vx = 0
  let vy = 0
  WIND_FARMS.forEach((f, i) => {
    windSum += farmDynamics.wind[i] * f.turbines
    vx += Math.sin(farmDynamics.windFrom[i]) * f.turbines
    vy += Math.cos(farmDynamics.windFrom[i]) * f.turbines
  })
  const meanWind = windSum / TURBINE_COUNT
  const windFrom = ((Math.atan2(vx, vy) * 180) / Math.PI + 360) % 360
  const factor = output / CAPACITY_MW

  return (
    <aside className="metrics glass">
      <div className="metrics__label">{t.outputLabel}</div>
      <div className="metrics__hero">
        {formatNumber(output)}
        <small>MW</small>
      </div>
      <div className="metrics__bar">
        <i style={{ width: `${(factor * 100).toFixed(1)}%` }} />
      </div>
      <div className="metrics__caption">
        {t.capacityCaption((factor * 100).toFixed(0), formatNumber(CAPACITY_MW), TURBINE_COUNT)}
      </div>
      <dl className="metrics__grid">
        <div>
          <dt>{t.hubWind}</dt>
          <dd className="is-wind">
            {meanWind.toFixed(1)}
            <small>m/s</small>
          </dd>
          <dd className="metrics__note">
            <span className="arrow" style={{ transform: `rotate(${windFrom + 180}deg)` }}>↑</span>
            {t.windFrom(compass8(windFrom, t.lang))}
          </dd>
        </div>
        <div>
          <dt>{t.peakCurrent}</dt>
          <dd className="is-tide">
            {peakCurrent().toFixed(2)}
            <small>m/s</small>
          </dd>
          <dd className="metrics__note">
            Open-Meteo · {weather.source === 'snapshot' && `${formatDay(weather.fetchedAt, t.lang)} `}
            {formatTime(weather.fetchedAt, t.lang)} {weather.source === 'snapshot' ? t.snapshotTag : t.updated}
          </dd>
        </div>
      </dl>
    </aside>
  )
}
