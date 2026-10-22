// The weather the app shows: Open-Meteo's model fields and the CWA buoys' wave heights, fetched on
// a schedule and kept in KV, so every visitor is served the same stored copy. Visitors never reach
// Open-Meteo or CWA themselves, the number of upstream calls is fixed whatever the traffic (24
// Open-Meteo requests a day, inside its free daily limit), and the CWA key stays here. A failed
// fetch leaves the last good copy in place. The app falls back to Open-Meteo directly, then to its
// bundled snapshot, only when this is out of reach.

import { fetchBuoys } from '../src/data/cwa'
import { fetchOpenMeteo } from '../src/data/openMeteo'

interface Env {
  CWA_API_KEY: string
  WEATHER: KVNamespace
}

/** Must match the model's cron in wrangler.jsonc; the other one refreshes the buoys. */
const MODEL_CRON = '5 * * * *'
const MODEL_KEY = 'model'
const BUOYS_KEY = 'buoys'
/** Browsers may reuse a response this long, s; the app refreshes every ten minutes. */
const BROWSER_TTL_S = 60

const CORS = { 'access-control-allow-origin': '*' }

async function refreshModel(env: Env): Promise<string> {
  const model = JSON.stringify(await fetchOpenMeteo())
  await env.WEATHER.put(MODEL_KEY, model)
  return model
}

async function refreshBuoys(env: Env): Promise<string> {
  const buoys = JSON.stringify(await fetchBuoys(env.CWA_API_KEY))
  await env.WEATHER.put(BUOYS_KEY, buoys)
  return buoys
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(controller.cron === MODEL_CRON ? refreshModel(env) : refreshBuoys(env))
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
    // The stored model is a JSON object; the buoys join it as one more field, without re-parsing
    // its 1.7 MB.
    const body = buoys === null ? model : `${model.slice(0, -1)},"buoys":${buoys}}`
    return new Response(body, {
      headers: { ...CORS, 'content-type': 'application/json', 'cache-control': `public, max-age=${BROWSER_TTL_S}` },
    })
  },
} satisfies ExportedHandler<Env>
