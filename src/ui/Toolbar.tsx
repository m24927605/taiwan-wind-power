import { useEffect } from 'react'
import { SoundButton } from './SoundPanel'
import { resetView } from '../scene/camera'
import { atmosphere } from '../scene/atmosphere'
import { setLang, useT } from '../i18n'
import { useStore, type Tool } from '../state'

function setTool(tool: Tool) {
  useStore.setState({ tool, measure: [], selected: tool === 'measure' ? null : useStore.getState().selected })
}

function toggleEngineering() {
  const engineering = !useStore.getState().engineering
  atmosphere.uDebug.value = engineering ? 1 : 0
  useStore.setState({ engineering })
}

export function Toolbar() {
  const tool = useStore((s) => s.tool)
  const engineering = useStore((s) => s.engineering)
  const t = useT()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey) return
      const key = e.key.toLowerCase()
      if (key === 'e') toggleEngineering()
      else if (key === 'm') setTool(useStore.getState().tool === 'measure' ? 'inspect' : 'measure')
      else if (key === 'r') resetView()
      else if (key === 'escape') useStore.setState({ selected: null, measure: [] })
      else if (key === ' ') {
        e.preventDefault()
        const { live, speed } = useStore.getState()
        useStore.setState(!live && speed > 0 ? { speed: 0 } : { live: false, speed: 1.5 })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <nav className="toolbar glass" aria-label={t.tools}>
      <button className={tool === 'inspect' ? 'is-on' : ''} onClick={() => setTool('inspect')} title={t.inspectTitle}>
        <svg viewBox="0 0 24 24"><path d="M5 3l14 8-6 1.6L10 19z" /></svg>
        <span>{t.inspect}</span>
      </button>
      <button className={tool === 'measure' ? 'is-on' : ''} onClick={() => setTool(tool === 'measure' ? 'inspect' : 'measure')} title={t.measureTitle}>
        <svg viewBox="0 0 24 24"><path d="M3 17L17 3l4 4L7 21zM7 13l2 2M10 10l2 2M13 7l2 2" /></svg>
        <span>{t.measure}</span>
      </button>
      <button className={engineering ? 'is-on is-eng' : ''} onClick={toggleEngineering} title={t.engineeringTitle}>
        <svg viewBox="0 0 24 24"><path d="M8 3v3M16 3v3M8 18v3M16 18v3M3 8h3M3 16h3M18 8h3M18 16h3M6 6h12v12H6zM10 10h4v4h-4z" /></svg>
        <span>{t.engineering}</span>
      </button>
      <button onClick={resetView} title={t.overviewTitle}>
        <svg viewBox="0 0 24 24"><path d="M4 11l8-7 8 7M6 9.5V20h12V9.5" /></svg>
        <span>{t.overview}</span>
      </button>
      <SoundButton />
      <button className="toolbar__lang" onClick={() => setLang(t.lang === 'zh' ? 'en' : 'zh')} title={t.switchLabel} aria-label={t.switchLabel}>
        <b>{t.switchTo}</b>
      </button>
    </nav>
  )
}

/** A prominent way home whenever the camera has left the island-wide view. */
export function OverviewReturn() {
  const show = useStore((s) => !s.atOverview)
  const t = useT()
  if (!show) return null
  return (
    <button className="overview-return glass" onClick={resetView}>
      <svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" /></svg>
      {t.backToOverview}
      <kbd>R</kbd>
    </button>
  )
}

export function ToolHint() {
  const tool = useStore((s) => s.tool)
  const count = useStore((s) => s.measure.length)
  const t = useT()
  if (tool !== 'measure') return null
  return <div className="tool-hint">{count === 1 ? t.measureSecond : t.measureFirst}</div>
}
