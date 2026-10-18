import { CHANNELS, setSoundEnabled, useSound, type Channel } from '../audio/engine'
import { useT } from '../i18n'

const LABEL_KEY: Record<Channel, 'master' | 'music' | 'ambience' | 'noise' | 'effects'> = {
  master: 'master',
  music: 'music',
  ambience: 'ambience',
  noise: 'noise',
  effects: 'effects',
}

/** Toolbar button for the soundscape, with its mixer. */
export function SoundButton() {
  const t = useT()
  const enabled = useSound((s) => s.enabled)
  const open = useSound((s) => s.panelOpen)
  return (
    <>
      <button
        className={enabled ? 'is-on' : ''}
        onClick={() => useSound.setState({ panelOpen: !open })}
        title={t.soundTitle}
        aria-expanded={open}
      >
        <svg viewBox="0 0 24 24">
          <path d="M4 9.5h3.5L12 5v14l-4.5-4.5H4z" />
          {enabled ? <path d="M15.5 8.5a5 5 0 010 7M18 6a8.5 8.5 0 010 12" /> : <path d="M16 9.5l5 5M21 9.5l-5 5" />}
        </svg>
        <span>{t.sound}</span>
      </button>
      {open && <SoundPanel />}
    </>
  )
}

function SoundPanel() {
  const t = useT()
  const enabled = useSound((s) => s.enabled)
  const levels = useSound((s) => s.levels)
  return (
    <section className="sound-panel glass" aria-label={t.mixer} onPointerDown={(e) => e.stopPropagation()}>
      <header>
        <b>{t.mixer}</b>
        <button className={`sound-panel__toggle ${enabled ? 'is-on' : ''}`} onClick={() => setSoundEnabled(!enabled)}>
          {enabled ? t.soundOff : t.soundOn}
        </button>
      </header>
      {CHANNELS.map((c) => (
        <label key={c} className="sound-panel__row">
          <span>{t[LABEL_KEY[c]]}</span>
          <input
            id={`sound-${c}`}
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={levels[c]}
            onChange={(e) => useSound.setState({ levels: { ...levels, [c]: Number(e.target.value) } })}
          />
          <output>{Math.round(levels[c] * 100)}</output>
        </label>
      ))}
      <p className="sound-panel__note">{t.soundNote}</p>
      <details className="sound-panel__credits">
        <summary>{t.credits}</summary>
        <p>{t.creditMusic}</p>
        <p>{t.creditSounds}</p>
      </details>
    </section>
  )
}
