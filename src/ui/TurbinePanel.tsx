import { TURBINES, WIND_FARMS } from '../data/windfarms'
import { farmDynamics } from '../scene/turbine/dynamics'
import { TURBINE, powerAt } from '../scene/turbine/spec'
import { worldToLonLat } from '../geo/domain'
import { useStore } from '../state'
import { compass8, useTicker } from './format'

const CHART = { w: 232, h: 92, maxWind: 28 }

function PowerCurve({ wind }: { wind: number }) {
  const x = (v: number) => (v / CHART.maxWind) * CHART.w
  const y = (p: number) => CHART.h - (p / TURBINE.ratedPowerMW) * (CHART.h - 10) - 2
  const path = Array.from({ length: 141 }, (_, i) => {
    const v = (i / 140) * CHART.maxWind
    return `${i ? 'L' : 'M'}${x(v).toFixed(1)},${y(powerAt(v)).toFixed(1)}`
  }).join('')
  const p = powerAt(wind)
  return (
    <svg className="curve" viewBox={`0 0 ${CHART.w} ${CHART.h + 16}`} role="img" aria-label="功率曲線">
      {[TURBINE.cutInMs, TURBINE.ratedMs, TURBINE.cutOutMs].map((v) => (
        <g key={v}>
          <line x1={x(v)} x2={x(v)} y1={4} y2={CHART.h} className="curve__grid" />
          <text x={x(v)} y={CHART.h + 12} className="curve__tick">
            {v}
          </text>
        </g>
      ))}
      <path d={path} className="curve__line" />
      <line x1={x(wind)} x2={x(wind)} y1={y(p)} y2={CHART.h} className="curve__probe" />
      <circle cx={x(wind)} cy={y(p)} r={4} className="curve__dot" />
    </svg>
  )
}

export function TurbinePanel() {
  useTicker(200)
  const selected = useStore((s) => s.selected)
  if (selected === null) return null
  const t = TURBINES[selected]
  const farm = WIND_FARMS[t.farm]
  const number = TURBINES.filter((o) => o.farm === t.farm).indexOf(t) + 1
  const wind = farmDynamics.wind[t.farm]
  const fromDeg = (((farmDynamics.windFrom[t.farm] * 180) / Math.PI) % 360 + 360) % 360
  const scale = farm.ratedMW / TURBINE.ratedPowerMW
  const output = powerAt(wind) * scale
  const [lon, lat] = worldToLonLat(t.x, t.z)
  const state =
    wind < TURBINE.cutInMs ? '待機 · 低於切入風速' : wind >= TURBINE.cutOutMs ? '停機保護 · 超過切出風速' : wind >= TURBINE.ratedMs ? '額定運轉' : '部分負載運轉'

  return (
    <aside className="panel glass" aria-label="風機資訊">
      <button className="panel__close" onClick={() => useStore.setState({ selected: null })} aria-label="關閉">
        ×
      </button>
      <div className="panel__kicker">{farm.nameEn}</div>
      <h2>
        {farm.name}
        <span>
          WTG-{String(number).padStart(3, '0')} / {farm.turbines}
        </span>
      </h2>
      <div className="panel__coords">
        {lat.toFixed(4)}°N {lon.toFixed(4)}°E · 額定 {farm.ratedMW} MW
      </div>
      <div className="panel__state">
        <i className={output > 0 ? 'is-on' : ''} />
        {state}
      </div>
      <dl className="panel__stats">
        <div>
          <dt>輪轂風速</dt>
          <dd className="is-wind">
            {wind.toFixed(1)}
            <small>m/s</small>
          </dd>
        </div>
        <div>
          <dt>風向</dt>
          <dd>
            <span className="arrow" style={{ transform: `rotate(${fromDeg + 180}deg)` }}>↑</span>
            {compass8(fromDeg)}
            <small>{fromDeg.toFixed(0)}°</small>
          </dd>
        </div>
        <div>
          <dt>轉速</dt>
          <dd>
            {farmDynamics.rpm[t.farm].toFixed(1)}
            <small>rpm</small>
          </dd>
        </div>
        <div>
          <dt>即時出力</dt>
          <dd className="is-tide">
            {output.toFixed(2)}
            <small>MW</small>
          </dd>
        </div>
      </dl>
      <div className="panel__chart">
        <div className="panel__chart-title">功率曲線 · 風速 m/s</div>
        <PowerCurve wind={wind} />
      </div>
      <p className="panel__foot">機艙剖面：主軸承 → 齒輪箱 → 發電機。風機位置為依公開資料推估的近似陣列。</p>
    </aside>
  )
}
