import { TURBINES, WIND_FARMS } from '../data/windfarms'
import { farmDynamics } from '../scene/turbine/dynamics'
import { TURBINE, powerAt } from '../scene/turbine/spec'
import { worldToLonLat } from '../geo/domain'
import { useT } from '../i18n'
import { useStore } from '../state'
import { compass8, useTicker } from './format'

const CHART = { w: 232, h: 92, maxWind: 28 }

function PowerCurve({ wind, label }: { wind: number; label: string }) {
  const x = (v: number) => (v / CHART.maxWind) * CHART.w
  const y = (p: number) => CHART.h - (p / TURBINE.ratedPowerMW) * (CHART.h - 10) - 2
  const path = Array.from({ length: 141 }, (_, i) => {
    const v = (i / 140) * CHART.maxWind
    return `${i ? 'L' : 'M'}${x(v).toFixed(1)},${y(powerAt(v)).toFixed(1)}`
  }).join('')
  const p = powerAt(wind)
  return (
    <svg className="curve" viewBox={`0 0 ${CHART.w} ${CHART.h + 16}`} role="img" aria-label={label}>
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
  const tr = useT()
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
    wind < TURBINE.cutInMs ? tr.stateIdle : wind >= TURBINE.cutOutMs ? tr.stateCutOut : wind >= TURBINE.ratedMs ? tr.stateRated : tr.statePartial
  // The farm's own-language name leads; the other one is the kicker.
  const [name, kicker] = tr.lang === 'zh' ? [farm.name, farm.nameEn] : [farm.nameEn, farm.name]

  return (
    <aside className="panel glass" aria-label={tr.turbineInfo}>
      <button className="panel__close" onClick={() => useStore.setState({ selected: null })} aria-label={tr.close}>
        ×
      </button>
      <div className="panel__kicker">{kicker}</div>
      <h2>
        {name}
        <span>
          WTG-{String(number).padStart(3, '0')} / {farm.turbines}
        </span>
      </h2>
      <div className="panel__coords">
        {lat.toFixed(4)}°N {lon.toFixed(4)}°E · {tr.rated(farm.ratedMW)}
      </div>
      <div className="panel__state">
        <i className={output > 0 ? 'is-on' : ''} />
        {state}
      </div>
      <dl className="panel__stats">
        <div>
          <dt>{tr.hubWindShort}</dt>
          <dd className="is-wind">
            {wind.toFixed(1)}
            <small>m/s</small>
          </dd>
        </div>
        <div>
          <dt>{tr.windDirection}</dt>
          <dd>
            <span className="arrow" style={{ transform: `rotate(${fromDeg + 180}deg)` }}>↑</span>
            {compass8(fromDeg, tr.lang)}
            <small>{fromDeg.toFixed(0)}°</small>
          </dd>
        </div>
        <div>
          <dt>{tr.rotorSpeed}</dt>
          <dd>
            {farmDynamics.rpm[t.farm].toFixed(1)}
            <small>rpm</small>
          </dd>
        </div>
        <div>
          <dt>{tr.outputNow}</dt>
          <dd className="is-tide">
            {output.toFixed(2)}
            <small>MW</small>
          </dd>
        </div>
      </dl>
      <div className="panel__chart">
        <div className="panel__chart-title">{tr.powerCurveTitle}</div>
        <PowerCurve wind={wind} label={tr.powerCurve} />
      </div>
      <p className="panel__foot">{tr.turbineFoot}</p>
    </aside>
  )
}
