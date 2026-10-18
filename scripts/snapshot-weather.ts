// Writes public/data/weather-snapshot.json: the raw Open-Meteo responses the app fetches live,
// reaching a week ahead. Hosts that block requests to Open-Meteo (a claude.ai artifact) fall back
// to it, labelled as a snapshot. Run before each such deploy.
//
// The request code is the app's own, loaded through Vite so its extensionless imports resolve.

import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'vite'

const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error' })
try {
  const { fetchOpenMeteo, SNAPSHOT_RANGE } = (await vite.ssrLoadModule('/src/data/weather.ts')) as typeof import('../src/data/weather')
  const snapshot = await fetchOpenMeteo(SNAPSHOT_RANGE)
  await mkdir('public/data', { recursive: true })
  await writeFile('public/data/weather-snapshot.json', JSON.stringify(snapshot))
  const hours = snapshot.marine[0].hourly.time
  const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 13)
  console.log(`wrote public/data/weather-snapshot.json: ${day(hours[0])} .. ${day(hours[hours.length - 1])} UTC`)
} finally {
  await vite.close()
}
