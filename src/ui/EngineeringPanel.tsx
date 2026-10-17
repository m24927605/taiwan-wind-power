import { useStore } from '../state'
import { formatNumber } from './format'

const PIPELINE = [
  ['地形', 'AWS Terrain Tiles z9 → 1024² Int16 → R16F 高程貼圖'],
  ['風機', '程序建模 → meshopt LOD → 量化 + EXT_meshopt 壓縮 GLB 92 KB'],
  ['風場', '513 座 · 2 級 LOD instancing · 偏航與轉子在 vertex shader 計算'],
  ['黑潮', 'GPGPU ping-pong RGBA32F · 洋流場 R16F 雙線性內插'],
  ['資料', 'Open-Meteo Marine + Forecast 100 m · 瀏覽器快取 30 分鐘'],
]

export function EngineeringPanel() {
  const engineering = useStore((s) => s.engineering)
  const stats = useStore((s) => s.stats)
  if (!engineering || !stats) return null
  const fpsClass = stats.fps >= 55 ? 'is-good' : stats.fps >= 40 ? 'is-warn' : 'is-bad'
  return (
    <aside className="eng glass" aria-label="工程師模式">
      <header>
        <b>ENGINEERING</b>
        <span>工程師模式 · E</span>
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
        <div className="eng__lod-title">風機 LOD 分桶（每 3 幀以視錐 + 距離重排）</div>
        <div className="eng__lod-row"><i className="lod0" />LOD0 完整網格<b>{stats.lod[0]}</b></div>
        <div className="eng__lod-row"><i className="lod1" />LOD1 簡化網格<b>{stats.lod[1]}</b></div>
        <div className="eng__lod-row"><i className="lod2" />LOD2 光點 / 剔除<b>{stats.lod[2]}</b></div>
      </div>
      <ul className="eng__pipeline">
        {PIPELINE.map(([k, v]) => (
          <li key={k}>
            <b>{k}</b>
            {v}
          </li>
        ))}
      </ul>
    </aside>
  )
}
