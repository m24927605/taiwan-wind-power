import { useMemo } from 'react'
import { useT } from '../i18n'
import { useStore } from '../state'
import { formatDate, formatDay, formatTime, formatWeekday, taipeiHour } from './format'

const TIMELAPSE_HOURS_PER_SECOND = 1.5

export function Timeline() {
  const weather = useStore((s) => s.weather)
  const time = useStore((s) => s.time)
  const live = useStore((s) => s.live)
  const speed = useStore((s) => s.speed)
  const t = useT()

  const range = useMemo(() => {
    if (!weather) return null
    const start = weather.times[0]
    const end = weather.times[weather.times.length - 1]
    const days = weather.times.filter((t) => taipeiHour(t) === 0)
    return { start, end, days }
  }, [weather])

  if (!range) return null
  const pct = (t: number) => ((t - range.start) / (range.end - range.start)) * 100
  const now = Date.now() / 1000
  const playing = !live && speed > 0
  const hour = taipeiHour(time)
  const isNight = hour < 6 || hour >= 18

  return (
    <section className="timeline glass" aria-label={t.timeline}>
      <div className="timeline__controls">
        <button
          className="icon-btn"
          aria-label={playing ? t.pause : t.play}
          onClick={() => useStore.setState(playing ? { speed: 0 } : { live: false, speed: TIMELAPSE_HOURS_PER_SECOND })}
        >
          {playing ? (
            <svg viewBox="0 0 24 24"><path d="M7 5h3v14H7zM14 5h3v14h-3z" /></svg>
          ) : (
            <svg viewBox="0 0 24 24"><path d="M7 4.5v15l12.5-7.5z" /></svg>
          )}
        </button>
        <button className={`live-btn ${live ? 'is-on' : ''}`} onClick={() => useStore.setState({ live: true, speed: 0 })}>
          <i />
          LIVE
        </button>
        <div className="timeline__clock">
          <span className="timeline__date">{formatDate(time, t.lang)}</span>
          <span className="timeline__time">{formatTime(time, t.lang)}</span>
          <span className="timeline__tz">{isNight ? t.night : t.day} · UTC+8</span>
        </div>
      </div>
      <div className="timeline__track">
        {range.days.map((d) => (
          <span key={d} className="timeline__day" style={{ left: `${pct(d)}%` }}>
            {formatDay(d, t.lang)}
            <em>{formatWeekday(d, t.lang)}</em>
          </span>
        ))}
        <span className="timeline__now" style={{ left: `${pct(now)}%` }} title={t.now} />
        <span className="timeline__forecast" style={{ left: `${pct(now)}%` }}>
          {t.forecast}
        </span>
        <div className="timeline__fill" style={{ width: `${pct(time)}%` }} />
        <input
          type="range"
          min={range.start}
          max={range.end}
          step={60}
          value={time}
          aria-label={t.sceneTime}
          onChange={(e) => useStore.setState({ live: false, speed: 0, time: Number(e.target.value) })}
        />
      </div>
    </section>
  )
}
