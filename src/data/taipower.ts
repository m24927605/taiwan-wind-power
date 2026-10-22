// What the wind farms actually deliver: Taipower's open data on the net output of every
// generating unit (data.gov.tw dataset 8931, updated every ten minutes, Open Government Data
// License). It sends no CORS headers, so the weather service (worker/) fetches it.

const UNITS = 'https://service.taipower.com.tw/data/opendata/apply/file/d006001/001.json'

export interface Generation {
  /** When Taipower took the readings, unix seconds. */
  at: number
  /** Net output of each wind unit, MW, by its name in the dataset. */
  units: Record<string, number>
}

interface Units {
  /** Taiwan time, without an offset. */
  DateTime: string
  aaData: Record<string, string>[]
}

/** The wind units' net output. */
export async function fetchGeneration(): Promise<Generation> {
  const res = await fetch(UNITS)
  if (!res.ok) throw new Error(`Taipower: HTTP ${res.status}`)
  // The file starts with a byte-order mark, which JSON.parse rejects.
  const data = JSON.parse((await res.text()).replace(/^﻿/, '')) as Units
  const units: Record<string, number> = {}
  for (const row of data.aaData) {
    if (row['機組類型'] !== '風力') continue
    // Footnote marks such as "(註10)" come and go as units enter service.
    const name = row['機組名稱'].replace(/\(註\d+\)/g, '').trim()
    const mw = Number(row['淨發電量(MW)'])
    if (Number.isFinite(mw)) units[name] = mw
  }
  return { at: Date.parse(`${data.DateTime}+08:00`) / 1000, units }
}
