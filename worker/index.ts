// The weather the app shows, fetched once for every visitor: Open-Meteo's model fields, cached at
// the edge for half an hour so visitors no longer spend their own Open-Meteo quota. The app falls
// back to Open-Meteo directly, then to its bundled snapshot, when this is out of reach.

import { fetchOpenMeteo } from '../src/data/openMeteo'

/** Open-Meteo refreshes hourly; half an hour keeps the shown hour current. */
const TTL_S = 30 * 60

const CORS = { 'access-control-allow-origin': '*' }

export default {
  async fetch(request: Request, _env: unknown, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    if (request.method !== 'GET' || url.pathname !== '/weather') return new Response('Not found', { status: 404, headers: CORS })

    const cache = caches.default
    const key = new Request(`${url.origin}/weather`)
    const cached = await cache.match(key)
    if (cached) return cached

    let body: string
    try {
      body = JSON.stringify(await fetchOpenMeteo())
    } catch (error) {
      return new Response(`Open-Meteo unavailable: ${error}`, { status: 502, headers: CORS })
    }
    const response = new Response(body, {
      headers: { ...CORS, 'content-type': 'application/json', 'cache-control': `public, max-age=${TTL_S}` },
    })
    ctx.waitUntil(cache.put(key, response.clone()))
    return response
  },
} satisfies ExportedHandler
