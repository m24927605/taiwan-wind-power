import { useEffect, useState } from 'react'

import { MESSAGES, type Lang } from '../i18n'

const TZ = 'Asia/Taipei'

const formats = new Map<string, Intl.DateTimeFormat>()
function format(lang: Lang, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = lang + JSON.stringify(options)
  let f = formats.get(key)
  if (!f) formats.set(key, (f = new Intl.DateTimeFormat(MESSAGES[lang].locale, { timeZone: TZ, ...options })))
  return f
}

export const formatDate = (t: number, lang: Lang) => format(lang, { month: 'numeric', day: 'numeric', weekday: 'short' }).format(t * 1000)
export const formatDay = (t: number, lang: Lang) => format(lang, { month: 'numeric', day: 'numeric' }).format(t * 1000)
export const formatWeekday = (t: number, lang: Lang) => format(lang, { weekday: 'short' }).format(t * 1000)
export const formatTime = (t: number, lang: Lang) => format(lang, { hour: '2-digit', minute: '2-digit', hour12: false }).format(t * 1000)
export const taipeiHour = (t: number) => Number(format('en', { hour: '2-digit', hour12: false }).format(t * 1000)) % 24

export const formatNumber = (v: number, digits = 0) =>
  v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })

const wrap = (deg: number) => ((deg % 360) + 360) % 360
export const compass8 = (deg: number, lang: Lang) => MESSAGES[lang].compass8[Math.round(wrap(deg) / 45) % 8]
export const compass16 = (deg: number, lang: Lang) => MESSAGES[lang].compass16[Math.round(wrap(deg) / 22.5) % 16]

/** Re-render the caller on an interval, for panels that read per-frame simulation state. */
export function useTicker(ms: number) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), ms)
    return () => clearInterval(id)
  }, [ms])
}
