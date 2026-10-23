// The weather the app shows: Open-Meteo's model fields; CWA's buoys (wave height and wind), tide
// gauges (sea level) and tropical cyclones; and Taipower's output from the wind farms. All are
// fetched on a schedule and kept in KV, so every visitor is served the same stored copy. Visitors
// never reach the sources themselves, the number of upstream calls is fixed whatever the traffic
// (24 Open-Meteo requests a day, inside its free daily limit), and the CWA key stays here. A
// failed fetch leaves the last good copy in place. The app falls back to Open-Meteo directly,
// then to its bundled snapshot, only when this is out of reach.
//
// A Worker gets a few milliseconds of CPU per run, and even decoding the 1.7 MB of Open-Meteo JSON
// to a string uses them up, so the model is stored and served as the bytes Open-Meteo sent: joined,
// never decoded or parsed.

import { fetchBuoys, fetchCyclones, fetchStations, fetchTides, type Buoy, type Stations } from '../src/data/cwa'
import { openMeteoUrls, windBuoys } from '../src/data/openMeteo'
import { fetchGeneration } from '../src/data/taipower'

interface Env {
  CWA_API_KEY: string
  WEATHER: KVNamespace
}

/** The model's JSON object without its closing brace, so the buoys can follow as one more field. */
const MODEL_KEY = 'model-head'
const STATIONS_KEY = 'stations'
const BUOYS_KEY = 'buoys'
const TIDES_KEY = 'tides'
const GENERATION_KEY = 'generation'
const CYCLONES_KEY = 'cyclones'
/** Browsers may reuse a response this long, s; the app refreshes every ten minutes. */
const BROWSER_TTL_S = 60

const CORS = { 'access-control-allow-origin': '*' }

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  // Uncompressed: inflating 1.7 MB of gzip would cost more CPU than the rest of the run.
  const res = await fetch(url, { headers: { 'accept-encoding': 'identity' } })
  if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status}`)
  const bytes = await res.arrayBuffer()
  // Open-Meteo can fail after sending 200, writing an error message in place of the data, so the
  // body must at least open and close as JSON. Parsing it all would cost too much CPU.
  const view = new Uint8Array(bytes)
  const first = String.fromCharCode(view[0])
  const last = String.fromCharCode(view[view.length - 1])
  if (!'[{'.includes(first) || !']}'.includes(last)) throw new Error(`${new URL(url).host}: incomplete response`)
  return bytes
}

async function refreshStations(env: Env): Promise<Stations> {
  const stations = await fetchStations(env.CWA_API_KEY)
  await env.WEATHER.put(STATIONS_KEY, JSON.stringify(stations))
  return stations
}

async function stations(env: Env): Promise<Stations> {
  return (await env.WEATHER.get<Stations>(STATIONS_KEY, 'json')) ?? refreshStations(env)
}

/** The OpenMeteo shape (src/data/openMeteo.ts), assembled from the responses as sent. */
async function refreshModel(env: Env): Promise<ArrayBuffer> {
  const at = Date.now()
  // The buoys that last reported wind; none until they first have.
  const buoys = windBuoys((await env.WEATHER.get<Buoy[]>(BUOYS_KEY, 'json')) ?? [])
  const urls = openMeteoUrls(undefined, buoys)
  const [marine, wind] = await Promise.all([fetchBytes(urls.marine), fetchBytes(urls.wind)])
  const ids = JSON.stringify(buoys.map((b) => b.id))
  const head = await new Blob([`{"at":${at},"windBuoys":${ids},"marine":`, marine, ',"wind":', wind]).arrayBuffer()
  await env.WEATHER.put(MODEL_KEY, head)
  return head
}

async function refreshBuoys(env: Env): Promise<string> {
  const buoys = JSON.stringify(await fetchBuoys(env.CWA_API_KEY, (await stations(env)).buoys))
  await env.WEATHER.put(BUOYS_KEY, buoys)
  return buoys
}

async function refreshTides(env: Env): Promise<string> {
  const tides = JSON.stringify(await fetchTides(env.CWA_API_KEY, (await stations(env)).tideGauges))
  await env.WEATHER.put(TIDES_KEY, tides)
  return tides
}

async function refreshCyclones(env: Env): Promise<string> {
  const cyclones = JSON.stringify(await fetchCyclones(env.CWA_API_KEY))
  await env.WEATHER.put(CYCLONES_KEY, cyclones)
  return cyclones
}

async function refreshGeneration(env: Env): Promise<string> {
  const generation = JSON.stringify(await fetchGeneration())
  await env.WEATHER.put(GENERATION_KEY, generation)
  return generation
}

export default {
  // One run every ten minutes, each doing one share of the work so none outgrows the CPU budget:
  // the hourly data in the first ten minutes of the hour (Open-Meteo updates hourly), then the
  // buoys, and the tide gauges with the cyclones, in turn (CWA's measurements arrive hourly, half
  // an hour late), each beside Taipower's output, which changes every ten minutes.
  async scheduled(controller, env, ctx) {
    const slot = Math.floor(new Date(controller.scheduledTime).getUTCMinutes() / 10)
    if (slot === 0) {
      ctx.waitUntil(refreshModel(env))
      ctx.waitUntil(refreshStations(env))
      return
    }
    ctx.waitUntil(refreshGeneration(env))
    if (slot % 2 === 1) {
      ctx.waitUntil(refreshBuoys(env))
    } else {
      ctx.waitUntil(refreshTides(env))
      ctx.waitUntil(refreshCyclones(env))
    }
  },

  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url)
    if (request.method !== 'GET' || url.pathname !== '/weather') return new Response('Not found', { status: 404, headers: CORS })

    let [model, buoys, tides, cyclones, generation] = await Promise.all([
      env.WEATHER.get(MODEL_KEY, 'arrayBuffer'),
      env.WEATHER.get(BUOYS_KEY),
      env.WEATHER.get(TIDES_KEY),
      env.WEATHER.get(CYCLONES_KEY),
      env.WEATHER.get(GENERATION_KEY),
    ])
    // Until the schedule has filled the store (a new namespace), fetch here once, the buoys first
    // so the model knows where they measure wind.
    if (buoys === null) buoys = await refreshBuoys(env).catch(() => null)
    if (tides === null) tides = await refreshTides(env).catch(() => null)
    if (cyclones === null) cyclones = await refreshCyclones(env).catch(() => null)
    if (generation === null) generation = await refreshGeneration(env).catch(() => null)
    if (model === null) {
      try {
        model = await refreshModel(env)
      } catch (error) {
        return new Response(`Open-Meteo unavailable: ${error}`, { status: 502, headers: CORS })
      }
    }
    const parts: (ArrayBuffer | string)[] = [model]
    if (buoys !== null) parts.push(',"buoys":', buoys)
    if (tides !== null) parts.push(',"tides":', tides)
    if (cyclones !== null) parts.push(',"cyclones":', cyclones)
    if (generation !== null) parts.push(',"generation":', generation)
    parts.push('}')
    const body = new Blob(parts)
    return new Response(body, {
      headers: { ...CORS, 'content-type': 'application/json', 'cache-control': `public, max-age=${BROWSER_TTL_S}` },
    })
  },
} satisfies ExportedHandler<Env>
