import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchGeneration } from './taipower'

// Rows as Taipower writes them: a byte-order mark, footnote marks on units still in trial, a
// subtotal row and other kinds of plant.
const SAMPLE =
  '﻿' +
  JSON.stringify({
    DateTime: '2026-10-22T21:40:00',
    aaData: [
      { 機組類型: '燃氣', 機組名稱: '大潭CC#1', '淨發電量(MW)': '683.2' },
      { 機組類型: '風力', 機組名稱: '海能風', '淨發電量(MW)': '360.6' },
      { 機組類型: '風力', 機組名稱: '龍A風(註10)', '淨發電量(MW)': '0.0' },
      { 機組類型: '風力', 機組名稱: '小計(註5)', '淨發電量(MW)': '990.8(3.292%)' },
    ],
  })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchGeneration', () => {
  it('reads the wind units by name, in Taiwan time', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(SAMPLE)))
    const generation = await fetchGeneration()
    expect(generation.units).toEqual({ 海能風: 360.6, 龍A風: 0 })
    expect(generation.at).toBe(Date.parse('2026-10-22T13:40:00Z') / 1000)
  })

  it('fails on an error status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })))
    await expect(fetchGeneration()).rejects.toThrow('HTTP 503')
  })
})
