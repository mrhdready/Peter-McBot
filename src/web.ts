import { createServer, type ServerResponse } from 'node:http'
import type { BotController, Command } from './bot.js'
import { WorldError, dimensionId } from './world.js'
import { MapArchive } from './map-archive.js'
// Code generated/edited by Claude Opus 5.5
import { POI_ICONS, type PlaceStore } from './places.js'
import { mapPerformancePanel, mapRuntimeMetrics } from './map-performance.js'
// Code generated/edited by Claude Opus 5.5
import { readFileSync } from 'node:fs'
import path from 'node:path'

// Code generated/edited by Claude Opus 5.5: optional place store (POIs, navigation history); its revision rides along in SSE.
export function createWebServer (bot: BotController, archive?: MapArchive, places?: PlaceStore) {
  const streams = new Set<ServerResponse>()
  let mapClients = 0
  let metrics: ReturnType<typeof mapRuntimeMetrics> | null = null
  let metricsAt = 0
  const snapshot = () => JSON.stringify(places ? { ...bot.state.snapshot(), placesRevision: places.revision } : bot.state.snapshot())
  const broadcast = () => {
    const data = `data: ${snapshot()}\n\n`
    for (const response of streams) {
      if (response.writableLength > 65536) response.destroy()
      else response.write(data)
    }
  }
  const server = createServer((request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Cache-Control', 'no-store')
    const reply = (code: number, body: unknown) => {
      if (response.destroyed || response.writableEnded) return
      response.writeHead(code, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    if (request.method === 'GET' && request.url === '/api/map-performance') {
      if (!metrics || Date.now() - metricsAt > 250) { metricsAt = Date.now(); metrics = mapRuntimeMetrics() }
      void metrics.then(result => reply(200, result)).catch(() => reply(500, { error: 'Runtime metrics unavailable' }))
    } else if (request.method === 'GET' && ['/api/map/tiles', '/api/map/tile'].includes(request.url?.split('?')[0] || '')) {
      if (!archive) return reply(404, { error: 'Map archive is unavailable' })
      if (request.url!.length > 512) return reply(400, { error: 'Query is too long' })
      const query = new URL(request.url!, 'http://localhost').searchParams
      const x = Number(query.get('x')); const z = Number(query.get('z')); const dimension = Number(query.get('dimension'))
      const tileRequest = request.url!.split('?')[0] === '/api/map/tile'
      const width = tileRequest ? 1 : Number(query.get('width')); const height = tileRequest ? 1 : Number(query.get('height'))
      if (!['x', 'z', 'dimension'].every(key => query.has(key) && query.get(key)!.trim()) || ![0, 1, 2].includes(dimension) ||
        ![x, z].every(n => Number.isInteger(n) && Math.abs(n) <= 1875000) ||
        ![width, height].every(n => Number.isInteger(n) && n >= 1 && n <= 8) || Math.abs(x + width - 1) > 1875000 || Math.abs(z + height - 1) > 1875000) return reply(400, { error: 'Invalid map viewport (maximum 8 by 8 tiles)' })
      if (mapClients >= 4) return reply(429, { error: 'Too many map requests' })
      mapClients++
      const session = bot.state.worldSession
      void (async () => {
        const tiles = []
        for (let dz = 0; dz < height; dz++) for (let dx = 0; dx < width; dx++) {
          if (response.destroyed) return
          const tile = await archive.tile(dimension, x + dx, z + dz, bot.state.surfaceObservation(x + dx, z + dz, dimension))
          if (session !== bot.state.worldSession) throw new WorldError('World changed; reload map', 409)
          if (tileRequest) {
            const etag = '"' + tile.hash + '"'
            response.setHeader('ETag', etag)
            if (request.headers['if-none-match'] === etag) { response.writeHead(304); response.end(); return }
            return reply(200, { ...tile, session })
          }
          tiles.push({ x: tile.x, z: tile.z, hash: tile.hash, empty: !tile.cells.some(Boolean) })
        }
        reply(200, { session, dimension, tiles, error: archive.error })
      })().catch(error => reply(error instanceof WorldError ? error.status : 500, { error: error instanceof WorldError ? error.message : 'Map archive failed' }))
        .finally(() => { mapClients-- })
    } else if (request.method === 'GET' && request.url?.split('?')[0] === '/api/blocks') {
      if (request.url.length > 512) return reply(400, { error: 'Query is too long' })
      const query = new URL(request.url, 'http://localhost').searchParams
      const abort = new AbortController()
      response.once('close', () => abort.abort())
      void bot.searchBlocks(query.get('block') || '', Number(query.get('limit') || 50), abort.signal)
        .then(result => reply(200, result))
        .catch(error => reply(error instanceof WorldError ? error.status : 500, { error: error instanceof WorldError ? error.message : 'Search failed' }))
    } else if (request.method === 'GET' && request.url === '/api/map') {
      const abort = new AbortController()
      response.once('close', () => abort.abort())
      void bot.state.surfaceMap(abort.signal)
        .then(result => reply(200, result))
        .catch(error => reply(error instanceof WorldError ? error.status : 500, { error: error instanceof WorldError ? error.message : 'Map failed' }))
    } else if (request.method === 'GET' && ['/', '/?measure=1'].includes(request.url || '')) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" })
      // Code generated/edited by Claude Opus 5.5
      const content = page.replace('const archiveEnabled = false;', `const archiveEnabled = ${Boolean(archive)};`)
        .replace('const placesEnabled = false;', `const placesEnabled = ${Boolean(places)};`)
      response.end(request.url === '/?measure=1' ? content.replace('</html>', mapPerformancePanel + '</html>') : content)
    } else if (request.method === 'GET' && request.url === '/api/status') {
      reply(200, bot.state.snapshot())
    } else if (request.method === 'GET' && request.url === '/api/block-ids') {
      reply(200, { blockIds: bot.state.blockIds() })
    } else if (request.method === 'GET' && request.url === '/healthz') {
      reply(200, { process: 'ok' })
    } else if (request.method === 'GET' && request.url === '/api/events') {
      if (streams.size >= 10) return reply(503, { error: 'Too many event clients' })
      response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
      streams.add(response)
      response.write(`data: ${snapshot()}\n\n`)
      response.on('close', () => streams.delete(response))
    // Code generated/edited by Claude Opus 5.5: saved places and navigation history of one dimension.
    } else if (request.method === 'GET' && request.url?.split('?')[0] === '/api/pois') {
      if (!places) return reply(404, { error: 'Places are unavailable' })
      if (request.url.length > 128) return reply(400, { error: 'Query is too long' })
      const dimension = Number(new URL(request.url, 'http://localhost').searchParams.get('dimension') || NaN)
      void places.list(dimension).then(result => reply(200, { dimension, icons: POI_ICONS, revision: places.revision, ...result }))
        .catch(error => reply(error instanceof WorldError ? error.status : 500, { error: error instanceof WorldError ? error.message : 'Places failed' }))
    } else if (request.method === 'POST' && ['/api/pois', '/api/pois/delete'].includes(request.url || '')) {
      if (!places) return reply(404, { error: 'Places are unavailable' })
      if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}` && request.headers.origin !== `https://${request.headers.host}`) return reply(403, { error: 'Foreign origin rejected' })
      if (request.headers['content-type'] !== 'application/json') return reply(415, { error: 'Use application/json' })
      const limit = 512
      if (Number(request.headers['content-length'] || 0) > limit) { request.resume(); return reply(413, { error: `Body exceeds ${limit} bytes` }) }
      const chunks: Buffer[] = []; let bytes = 0; let rejected = false
      request.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > limit) { rejected = true; chunks.length = 0; reply(413, { error: `Body exceeds ${limit} bytes` }) }
        else if (!rejected) chunks.push(chunk)
      })
      request.on('end', () => {
        if (rejected) return
        let body: Record<string, unknown>
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return reply(400, { error: 'Invalid JSON' }) }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(400, { error: 'Provide a JSON object' })
        const work: Promise<{ code: number; body: unknown }> = request.url === '/api/pois'
          ? places.add({ name: body.name, icon: body.icon, x: body.x, z: body.z, dimension: body.dimension }).then(poi => ({ code: 201, body: { poi } }))
          : places.remove(body.id).then(() => ({ code: 200, body: { deleted: body.id } }))
        void work.then(result => { reply(result.code, result.body); broadcast() })
          .catch(error => reply(error instanceof WorldError ? error.status : 500, { error: error instanceof WorldError ? error.message : 'Places failed' }))
      })
      request.on('error', () => reply(400, { error: 'Incomplete request' }))
    } else if (request.method === 'POST' && ['/api/connect', '/api/disconnect', '/api/navigate', '/api/preview', '/api/stop_navigation'].includes(request.url || '')) {
      if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}` && request.headers.origin !== `https://${request.headers.host}`) return reply(403, { error: 'Foreign origin rejected' })
      if (request.headers['content-type'] !== 'application/json') return reply(415, { error: 'Use application/json' })
      if (request.url === '/api/navigate' || request.url === '/api/preview') {
        if (Number(request.headers['content-length'] || 0) > 128) { request.resume(); return reply(413, { error: 'Body exceeds 128 bytes' }) }
        const chunks: Buffer[] = []; let bytes = 0; let rejected = false
        request.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > 128) { rejected = true; chunks.length = 0; reply(413, { error: 'Body exceeds 128 bytes' }) }
          else if (!rejected) chunks.push(chunk)
        })
        request.on('end', () => {
          if (rejected) return
          try {
            const target = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            if (!target || typeof target !== 'object' || Array.isArray(target) || Object.keys(target).sort().join(',') !== 'x,z' || ![target.x, target.z].every(n => Number.isInteger(n) && Math.abs(n) <= 30000000)) return reply(400, { error: 'Provide integer x and z only (-30000000..30000000)' })
            if (request.url === '/api/preview') {
              const abort = new AbortController()
              response.once('close', () => abort.abort())
              void bot.previewRoute(target, abort.signal).then(result => reply(200, result))
                .catch(error => reply(error instanceof WorldError ? error.status : 500, { error: error instanceof Error ? error.message : 'Preview failed' }))
              return
            }
            if (bot.state.status !== 'spawned') return reply(409, { error: 'Bot must be spawned before navigation' })
            // Code generated/edited by Claude Opus 5.5: every accepted navigation target enters the history.
            const accepted = bot.enqueue({ type: 'navigate', x: target.x, z: target.z })
            const dimension = dimensionId(bot.state.dimension)
            if (accepted && places && dimension !== null) {
              void places.recordNavigation(dimension, target.x, target.z).then(broadcast).catch(error => console.error('Places:', error))
            }
            reply(accepted ? 202 : 503, { command: 'navigate', target })
          } catch { reply(400, { error: 'Invalid JSON target' }) }
        })
        request.on('error', () => reply(400, { error: 'Incomplete target request' }))
        return
      }
      // These commands accept no payload, avoiding an unbounded body buffer.
      if (request.headers['transfer-encoding'] || Number(request.headers['content-length'] || 0) !== 0) return reply(400, { error: 'Commands accept no body' })
      const command = request.url!.slice('/api/'.length) as Command
      reply(bot.enqueue(command) ? 202 : 503, { command })
    } else reply(404, { error: 'Not found' })
  })
  server.requestTimeout = 10000
  server.headersTimeout = 10000
  return {
    server, broadcast,
    close: () => {
      for (const response of streams) response.end()
      streams.clear()
      server.close()
      server.closeIdleConnections()
    }
  }
}


/*
 * Code generated/edited by Claude Opus 5.5
 * The UI lives in src/ui/ (copied to dist/ui/ by `pnpm build`) and is read once at startup.
 * Style and script stay inline: the CSP allows only inline code, and tests extract the first <script> block.
 * Function replacements avoid `$` patterns in the script being interpreted by String.replace.
 */
const ui = (name: string) => readFileSync(path.join(__dirname, 'ui', name), 'utf8')
const page = ui('index.html')
  .replace('<!-- ui:style -->', () => `<style>${ui('style.css')}</style>`)
  .replace('<!-- ui:script -->', () => `<script>${ui('app.js')}</script>`)
