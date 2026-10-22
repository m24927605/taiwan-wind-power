// The weather the app shows: Open-Meteo's model fields and the CWA buoys' wave heights, fetched on
// a schedule and kept in KV, so every visitor is served the same stored copy. Visitors never reach
// Open-Meteo or CWA themselves, the number of upstream calls is fixed whatever the traffic (24
// Open-Meteo requests a day, inside its free daily limit), and the CWA key stays here. A failed
// fetch leaves the last good copy in place. The app falls back to Open-Meteo directly, then to its
// bundled snapshot, only when this is out of reach.
//
// A Worker gets a few milliseconds of CPU per run, and even decoding the 1.7 MB of Open-Meteo JSON
// to a string uses them up, so the model is stored and served as the bytes Open-Meteo sent: joined,
// never decoded or parsed.

import { fetchBuoyStations, fetchBuoys, type BuoyStation } from '../src/data/cwa'
import { openMeteoUrls } from '../src/data/openMeteo'

interface Env {
  CWA_API_KEY: string
  WEATHER: KVNamespace
}

/** The model's JSON object without its closing brace, so the buoys can follow as one more field. */
const MODEL_KEY = 'model-head'
const STATIONS_KEY = 'stations'
const BUOYS_KEY = 'buoys'
/** Browsers may reuse a response this long, s; the app refreshes every ten minutes. */
const BROWSER_TTL_S = 60

const CORS = { 'access-control-allow-origin': '*' }

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status}`)
  return res.arrayBuffer()
}

/** The OpenMeteo shape (src/data/openMeteo.ts), assembled from the responses as sent. */
async function refreshModel(env: Env): Promise<ArrayBuffer> {
  const at = Date.now()
  const urls = openMeteoUrls()
  const [marine, wind] = await Promise.all([fetchBytes(urls.marine), fetchBytes(urls.wind)])
  const head = await new Blob([`{"at":${at},"marine":`, marine, ',"wind":', wind]).arrayBuffer()
  await env.WEATHER.put(MODEL_KEY, head)
  return head
}

async function refreshStations(env: Env): Promise<BuoyStation[]> {
  const stations = await fetchBuoyStations(env.CWA_API_KEY)
  await env.WEATHER.put(STATIONS_KEY, JSON.stringify(stations))
  return stations
}

async function refreshBuoys(env: Env): Promise<string> {
  const stations = (await env.WEATHER.get<BuoyStation[]>(STATIONS_KEY, 'json')) ?? (await refreshStations(env))
  const buoys = JSON.stringify(await fetchBuoys(env.CWA_API_KEY, stations))
  await env.WEATHER.put(BUOYS_KEY, buoys)
  return buoys
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(refreshBuoys(env))
    // The run in the first ten minutes of each hour also refreshes the hourly data.
    if (new Date(controller.scheduledTime).getUTCMinutes() < 10) {
      ctx.waitUntil(refreshModel(env))
      ctx.waitUntil(refreshStations(env))
    }
  },

  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url)
    if (request.method !== 'GET' || url.pathname !== '/weather') return new Response('Not found', { status: 404, headers: CORS })

    let [model, buoys] = await Promise.all([env.WEATHER.get(MODEL_KEY, 'arrayBuffer'), env.WEATHER.get(BUOYS_KEY)])
    // Until the schedule has filled the store (a new namespace), fetch here once.
    if (model === null) {
      try {
        model = await refreshModel(env)
      } catch (error) {
        return new Response(`Open-Meteo unavailable: ${error}`, { status: 502, headers: CORS })
      }
    }
    if (buoys === null) buoys = await refreshBuoys(env).catch(() => null)
    const body = new Blob(buoys === null ? [model, '}'] : [model, ',"buoys":', buoys, '}'])
    return new Response(body, {
      headers: { ...CORS, 'content-type': 'application/json', 'cache-control': `public, max-age=${BROWSER_TTL_S}` },
    })
  },
} satisfies ExportedHandler<Env>
