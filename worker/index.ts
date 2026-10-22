// The weather the app shows, fetched once for every visitor: Open-Meteo's model fields and the CWA
// buoys' wave heights, cached at the edge for half an hour so visitors no longer spend their own
// Open-Meteo quota and the CWA key stays here. The app falls back to Open-Meteo directly, then to
// its bundled snapshot, when this is out of reach.

import { fetchBuoys, type WeatherPayload } from '../src/data/cwa'
import { fetchOpenMeteo } from '../src/data/openMeteo'

interface Env {
  CWA_API_KEY: string
  CF_VERSION_METADATA: WorkerVersionMetadata
}

/** Open-Meteo refreshes hourly and the buoys report hourly; half an hour keeps the shown hour current. */
const TTL_S = 30 * 60
/** Without the buoys the model still serves, but CWA is asked again soon. */
const TTL_WITHOUT_BUOYS_S = 5 * 60

const CORS = { 'access-control-allow-origin': '*' }

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url)
    if (request.method !== 'GET' || url.pathname !== '/weather') return new Response('Not found', { status: 404, headers: CORS })

    const cache = caches.default
    // Keyed by deployment, so a new version never serves what an older one cached.
    const key = new Request(`${url.origin}/weather?version=${env.CF_VERSION_METADATA.id}`)
    const cached = await cache.match(key)
    if (cached) return cached

    const [openMeteo, buoys] = await Promise.allSettled([fetchOpenMeteo(), fetchBuoys(env.CWA_API_KEY)])
    if (openMeteo.status === 'rejected') return new Response(`Open-Meteo unavailable: ${openMeteo.reason}`, { status: 502, headers: CORS })
    if (buoys.status === 'rejected') console.error('CWA buoys unavailable:', String(buoys.reason))
    const payload: WeatherPayload = { ...openMeteo.value, buoys: buoys.status === 'fulfilled' ? buoys.value : undefined }
    const ttl = payload.buoys ? TTL_S : TTL_WITHOUT_BUOYS_S
    const response = new Response(JSON.stringify(payload), {
      headers: { ...CORS, 'content-type': 'application/json', 'cache-control': `public, max-age=${ttl}` },
    })
    ctx.waitUntil(cache.put(key, response.clone()))
    return response
  },
} satisfies ExportedHandler<Env>
