import { useT } from '../i18n'
import { useStore } from '../state'
import { formatNumber } from './format'

export function EngineeringPanel() {
  const engineering = useStore((s) => s.engineering)
  const stats = useStore((s) => s.stats)
  const t = useT()
  if (!engineering || !stats) return null
  const fpsClass = stats.fps >= 55 ? 'is-good' : stats.fps >= 40 ? 'is-warn' : 'is-bad'
  return (
    <aside className="eng glass" aria-label={t.engineeringMode}>
      <header>
        <b>ENGINEERING</b>
        <span>{t.engineeringMode}</span>
      </header>
      <div className={`eng__fps ${fpsClass}`}>
        {stats.fps.toFixed(0)}
        <small>fps · {stats.frameMs.toFixed(1)} ms</small>
      </div>
      <dl className="eng__grid">
        <div><dt>Draw calls</dt><dd>{stats.calls}</dd></div>
        <div><dt>Triangles</dt><dd>{formatNumber(stats.triangles)}</dd></div>
        <div><dt>Points</dt><dd>{formatNumber(stats.points)}</dd></div>
        <div><dt>Particles</dt><dd>{formatNumber(stats.particles)}</dd></div>
        <div><dt>Geometries</dt><dd>{stats.geometries}</dd></div>
        <div><dt>Textures</dt><dd>{stats.textures}</dd></div>
        <div><dt>Programs</dt><dd>{stats.programs}</dd></div>
        <div><dt>DPR</dt><dd>{stats.dpr.toFixed(2)}</dd></div>
      </dl>
      <div className="eng__lod">
        <div className="eng__lod-title">{t.lodTitle}</div>
        <div className="eng__lod-row"><i className="lod0" />{t.lod0}<b>{stats.lod[0]}</b></div>
        <div className="eng__lod-row"><i className="lod1" />{t.lod1}<b>{stats.lod[1]}</b></div>
        <div className="eng__lod-row"><i className="lod2" />{t.lod2}<b>{stats.lod[2]}</b></div>
      </div>
      <ul className="eng__pipeline">
        {t.pipeline.map(([k, v]) => (
          <li key={k}>
            <b>{k}</b>
            {v}
          </li>
        ))}
      </ul>
    </aside>
  )
}
