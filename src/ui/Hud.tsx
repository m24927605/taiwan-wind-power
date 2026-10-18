import { WIND_FARMS } from '../data/windfarms'
import { hourIndex } from '../data/weather'
import { farmDynamics, totalOutputMW } from '../scene/turbine/dynamics'
import { useStore } from '../state'
import { compass8, formatDay, formatNumber, formatTime, useTicker } from './format'

const CAPACITY_MW = WIND_FARMS.reduce((sum, f) => sum + f.turbines * f.ratedMW, 0)
const TURBINE_COUNT = WIND_FARMS.reduce((sum, f) => sum + f.turbines, 0)

export function Title() {
  const live = useStore((s) => s.live)
  const weather = useStore((s) => s.weather)
  const snapshot = weather?.source === 'snapshot'
  return (
    <header className="title">
      <h1>
        風與潮<span>Wind &amp; Tide</span>
      </h1>
      <p className="title__sub">台灣海峽 · 即時數位孿生</p>
      <p className={`title__live ${live && !snapshot ? 'is-live' : ''}`}>
        <i />
        {!live ? '時光回放' : snapshot ? `資料快照 · ${formatDay(weather.fetchedAt)} ${formatTime(weather.fetchedAt)}` : 'LIVE · 即時資料'}
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
  if (error) return <aside className="metrics glass metrics--error">即時資料載入失敗：{error}</aside>
  if (!weather) return <aside className="metrics glass metrics--loading">正在讀取 Open-Meteo 即時資料…</aside>

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
      <div className="metrics__label">海峽離岸風電 · 估算即時出力</div>
      <div className="metrics__hero">
        {formatNumber(output)}
        <small>MW</small>
      </div>
      <div className="metrics__bar">
        <i style={{ width: `${(factor * 100).toFixed(1)}%` }} />
      </div>
      <div className="metrics__caption">
        容量因數 {(factor * 100).toFixed(0)}% · 裝置容量 {formatNumber(CAPACITY_MW)} MW · {TURBINE_COUNT} 座風機
      </div>
      <dl className="metrics__grid">
        <div>
          <dt>輪轂高度風速</dt>
          <dd className="is-wind">
            {meanWind.toFixed(1)}
            <small>m/s</small>
          </dd>
          <dd className="metrics__note">
            <span className="arrow" style={{ transform: `rotate(${windFrom + 180}deg)` }}>↑</span>
            {compass8(windFrom)}風
          </dd>
        </div>
        <div>
          <dt>黑潮最大流速</dt>
          <dd className="is-tide">
            {peakCurrent().toFixed(2)}
            <small>m/s</small>
          </dd>
          <dd className="metrics__note">
            Open-Meteo · {weather.source === 'snapshot' && `${formatDay(weather.fetchedAt)} `}
            {formatTime(weather.fetchedAt)} {weather.source === 'snapshot' ? '快照' : '更新'}
          </dd>
        </div>
      </dl>
    </aside>
  )
}
