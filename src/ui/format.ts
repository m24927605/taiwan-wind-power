import { useEffect, useState } from 'react'

const TZ = 'Asia/Taipei'

const dateFmt = new Intl.DateTimeFormat('zh-TW', { timeZone: TZ, month: 'numeric', day: 'numeric', weekday: 'short' })
const dayFmt = new Intl.DateTimeFormat('zh-TW', { timeZone: TZ, month: 'numeric', day: 'numeric' })
const weekdayFmt = new Intl.DateTimeFormat('zh-TW', { timeZone: TZ, weekday: 'short' })
const timeFmt = new Intl.DateTimeFormat('zh-TW', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false })
const hourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false })

export const formatDate = (t: number) => dateFmt.format(t * 1000)
export const formatDay = (t: number) => dayFmt.format(t * 1000)
export const formatWeekday = (t: number) => weekdayFmt.format(t * 1000)
export const formatTime = (t: number) => timeFmt.format(t * 1000)
export const taipeiHour = (t: number) => Number(hourFmt.format(t * 1000)) % 24

export const formatNumber = (v: number, digits = 0) =>
  v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })

const COMPASS = ['北', '東北', '東', '東南', '南', '西南', '西', '西北']
export const compass8 = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8]

/** Re-render the caller on an interval, for panels that read per-frame simulation state. */
export function useTicker(ms: number) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), ms)
    return () => clearInterval(id)
  }, [ms])
}
