import { generationAt } from '../data/weather'
import { TURBINES, WIND_FARMS } from '../data/windfarms'
import { farmDynamics, isTurning, turbineOutput, turbineRpm } from '../scene/turbine/dynamics'
import { TURBINE, TURBINE_MODELS, powerAt, type TurbineModel } from '../scene/turbine/spec'
import { worldToLonLat } from '../geo/domain'
import { useT } from '../i18n'
import { useStore } from '../state'
import { compass8, formatTime, useTicker } from './format'

const CHART = { w: 232, h: 92, maxWind: 34 }

function PowerCurve({ model, wind, output, label }: { model: TurbineModel; wind: number; output: number; label: string }) {
  const { derateMs, cutOutMs } = TURBINE_MODELS[model]
  const x = (v: number) => (Math.min(v, CHART.maxWind) / CHART.maxWind) * CHART.w
  const y = (p: number) => CHART.h - (p / TURBINE.ratedPowerMW) * (CHART.h - 10) - 2
  const path = Array.from({ length: 141 }, (_, i) => {
    const v = (i / 140) * CHART.maxWind
    return `${i ? 'L' : 'M'}${x(v).toFixed(1)},${y(powerAt(v, model)).toFixed(1)}`
  }).join('')
  return (
    <svg className="curve" viewBox={`0 0 ${CHART.w} ${CHART.h + 16}`} role="img" aria-label={label}>
      {[...new Set([TURBINE.cutInMs, TURBINE.ratedMs, derateMs, cutOutMs])].map((v) => (
        <g key={v}>
          <line x1={x(v)} x2={x(v)} y1={4} y2={CHART.h} className="curve__grid" />
          <text x={x(v)} y={CHART.h + 12} className="curve__tick">
            {v}
          </text>
        </g>
      ))}
      <path d={path} className="curve__line" />
      <line x1={x(wind)} x2={x(wind)} y1={y(output)} y2={CHART.h} className="curve__probe" />
      <circle cx={x(wind)} cy={y(output)} r={4} className="curve__dot" />
    </svg>
  )
}

export function TurbinePanel() {
  useTicker(200)
  const selected = useStore((s) => s.selected)
  const weather = useStore((s) => s.weather)
  const tr = useT()
  if (selected === null) return null
  const t = TURBINES[selected]
  const farm = WIND_FARMS[t.farm]
  const number = TURBINES.filter((o) => o.farm === t.farm).indexOf(t) + 1
  const wind = farmDynamics.wind[t.farm]
  const fromDeg = (((farmDynamics.windFrom[t.farm] * 180) / Math.PI) % 360 + 360) % 360
  const shutDown = farmDynamics.shutDown[t.farm] === 1
  const output = turbineOutput(t)
  // On the shared curve, which is drawn for the 8 MW reference machine.
  const reference = output * (TURBINE.ratedPowerMW / farm.ratedMW)
  const [lon, lat] = worldToLonLat(t.x, t.z)
  const turning = Math.round(farmDynamics.running[t.farm] * farm.turbines)
  // Where Taipower's output has it turning or stopped against the model, it says so.
  const modelRuns = farmDynamics.modelled[t.farm] > 0
  const state = !isTurning(t)
    ? modelRuns || turning > 0
      ? tr.stateStoppedMeasured
      : shutDown
        ? tr.stateCutOut(TURBINE.restartMs)
        : tr.stateIdle
    : !modelRuns
      ? tr.stateRunningMeasured
      : wind > TURBINE_MODELS[farm.model].derateMs
        ? tr.stateDerated
        : wind >= TURBINE.ratedMs
          ? tr.stateRated
          : tr.statePartial
  const generation = weather && generationAt(weather, useStore.getState().time)
  const measured = generation?.mw[t.farm] ?? null
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
        {lat.toFixed(4)}°N {lon.toFixed(4)}°E · {farm.model} · {tr.rated(farm.ratedMW)}
      </div>
      <div className="panel__state">
        <i className={output > 0 ? 'is-on' : ''} />
        {state}
        <small>{tr.turning(turning, farm.turbines)}</small>
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
            {turbineRpm(t).toFixed(1)}
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
      {generation && measured !== null && (
        <div className="panel__measured">
          {tr.farmOutput(measured.toFixed(1), farmDynamics.modelled[t.farm].toFixed(1), formatTime(generation.at, tr.lang))}
        </div>
      )}
      <div className="panel__chart">
        <div className="panel__chart-title">{tr.powerCurveTitle}</div>
        <PowerCurve model={farm.model} wind={wind} output={reference} label={tr.powerCurve} />
      </div>
      <p className="panel__foot">{tr.turbineFoot}</p>
    </aside>
  )
}
