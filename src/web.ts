import { createServer, type ServerResponse } from 'node:http'
import type { BotController, Command } from './bot.js'
import { WorldError } from './world.js'
import { MapArchive } from './map-archive.js'
import { mapPerformancePanel, mapRuntimeMetrics } from './map-performance.js'

export function createWebServer (bot: BotController, archive?: MapArchive) {
  const streams = new Set<ServerResponse>()
  let mapClients = 0
  let metrics: ReturnType<typeof mapRuntimeMetrics> | null = null
  let metricsAt = 0
  const snapshot = () => JSON.stringify(bot.state.snapshot())
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
      const content = page.replace('const archiveEnabled = false;', `const archiveEnabled = ${Boolean(archive)};`)
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
            reply(bot.enqueue({ type: 'navigate', x: target.x, z: target.z }) ? 202 : 503, { command: 'navigate', target })
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

const page = `<!doctype html>
<html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>MC Bot</title>
<style>body{font:16px system-ui;max-width:52rem;margin:3rem auto;padding:0 1rem;background:#111827;color:#f3f4f6}button,input{font:inherit;padding:.7rem;margin:.3rem .3rem .3rem 0}input{max-width:100%;box-sizing:border-box}button{cursor:pointer}dt{font-weight:bold;margin-top:1rem}dd{margin:.3rem 0;overflow-wrap:anywhere}#error{color:#fca5a5}a{color:#93c5fd}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:.6rem;border-bottom:1px solid #374151}#map[hidden]{display:none}#map{position:relative;z-index:1;display:block;width:100%;height:auto;image-rendering:pixelated;touch-action:none;background:transparent}#map-frame{position:relative;overflow:hidden;border:1px solid #475569}#map-ground{position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated;pointer-events:none}#map:focus{outline:2px solid #93c5fd;outline-offset:-2px}#map-info{min-height:1.5em}</style>
<h1>Minecraft AFK-Bot</h1>
<p>Bedrock 1.26.65: Offline-Verbindung über NetherNet. Der Nachweis für dauerhaftes Pflanzenwachstum steht noch aus.</p>
<button id="connect">Verbinden</button><button id="disconnect">Trennen</button>
<p id="feedback" role="status"></p>
<dl><dt>Verbindung</dt><dd id="status">Lädt …</dd><dt>Position</dt><dd id="position">Unbekannt</dd><dt>Dimension</dt><dd id="dimension">Unbekannt</dd><dt>Geladene Chunks</dt><dd id="chunks">0</dd><dt>Herzschlag</dt><dd id="tick">0</dd><dt>Letzter Fehler</dt><dd id="error">—</dd></dl>
<h2>Navigation mit Ein-Block-Sprüngen</h2>
<p>Ziel als Blockkoordinaten X/Z eingeben. Der Bot ermittelt die erreichbare Höhe selbst. Halbstufen und Treppen werden nach ihrer Richtung geprüft; Abstiege sind auf einen Block begrenzt. Volle Blockkanten bis einen Block Höhe werden bei freier Sprungbahn übersprungen. Keine Lücken- oder Flüssigkeitssprünge. Stopp beendet den Vortrieb; eine laufende Sprung- oder Fallbewegung endet bei der Landung.</p>
<form id="navigate"><label for="target-x">Ziel X</label><br><input id="target-x" type="number" step="1" min="-30000000" max="30000000" required><br>
<label for="target-z">Ziel Z</label><br><input id="target-z" type="number" step="1" min="-30000000" max="30000000" required><br>
<button id="nav-start" type="submit" disabled>Navigation starten</button><button id="nav-stop" type="button">Stopp</button></form>
<p id="preview-status" role="status">Ziel wählen, um den Weg ohne Bewegung vorzubereiten.</p>
<p id="nav-feedback" role="status"></p><p id="nav-status" role="status">Navigation inaktiv.</p>
<h2>Umgebung von oben</h2>
<p>Nord (−Z) oben, Ost (+X) rechts. Rot: Bot. Grau: unbekannt. Gelb schraffiert: oberhalb fehlen Daten. Leichter heller Nebel: historische Beobachtung, keine aktuellen Weltdaten.</p>
<p>Karte anklicken, um Ziel X/Z zu übernehmen. Mit Tastatur: Pfeiltasten, dann Enter oder Leertaste. Orange umrandet: gewähltes Ziel. Anschließend „Navigation starten“ drücken. Die Wegvorschau bewegt den Bot nicht. Erst „Navigation starten“ startet die Bewegung und prüft den Weg erneut; die Kartenhöhe ist keine Zielhöhe.</p>
<p>Lila: Wegvorschau nach Zielauswahl oder verbleibender Weg während der Bewegung. Aktualisierung etwa jede Sekunde. Neue Chunks und die Karte nach Ankunft werden automatisch nachgeladen.</p>
<p id="map-status" role="status">Karte verfügbar, sobald Weltdaten geladen sind.</p>
<div id="map-controls" hidden><button id="map-home" type="button">Zum Bot</button><button id="map-zoom-in" type="button" aria-label="Karte vergrößern">+</button><button id="map-zoom-out" type="button" aria-label="Karte verkleinern">−</button><label for="map-dimension">Dimension</label> <select id="map-dimension"><option value="0">Oberwelt</option><option value="1">Nether</option><option value="2">Ende</option></select><p>Ziehen zum Verschieben, Mausrad oder +/− zum Zoomen. Pfeiltasten lesen Zellen; Umschalt + Pfeiltasten verschiebt die Karte. Historische Flächen dienen nur der Orientierung.</p></div>
<div id="map-frame" hidden><canvas id="map-ground" aria-hidden="true"></canvas>
<canvas id="map" width="144" height="144" tabindex="0" aria-label="Draufsicht der geladenen Umgebung" aria-describedby="map-info" hidden>Die Umgebungskarte benötigt Canvas. Blockkoordinaten sind auch über die Blocksuche verfügbar.</canvas></div>
<p id="map-info">Maus oder Finger über die Karte bewegen; mit Tastatur fokussieren und Pfeiltasten verwenden, um Block-ID und Koordinaten zu lesen.</p>
<p id="map-hit-info" role="status">Türkis: Treffer der letzten Blocksuche, auch unter der Oberfläche. Marker anklicken oder mit Pfeiltasten und Enter auswählen.</p>
<div id="map-hit-options" aria-label="Treffer an der ausgewählten Kartenposition"></div>
<h2>Blöcke suchen</h2>
<p id="coverage" aria-live="polite">Weltdaten noch unbekannt.</p>
<form id="search"><label for="block">Block-ID</label><br><input id="block" name="block" value="minecraft:diamond_ore" list="block-ids" aria-describedby="block-hint" autocomplete="off" required maxlength="110"><datalist id="block-ids"></datalist><br>
<p id="block-hint" role="status">Blockvorschläge verfügbar, sobald die Registry geladen ist.</p>
<label for="limit">Maximale Treffer (1–100)</label><br><input id="limit" type="number" value="50" min="1" max="100" required>
<button id="find" type="submit">Suchen</button></form>
<p id="result" role="status"></p>
<table><thead><tr><th scope="col">X</th><th scope="col">Y</th><th scope="col">Z</th><th scope="col">Entfernung</th></tr></thead><tbody id="hits"></tbody></table>
<script>
const byId = id => document.getElementById(id);
const archiveEnabled = false;
let registryReady = false;
let currentMap = null;
let mapRequest = null;
let lastMapAt = 0;
let mapDirty = true;
let mapContext = '';
let previousNavigationStatus = null;
let botPosition = null;
let mapNavigation = null;
let preview = null;
let previewRequest = null;
let previewTimer = null;
let previewWanted = false;
let previewContext = '';
let navigationBusy = false;
let latestRevision = 0;
let mapCursor = null;
let searchResult = null;
let selectedHit = null;
let searchRequest = null;
let worldSession = null;
const canvas = byId('map');
const context = canvas.getContext('2d');
const ground = byId('map-ground');
const groundContext = ground.getContext('2d');
let terrainKey = null;
let renderedTerrainKey = null;
let view = null;
let followBot = true;
let mapDimension = 0;
let lastDimension = null;
let pointerFrame = null;
let pointerEvent = null;
let drag = null;
let dragged = false;
const tileCache = new Map();
byId('map-controls').hidden = !archiveEnabled;
function dimensionNumber (value) {
  return ({overworld:0, nether:1, end:2})[value] ?? (Number.isInteger(value) ? value : null);
}
function setMapSize (width, height) {
  if (canvas.width !== width || canvas.height !== height || ground.width !== width || ground.height !== height) {
    canvas.width = ground.width = width; canvas.height = ground.height = height;
    renderedTerrainKey = null;
  }
  canvas.hidden = false; byId('map-frame').hidden = false;
}
function invalidateView () {
  if (mapRequest) mapRequest.abort();
  mapRequest = null; mapDirty = true; currentMap = null; mapCursor = null; renderedTerrainKey = null;
  context.clearRect(0, 0, canvas.width, canvas.height);
  groundContext.clearRect(0, 0, ground.width, ground.height);
  void loadMap();
}
function homeMap () {
  if (!archiveEnabled) return;
  followBot = true;
  const dimension = dimensionNumber(lastDimension);
  if (dimension !== null) mapDimension = dimension;
  byId('map-dimension').value = String(mapDimension);
  const size = view?.size || 112;
  view = { x: Math.floor((botPosition?.x || 0) - size / 2), z: Math.floor((botPosition?.z || 0) - size / 2), size };
  invalidateView();
}
function zoomMap (factor) {
  if (!archiveEnabled || !view) return;
  const size = Math.max(16, Math.min(448, Math.round(view.size * factor)));
  if (size === view.size) return;
  view = { x: Math.floor(view.x + (view.size - size) / 2), z: Math.floor(view.z + (view.size - size) / 2), size };
  invalidateView();
}
byId('map-home').onclick = homeMap;
byId('map-zoom-in').onclick = () => zoomMap(.5);
byId('map-zoom-out').onclick = () => zoomMap(2);
byId('map-dimension').onchange = () => {
  followBot = false; mapDimension = Number(byId('map-dimension').value);
  invalidateView();
};
for (const id of ['target-x', 'target-z']) byId(id).oninput = () => {
  byId('nav-feedback').textContent = 'Ziel geändert. Mit „Navigation starten“ anlaufen.';
  schedulePreview(); drawMap();
};
function selectMapTarget (x, z) {
  if (archiveEnabled && mapDimension !== dimensionNumber(lastDimension)) {
    byId('nav-feedback').textContent = 'Ziele nur in der aktuell verbundenen Dimension wählen. „Zum Bot“ öffnet diese Dimension.'; return;
  }
  if (!currentMap || ![x,z].every(Number.isFinite) || x < 0 || z < 0 || x >= currentMap.width || z >= currentMap.height) return;
  const targetX = currentMap.x + Math.floor(x); const targetZ = currentMap.z + Math.floor(z);
  byId('target-x').value = String(targetX); byId('target-z').value = String(targetZ);
  byId('nav-feedback').textContent = 'Ziel gewählt – X: ' + targetX + ', Z: ' + targetZ + '. Mit „Navigation starten“ anlaufen; Erreichbarkeit wird dann geprüft.';
  schedulePreview();
  describeMapCell(Math.floor(x), Math.floor(z));
  selectMapHits(x, z);
}
function cancelPreview () {
  byId('preview-status').textContent = '';
  if (previewTimer !== null) clearTimeout(previewTimer);
  previewTimer = null;
  if (previewRequest) previewRequest.abort();
  previewRequest = null; preview = null;
}
function schedulePreview (delay = 250) {
  cancelPreview(); previewWanted = true;
  previewContext = JSON.stringify([worldSession,latestRevision,navigationBusy,botPosition,byId('target-x').value,byId('target-z').value]);
  if (!registryReady || !botPosition || navigationBusy) return;
  const x = Number(byId('target-x').value); const z = Number(byId('target-z').value);
  if (!byId('target-x').value.trim() || !byId('target-z').value.trim() || ![x,z].every(n=>Number.isInteger(n)&&Math.abs(n)<=30000000)) {
    byId('preview-status').textContent = 'Gültige ganzzahlige X/Z-Koordinaten für die Vorschau wählen.'; return;
  }
  byId('preview-status').textContent = 'Wegvorschau wird berechnet; der Bot bleibt stehen.';
  previewTimer = setTimeout(async () => {
    previewTimer = null;
    const controller = previewRequest = new AbortController();
    try {
      const response = await fetch('/api/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({x,z}),signal:controller.signal});
      const result = await response.json();
      if (previewRequest !== controller) return;
      if (!response.ok) throw new Error(result.error);
      if (result.session !== worldSession || !botPosition || Math.hypot(result.origin.x-botPosition.x,result.origin.y-botPosition.y,result.origin.z-botPosition.z)>.001) return;
      preview = result;
      byId('preview-status').textContent = 'Wegvorschau: ' + result.path.length + ' Wegpunkte. Erst „Navigation starten“ bewegt den Bot.';
      drawMap();
    } catch(error) { if (previewRequest === controller) byId('preview-status').textContent = 'Keine Wegvorschau: ' + error.message; }
    finally { if (previewRequest === controller) previewRequest = null; }
  },delay);
}
byId('navigate').onsubmit = async event => {
  event.preventDefault();
  cancelPreview(); previewWanted = false; drawMap();
  const x = Number(byId('target-x').value); const z = Number(byId('target-z').value);
  try {
    if (!byId('target-x').value.trim() || !byId('target-z').value.trim() || ![x,z].every(n => Number.isInteger(n) && Math.abs(n) <= 30000000)) throw new Error('Gültige ganzzahlige X/Z-Koordinaten eingeben.');
    const response = await fetch('/api/navigate', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({x,z}) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    byId('nav-feedback').textContent = 'Navigationsauftrag für X: ' + x + ', Z: ' + z + ' eingereiht.';
  } catch (error) { byId('nav-feedback').textContent = error.message; }
};
byId('nav-stop').onclick = async () => {
  cancelPreview(); previewWanted = false; drawMap();
  try {
    const response = await fetch('/api/stop_navigation', {method:'POST',headers:{'Content-Type':'application/json'}});
    if (!response.ok) throw new Error((await response.json()).error);
    byId('nav-feedback').textContent = 'Stopp eingereiht.';
  } catch (error) { byId('nav-feedback').textContent = error.message; }
};
function clearSearchResults () {
  if (searchRequest) searchRequest.abort();
  searchRequest = null; searchResult = null; selectedHit = null;
  byId('hits').replaceChildren(); byId('map-hit-options').replaceChildren();
  byId('map-hit-info').textContent = 'Türkis: Treffer der letzten Blocksuche, auch unter der Oberfläche. Marker anklicken oder mit Pfeiltasten und Enter auswählen.';
  drawMap();
}
function selectHit (hit) {
  selectedHit = hit;
  byId('map-hit-info').textContent = searchResult.blockId + ' – X: ' + hit.x + ', Y: ' + hit.y + ', Z: ' + hit.z + '. Treffer der letzten Suche; bei Weltänderungen erneut suchen.';
  drawMap();
}
function selectMapHits (x, z) {
  if (archiveEnabled && mapDimension !== dimensionNumber(lastDimension)) return;
  if (!currentMap || !searchResult || currentMap.coverage.session !== searchResult.coverage.session) return;
  const distance = hit => (hit.x + .5 - currentMap.x - x) ** 2 + (hit.z + .5 - currentMap.z - z) ** 2;
  const hits = searchResult.hits.filter(hit => distance(hit) <= 4 && hit.x >= currentMap.x && hit.x < currentMap.x + currentMap.width && hit.z >= currentMap.z && hit.z < currentMap.z + currentMap.height)
    .sort((a, b) => distance(a) - distance(b));
  byId('map-hit-options').replaceChildren();
  if (!hits.length) {
    selectedHit = null;
    byId('map-hit-info').textContent = 'Kein Suchtreffer an dieser Kartenposition.';
    drawMap(); return;
  }
  selectHit(hits[0]);
  if (hits.length > 1) for (const hit of hits) {
    const button = document.createElement('button'); button.type = 'button';
    button.textContent = searchResult.blockId + ' – X: ' + hit.x + ', Y: ' + hit.y + ', Z: ' + hit.z;
    button.onclick = () => selectHit(hit);
    byId('map-hit-options').append(button);
  }
}
function blockColor (id) {
  if (/water/.test(id)) return '#397bb8';
  if (/lava|magma/.test(id)) return '#e96325';
  if (/snow|ice|quartz/.test(id)) return '#dcebf0';
  if (/grass|moss/.test(id)) return '#76a64b';
  if (/leaves|vine|azalea/.test(id)) return '#387844';
  if (/sand|end_stone/.test(id)) return '#d5c38c';
  if (/dirt|mud|farmland|path/.test(id)) return '#886344';
  if (/log|wood|planks|stem/.test(id)) return '#a9804d';
  if (/netherrack|nether_brick/.test(id)) return '#914744';
  if (/stone|ore|gravel|andesite|diorite|granite|bedrock/.test(id)) return '#858b92';
  if (id === 'minecraft:air') return '#334155';
  let hash = 0; for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return 'hsl(' + ((hash >>> 0) % 360) + ' 35% 55%)';
}
const blockPixels = new Map();
let colorContext = null;
const unknownPixel = [32,43,64];
const unconfirmedPixel = [213,172,80];
function blockPixel (id) {
  let pixel = blockPixels.get(id);
  if (pixel) return pixel;
  const color = blockColor(id);
  if (color.startsWith('#')) pixel = [1,3,5].map(offset => parseInt(color.slice(offset,offset+2),16));
  else {
    if (!colorContext) {
      const swatch = document.createElement('canvas'); swatch.width = swatch.height = 1;
      colorContext = swatch.getContext('2d');
    }
    colorContext.fillStyle = color; colorContext.fillRect(0,0,1,1);
    pixel = colorContext.getImageData(0,0,1,1).data.slice(0,3);
  }
  if (blockPixels.size >= 2048) blockPixels.delete(blockPixels.keys().next().value);
  blockPixels.set(id,pixel);
  return pixel;
}
function rasterCells (target, cells, width, palette, historical) {
  const image = target.createImageData(width,cells.length/width);
  const pixels = image.data;
  for (let i=0;i<cells.length;i++) {
    const cell = cells[i];
    let color = cell ? blockPixel(palette ? palette[cell[0]] : cell[0]) : unknownPixel;
    if (cell && !cell[2] && (i%width+Math.floor(i/width))%2===0) color = unconfirmedPixel;
    const offset = i*4;
    if (cell && historical?.[i]) {
      pixels[offset] = color[0]*.84+210*.16;
      pixels[offset+1] = color[1]*.84+222*.16;
      pixels[offset+2] = color[2]*.84+232*.16;
    } else {
      pixels[offset] = color[0]; pixels[offset+1] = color[1]; pixels[offset+2] = color[2];
    }
    pixels[offset+3] = 255;
  }
  target.putImageData(image,0,0);
}
function paintTerrain () {
  if (renderedTerrainKey === terrainKey) return;
  const map = currentMap;
  groundContext.fillStyle = '#202b40'; groundContext.fillRect(0, 0, map.width, map.height);
  groundContext.imageSmoothingEnabled = false;
  if (map.tiles) {
    for (const tile of map.tiles) {
      if (!tile.raster) {
        tile.raster = document.createElement('canvas'); tile.raster.width = tile.raster.height = 16;
        rasterCells(tile.raster.getContext('2d'), tile.cells, 16, null, tile.live.map(live => !live));
      }
      groundContext.drawImage(tile.raster, tile.x * 16 - map.x, tile.z * 16 - map.z);
    }
  } else rasterCells(groundContext, map.cells, map.width, map.palette);
  renderedTerrainKey = terrainKey;
}
function drawMap () {
  if (!currentMap || !context) return;
  const map = currentMap;
  paintTerrain();
  context.clearRect(0, 0, map.width, map.height);
  context.strokeStyle = '#ffffff30'; context.lineWidth = .15; context.beginPath();
  for (let x = ((-map.x % 16) + 16) % 16; x <= map.width; x += 16) { context.moveTo(x, 0); context.lineTo(x, map.height); }
  for (let z = ((-map.z % 16) + 16) % 16; z <= map.height; z += 16) { context.moveTo(0, z); context.lineTo(map.width, z); }
  context.stroke();
  const route = !archiveEnabled || mapDimension === dimensionNumber(lastDimension) ? mapNavigation || preview : null;
  if (route && route.session === map.coverage.session && route.path.length && botPosition) {
    const origin = route.origin || botPosition;
    context.beginPath(); context.moveTo(origin.x - map.x, origin.z - map.z);
    for (const point of route.path) context.lineTo(point.x - map.x, point.z - map.z);
    context.lineJoin = 'round'; context.lineCap = 'round';
    context.strokeStyle = '#3b0764'; context.lineWidth = 1.3; context.stroke();
    context.strokeStyle = '#c084fc'; context.lineWidth = .65; context.stroke();
  }
  if (searchResult && (!archiveEnabled || mapDimension === dimensionNumber(lastDimension)) && searchResult.coverage.session === map.coverage.session) {
    const drawn = new Set();
    for (const hit of searchResult.hits) {
      const x = hit.x - map.x; const z = hit.z - map.z; const key = x + ':' + z;
      if (x < 0 || z < 0 || x >= map.width || z >= map.height || drawn.has(key)) continue;
      drawn.add(key);
      context.beginPath(); context.arc(x + .5, z + .5, 1.1, 0, Math.PI * 2);
      context.fillStyle = '#22d3ee'; context.fill(); context.strokeStyle = '#083344'; context.lineWidth = .4; context.stroke();
    }
    if (selectedHit && selectedHit.x >= map.x && selectedHit.x < map.x + map.width && selectedHit.z >= map.z && selectedHit.z < map.z + map.height) {
      context.beginPath(); context.arc(selectedHit.x - map.x + .5, selectedHit.z - map.z + .5, 1.6, 0, Math.PI * 2);
      context.strokeStyle = '#fff'; context.lineWidth = .5; context.stroke();
    }
  }
  if (botPosition && (!archiveEnabled || mapDimension === dimensionNumber(lastDimension))) {
    context.beginPath(); context.arc(botPosition.x - map.x, botPosition.z - map.z, 1.5, 0, Math.PI * 2);
    context.fillStyle = '#ef4444'; context.fill(); context.strokeStyle = '#fff'; context.lineWidth = .5; context.stroke();
  }
  const targetX = Number(byId('target-x').value); const targetZ = Number(byId('target-z').value);
  if ((!archiveEnabled || mapDimension === dimensionNumber(lastDimension)) && byId('target-x').value.trim() && byId('target-z').value.trim() && [targetX,targetZ].every(Number.isInteger) &&
      targetX >= map.x && targetX < map.x + map.width && targetZ >= map.z && targetZ < map.z + map.height) {
    context.strokeStyle = '#fb923c'; context.lineWidth = .5;
    context.strokeRect(targetX - map.x - .5, targetZ - map.z - .5, 2, 2);
  }
  if (mapCursor) {
    context.strokeStyle = '#fff'; context.lineWidth = .4;
    context.strokeRect(mapCursor.x, mapCursor.z, 1, 1);
  }
}
function describeMapCell (x, z) {
  if (!currentMap) return;
  const map = currentMap;
  x = Math.max(0, Math.min(map.width - 1, x)); z = Math.max(0, Math.min(map.height - 1, z));
  mapCursor = { x, z };
  const cell = map.cells[z * map.width + x];
  byId('map-info').textContent = 'X: ' + (map.x + x) + ', Z: ' + (map.z + z) + ': ' +
    (cell ? map.palette[cell[0]] + (cell[1] === null ? ' (vollständig Luft)' : ', Y: ' + cell[1]) +
      (cell[2] ? '' : ' – Oberhalb fehlen Daten; keine bestätigte Oberfläche.') + (map.historical?.[z * map.width + x] ? ' – Historische Beobachtung; aktuell nicht bestätigt.' : '') : 'Unbekannte Daten.');
  drawMap();
}
canvas.onpointerdown = event => {
  if (!archiveEnabled || !view || (event.button !== undefined && event.button !== 0)) return;
  drag = { x: event.clientX, z: event.clientY, view: { ...view } }; dragged = false;
  canvas.setPointerCapture(event.pointerId);
};
function applyPointer () {
  pointerFrame = null;
  const event = pointerEvent; pointerEvent = null;
  if (!event || !currentMap) return;
  const bounds = canvas.getBoundingClientRect();
  if (drag) {
    const dx = (event.clientX - drag.x) / bounds.width * drag.view.size;
    const dz = (event.clientY - drag.z) / bounds.height * drag.view.size;
    if (Math.hypot(event.clientX - drag.x, event.clientY - drag.z) > 4) dragged = true;
    if (dragged) {
      followBot = false;
      view = { ...drag.view, x: Math.max(-30000000, Math.min(30000000 - drag.view.size, Math.round(drag.view.x - dx))), z: Math.max(-30000000, Math.min(30000000 - drag.view.size, Math.round(drag.view.z - dz))) };
      // Reuse the current raster while dragging; request the final viewport on release.
      context.clearRect(0, 0, canvas.width, canvas.height);
      ground.style.transform = 'translate(' + (drag.view.x - view.x) / view.size * bounds.width + 'px,' + (drag.view.z - view.z) / view.size * bounds.height + 'px)';
      return;
    }
  }
  const x = Math.floor((event.clientX - bounds.left) / bounds.width * currentMap.width);
  const z = Math.floor((event.clientY - bounds.top) / bounds.height * currentMap.height);
  if (mapCursor?.x !== x || mapCursor?.z !== z) describeMapCell(x, z);
}
canvas.onpointermove = event => {
  pointerEvent = { clientX: event.clientX, clientY: event.clientY };
  if (pointerFrame === null) pointerFrame = requestAnimationFrame(applyPointer);
};
canvas.onpointerup = event => {
  if (!drag) return;
  pointerEvent = { clientX: event.clientX, clientY: event.clientY }; applyPointer();
  drag = null; ground.style.transform = '';
  if (dragged) invalidateView();
};
canvas.onpointercancel = () => {
  if (drag) { view = drag.view; drag = null; ground.style.transform = ''; drawMap(); }
  dragged = false;
};
canvas.onwheel = event => {
  if (!archiveEnabled) return;
  event.preventDefault(); zoomMap(event.deltaY > 0 ? 2 : .5);
};
canvas.onclick = event => {
  if (dragged) { dragged = false; return; }
  if (!currentMap) return;
  const bounds = canvas.getBoundingClientRect();
  selectMapTarget((event.clientX - bounds.left) / bounds.width * currentMap.width, (event.clientY - bounds.top) / bounds.height * currentMap.height);
};
canvas.onkeydown = event => {
  if (archiveEnabled && view && event.shiftKey && ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key)) {
    event.preventDefault(); followBot = false;
    view.x += event.key === 'ArrowRight' ? 16 : event.key === 'ArrowLeft' ? -16 : 0;
    view.z += event.key === 'ArrowDown' ? 16 : event.key === 'ArrowUp' ? -16 : 0;
    invalidateView(); return;
  }
  if (pointerEvent && !drag) applyPointer();
  if (currentMap && mapCursor && ['Enter', ' '].includes(event.key)) {
    event.preventDefault(); selectMapTarget(mapCursor.x + .5, mapCursor.z + .5); return;
  }
  if (!currentMap || !['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  const cursor = mapCursor || { x: Math.floor(currentMap.width / 2), z: Math.floor(currentMap.height / 2) };
  describeMapCell(cursor.x + (event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0), cursor.z + (event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0));
};
async function loadMap () {
  if (drag || mapRequest || (!mapDirty && Date.now() - lastMapAt < 5000)) return;
  const controller = mapRequest = new AbortController();
  lastMapAt = Date.now(); mapDirty = false;
  try {
    if (archiveEnabled) { await loadTiles(controller); return; }
    const response = await fetch('/api/map', { signal: controller.signal });
    const map = await response.json();
    if (!response.ok) throw new Error(map.error);
    if (mapRequest !== controller) return;
    currentMap = map; mapCursor = null;
    if (map.stale) mapDirty = true;
    setMapSize(map.width, map.height);
    terrainKey = JSON.stringify([map.x, map.z, map.palette, map.cells]);
    byId('map-status').textContent = map.width + ' × ' + map.height + ' Blöcke, X: ' + map.x + ' bis ' + (map.x + map.width - 1) +
      ', Z: ' + map.z + ' bis ' + (map.z + map.height - 1) + '. Höchste bekannte Blöcke. Aktualisierung bei neuen Daten und Ankunft, sonst etwa alle 5 Sekunden.' +
      (map.stale ? ' Weltdaten wurden inzwischen aktualisiert.' : '');
    byId('map-info').textContent = 'Maus oder Finger über die Karte bewegen; Pfeiltasten zeigen benachbarte Blöcke.';
    drawMap();
  } catch (error) {
    if (mapRequest === controller) byId('map-status').textContent = 'Karte konnte nicht aktualisiert werden: ' + error.message;
  } finally { if (mapRequest === controller) mapRequest = null; }
}
async function loadTiles (controller) {
  if (!view) { const size = 112; view = { x: Math.floor((botPosition?.x || 0) - size / 2), z: Math.floor((botPosition?.z || 0) - size / 2), size }; }
  view.x = Math.max(-30000000, Math.min(30000000 - view.size, view.x));
  view.z = Math.max(-30000000, Math.min(30000000 - view.size, view.z));
  const viewport = { ...view }; const dimension = mapDimension;
  const x = Math.floor(viewport.x / 16); const z = Math.floor(viewport.z / 16);
  const width = Math.ceil((viewport.x + viewport.size) / 16) - x;
  const height = Math.ceil((viewport.z + viewport.size) / 16) - z;
  const regions = [];
  for (let dz=0;dz<height;dz+=8) for (let dx=0;dx<width;dx+=8) {
    regions.push({dimension,x:x+dx,z:z+dz,width:Math.min(8,width-dx),height:Math.min(8,height-dz)});
  }
  const manifest = {tiles:[],session:worldSession,error:null};
  for (let offset=0;offset<regions.length;offset+=4) {
    const pages = await Promise.all(regions.slice(offset,offset+4).map(async region => {
      const query = new URLSearchParams(region);
      const response = await fetch('/api/map/tiles?' + query, {signal:controller.signal});
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      return result;
    }));
    if (mapRequest !== controller || pages.some(page => page.session !== worldSession)) { mapDirty = true; return; }
    for (const page of pages) {
      manifest.tiles.push(...page.tiles.filter(tile => !tile.empty));
      if (page.error) manifest.error = page.error;
    }
  }
  const visibleTiles = new Map((currentMap?.tiles || []).map(tile => [tile.dimension + ':' + tile.x + ':' + tile.z,tile]));
  const tiles = [];
  for (let offset = 0; offset < manifest.tiles.length; offset += 4) {
    const batch = await Promise.all(manifest.tiles.slice(offset, offset + 4).map(async item => {
      const key = dimension + ':' + item.x + ':' + item.z;
      let tile = tileCache.get(key) || visibleTiles.get(key);
      if (tile?.hash !== item.hash) {
        const params = new URLSearchParams({dimension, x:item.x, z:item.z});
        const result = await fetch('/api/map/tile?' + params, {signal:controller.signal, headers:tile ? {'If-None-Match':'"' + tile.hash + '"'} : {}});
        if (result.status !== 304) {
          const data = await result.json();
          if (!result.ok) throw new Error(data.error);
          if (mapRequest !== controller || data.session !== worldSession) { mapDirty = true; return null; }
          tile = data;
          if (tile.hash !== item.hash) mapDirty = true;
        }
      }
      if (mapRequest !== controller) return null;
      tileCache.delete(key); tileCache.set(key, tile);
      while (tileCache.size > 128) tileCache.delete(tileCache.keys().next().value);
      return tile;
    }));
    if (mapRequest !== controller || batch.some(tile => !tile)) return;
    tiles.push(...batch);
  }
  if (mapRequest !== controller) return;
  const palette = []; const indices = new Map();
  const cells = Array(viewport.size * viewport.size).fill(null); const historical = Array(cells.length).fill(false);
  for (const tile of tiles) tile.cells.forEach((cell, i) => {
    if (!cell) return;
    const localX = tile.x * 16 + i % 16 - viewport.x; const localZ = tile.z * 16 + Math.floor(i / 16) - viewport.z;
    if (localX < 0 || localZ < 0 || localX >= viewport.size || localZ >= viewport.size) return;
    if (!indices.has(cell[0])) { indices.set(cell[0], palette.length); palette.push(cell[0]); }
    const offset = localZ * viewport.size + localX;
    cells[offset] = [indices.get(cell[0]), cell[1], cell[2]]; historical[offset] = !tile.live[i];
  });
  currentMap = {x:viewport.x, z:viewport.z, width:viewport.size, height:viewport.size, cells, historical, palette, tiles, coverage:{session:manifest.session}};
  terrainKey = JSON.stringify([dimension, viewport, tiles.map(tile => tile.hash)]);
  setMapSize(viewport.size, viewport.size);
  byId('map-status').textContent = viewport.size + ' × ' + viewport.size + ' Blöcke. Erkundete Oberflächen bleiben gespeichert; leicht vernebelte Flächen sind historisch.' + (manifest.error ? ' Speicherfehler: ' + manifest.error : '');
  drawMap();
}
let loadingBlockIds = false;
async function loadBlockIds () {
  if (loadingBlockIds || byId('block-ids').children.length) return;
  loadingBlockIds = true;
  try {
    const response = await fetch('/api/block-ids');
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const result = await response.json();
    if (!registryReady) return;
    const options = result.blockIds.map(id => { const option = document.createElement('option'); option.value = id; return option; });
    byId('block-ids').replaceChildren(...options);
    byId('block-hint').textContent = options.length + ' Block-IDs verfügbar. Zum Filtern einen Teil der ID eingeben.';
  } catch (error) {
    if (registryReady) byId('block-hint').textContent = 'Blockvorschläge konnten nicht geladen werden. Erneuter Versuch folgt.';
  } finally { loadingBlockIds = false; }
}
byId('search').onsubmit = async event => {
  event.preventDefault(); byId('find').disabled = true; byId('result').textContent = 'Suche läuft …';
  clearSearchResults();
  const controller = searchRequest = new AbortController();
  try {
    const query = new URLSearchParams({block:byId('block').value.trim(), limit:byId('limit').value});
    const response = await fetch('/api/blocks?' + query, { signal: controller.signal });
    const result = await response.json();
    if (searchRequest !== controller) return;
    if (result.coverage && result.coverage.session !== worldSession) throw new Error('Weltsitzung geändert; erneut suchen.');
    if (!response.ok) throw new Error(result.error);
    searchResult = result;
    byId('map-hit-info').textContent = result.hits.length + ' Treffer der letzten Suche türkis markiert, auch unter der Oberfläche. Marker anklicken; bei Weltänderungen erneut suchen.';
    drawMap();
    const labels = {found:'Treffer gefunden', not_found:'Keine Treffer im vollständig bekannten Bereich', unknown:'Keine Treffer in bekannten Daten; Umgebung ist unvollständig'};
    byId('result').textContent = labels[result.outcome] + ': ' + result.hits.length + (result.limitReached ? ' (Trefferlimit erreicht)' : '') +
      '. Abdeckung bei Suche: ' + result.coverage.knownSubchunks + '/' + result.coverage.totalSubchunks + ' Subchunks.' +
      (result.stale ? ' Weltdaten wurden inzwischen aktualisiert; bei Bedarf erneut suchen.' : '');
    for (const hit of result.hits) {
      const row = document.createElement('tr');
      for (const value of [hit.x,hit.y,hit.z,hit.distance.toFixed(2)]) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }
      byId('hits').append(row);
    }
  } catch (error) { if (searchRequest === controller) byId('result').textContent = error.message; }
  finally { if (searchRequest === controller) { searchRequest = null; byId('find').disabled = false; } }
};
for (const command of ['connect', 'disconnect']) byId(command).onclick = async () => {
  try {
    const response = await fetch('/api/' + command, {method:'POST',headers:{'Content-Type':'application/json'}});
    if (!response.ok) throw new Error((await response.json()).error || 'HTTP ' + response.status);
    byId('feedback').textContent = 'Befehl angenommen: ' + command;
  } catch (error) { byId('feedback').textContent = error.message; }
};
const events = new EventSource('/api/events');
events.onmessage = event => {
  const state = JSON.parse(event.data);
  byId('status').textContent = state.status;
  byId('position').textContent = state.position ? Object.entries(state.position).map(([k,v])=>k+': '+v.toFixed(2)).join(' / ') + (state.positionSource === 'predicted' ? ' (Client-Prognose)' : ' (Server)') : 'Unbekannt';
  const nextDimension = dimensionNumber(state.dimension);
  if (archiveEnabled && followBot && nextDimension !== null && mapDimension !== nextDimension) {
    mapDimension = nextDimension; byId('map-dimension').value = String(mapDimension); mapDirty = true;
    if (mapRequest) mapRequest.abort(); mapRequest = null; currentMap = null;
  }
  lastDimension = state.dimension;
  const navigation = state.navigation;
  navigationBusy = ['planning','moving'].includes(navigation?.status);
  latestRevision = state.worldRevision ?? 0;
  byId('nav-start').disabled = state.status !== 'spawned' || ['planning','moving'].includes(navigation?.status);
  if (navigation) {
    const labels = {idle:'Inaktiv', planning:'Weg wird gesucht', moving:'Unterwegs', stopped:'Gestoppt', arrived:'Ziel laut Client-Prognose erreicht', error:'Navigation abgebrochen'};
    byId('nav-status').textContent = labels[navigation.status] + (navigation.target ? ' – X: ' + navigation.target.x + ', Z: ' + navigation.target.z + ', Fußhöhe Y: ' + (navigation.feetY === null ? '—' : navigation.feetY.toFixed(2)) : '') +
      ', verbleibende Wegpunkte: ' + navigation.remaining + (navigation.message ? '. ' + navigation.message : '');
  }
  byId('dimension').textContent = state.dimension ?? 'Unbekannt';
  byId('chunks').textContent = state.loadedChunks;
  byId('tick').textContent = state.tick;
  byId('error').textContent = state.lastError || '—';
  const coverage = state.coverage;
  const nextMapContext = JSON.stringify([coverage?.session,latestRevision,coverage?.knownSubchunks,state.position ? Math.floor(state.position.x/16) : null,state.position ? Math.floor(state.position.z/16) : null]);
  if (nextMapContext !== mapContext || (navigation?.status === 'arrived' && previousNavigationStatus !== 'arrived')) mapDirty = true;
  mapContext = nextMapContext; previousNavigationStatus = navigation?.status;
  if (worldSession !== coverage?.session) {
    worldSession = coverage?.session; cancelPreview(); previewWanted = false;
    clearSearchResults(); byId('find').disabled = false; byId('result').textContent = '';
    if (mapRequest) mapRequest.abort();
    mapRequest = null; currentMap = null; mapCursor = null; lastMapAt = 0; canvas.hidden = true; byId('map-frame').hidden = true; renderedTerrainKey = null;
  }
  registryReady = Boolean(coverage?.ready);
  botPosition = state.position;
  if (archiveEnabled && followBot && botPosition && view && !drag) {
    const x = Math.floor(botPosition.x - view.size / 2); const z = Math.floor(botPosition.z - view.size / 2);
    if (Math.abs(x - view.x) >= 16 || Math.abs(z - view.z) >= 16) {
      view = { ...view, x, z }; mapDirty = true;
      if (mapRequest) mapRequest.abort(); mapRequest = null;
    }
  }
  if (navigationBusy || !registryReady) cancelPreview();
  else if (previewWanted && previewContext !== JSON.stringify([worldSession,latestRevision,navigationBusy,botPosition,byId('target-x').value,byId('target-z').value])) schedulePreview();
  mapNavigation = state.status === 'spawned' && navigation?.status === 'moving' && registryReady ?
    {session:coverage.session, path:navigation.path || []} : null;
  if (registryReady) { byId('find').disabled = Boolean(searchRequest); void loadBlockIds(); void loadMap(); drawMap(); }
  else if (archiveEnabled) {
    clearSearchResults(); byId('find').disabled = true; byId('block-ids').replaceChildren();
    byId('block-hint').textContent = 'Blockvorschläge verfügbar, sobald die Registry geladen ist.';
    void loadMap(); drawMap();
  }
  else {
    clearSearchResults(); byId('find').disabled = false; byId('result').textContent = '';
    if (mapRequest) mapRequest.abort();
    mapRequest = null; currentMap = null; mapCursor = null; lastMapAt = 0; canvas.hidden = true; byId('map-frame').hidden = true; renderedTerrainKey = null;
    byId('map-status').textContent = 'Karte verfügbar, sobald Weltdaten geladen sind.';
    byId('map-info').textContent = 'Noch keine Karte geladen.';
    byId('block-ids').replaceChildren();
    byId('block-hint').textContent = 'Blockvorschläge verfügbar, sobald die Registry geladen ist.';
  }
  if (coverage) byId('coverage').textContent = coverage.knownSubchunks + '/' + coverage.totalSubchunks + ' Subchunks bekannt, ' +
    coverage.completeChunks + '/' + coverage.expectedChunks + ' Chunks vollständig, Radius ' + coverage.radius + '. ' +
    (coverage.complete ? 'Bereich vollständig geladen.' : 'Unbekannte Bereiche werden nicht als Luft gewertet.') +
    (coverage.error ? ' Letzter Datenfehler: ' + coverage.error : '');
};
events.onerror = () => { cancelPreview(); mapNavigation = null; drawMap(); byId('feedback').textContent = 'Statusverbindung unterbrochen. Wiederverbindung läuft.'; };
events.onopen = () => { byId('feedback').textContent = 'Statusverbindung aktiv.'; };
</script></html>`
