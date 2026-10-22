// The weather the app shows: Open-Meteo's model fields and the CWA buoys' wave heights, fetched on
// a schedule and kept in KV, so every visitor is served the same stored copy. Visitors never reach
// Open-Meteo or CWA themselves, the number of upstream calls is fixed whatever the traffic (24
// Open-Meteo requests a day, inside its free daily limit), and the CWA key stays here. A failed
// fetch leaves the last good copy in place. The app falls back to Open-Meteo directly, then to its
// bundled snapshot, only when this is out of reach.
//
// A Worker gets a few milliseconds of CPU per run, and parsing the 1.7 MB of Open-Meteo JSON alone
// can use them up, so the model is stored and served as the text Open-Meteo sent, never parsed.

import { fetchBuoyStations, fetchBuoys, type BuoyStation } from '../src/data/cwa'
import { openMeteoUrls } from '../src/data/openMeteo'

interface Env {
  CWA_API_KEY: string
  WEATHER: KVNamespace
}

/** Must match the hourly cron in wrangler.jsonc; the other one refreshes the buoys. */
const HOURLY_CRON = '5 * * * *'
const MODEL_KEY = 'model'
const STATIONS_KEY = 'stations'
const BUOYS_KEY = 'buoys'
/** Browsers may reuse a response this long, s; the app refreshes every ten minutes. */
const BROWSER_TTL_S = 60

const CORS = { 'access-control-allow-origin': '*' }

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status}`)
  return res.text()
}

/** The OpenMeteo shape (src/data/openMeteo.ts), assembled from the responses as sent. */
async function refreshModel(env: Env): Promise<string> {
  const at = Date.now()
  const urls = openMeteoUrls()
  const [marine, wind] = await Promise.all([fetchText(urls.marine), fetchText(urls.wind)])
  const model = `{"at":${at},"marine":${marine},"wind":${wind}}`
  await env.WEATHER.put(MODEL_KEY, model)
  return model
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
    if (controller.cron === HOURLY_CRON) {
      ctx.waitUntil(refreshModel(env))
      ctx.waitUntil(refreshStations(env))
    } else {
      ctx.waitUntil(refreshBuoys(env))
    }
  },

  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url)
    if (request.method !== 'GET' || url.pathname !== '/weather') return new Response('Not found', { status: 404, headers: CORS })

    let [model, buoys] = await Promise.all([env.WEATHER.get(MODEL_KEY), env.WEATHER.get(BUOYS_KEY)])
    // Until the schedule has filled the store (a new namespace), fetch here once.
    if (model === null) {
      try {
        model = await refreshModel(env)
      } catch (error) {
        return new Response(`Open-Meteo unavailable: ${error}`, { status: 502, headers: CORS })
      }
    }
    if (buoys === null) buoys = await refreshBuoys(env).catch(() => null)
    // The buoys join the stored model as one more field.
    const body = buoys === null ? model : `${model.slice(0, -1)},"buoys":${buoys}}`
    return new Response(body, {
      headers: { ...CORS, 'content-type': 'application/json', 'cache-control': `public, max-age=${BROWSER_TTL_S}` },
    })
  },
} satisfies ExportedHandler<Env>
