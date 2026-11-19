import { createServer, type ServerResponse } from 'node:http'
import type { BotController, Command } from './bot.js'
import { WorldError } from './world.js'

export function createWebServer (bot: BotController) {
  const streams = new Set<ServerResponse>()
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
    if (request.method === 'GET' && request.url?.split('?')[0] === '/api/blocks') {
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
    } else if (request.method === 'GET' && request.url === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" })
      response.end(page)
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
<style>body{font:16px system-ui;max-width:52rem;margin:3rem auto;padding:0 1rem;background:#111827;color:#f3f4f6}button,input{font:inherit;padding:.7rem;margin:.3rem .3rem .3rem 0}input{max-width:100%;box-sizing:border-box}button{cursor:pointer}dt{font-weight:bold;margin-top:1rem}dd{margin:.3rem 0;overflow-wrap:anywhere}#error{color:#fca5a5}a{color:#93c5fd}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:.6rem;border-bottom:1px solid #374151}#map[hidden]{display:none}#map{display:block;width:100%;height:auto;image-rendering:pixelated;border:1px solid #475569;touch-action:pan-y}#map:focus{outline:2px solid #93c5fd}#map-info{min-height:1.5em}</style>
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
<p>Nord (−Z) oben, Ost (+X) rechts. Ein Bildpunkt entspricht einem Block. Rot: Bot. Grau: unbekannt. Gelb schraffiert: oberhalb fehlen Daten.</p>
<p>Karte anklicken, um Ziel X/Z zu übernehmen. Mit Tastatur: Pfeiltasten, dann Enter oder Leertaste. Orange umrandet: gewähltes Ziel. Anschließend „Navigation starten“ drücken. Die Wegvorschau bewegt den Bot nicht. Erst „Navigation starten“ startet die Bewegung und prüft den Weg erneut; die Kartenhöhe ist keine Zielhöhe.</p>
<p>Lila: Wegvorschau nach Zielauswahl oder verbleibender Weg während der Bewegung. Aktualisierung etwa jede Sekunde. Neue Chunks und die Karte nach Ankunft werden automatisch nachgeladen.</p>
<p id="map-status" role="status">Karte verfügbar, sobald Weltdaten geladen sind.</p>
<canvas id="map" width="144" height="144" tabindex="0" aria-label="Draufsicht der geladenen Umgebung" aria-describedby="map-info" hidden>Die Umgebungskarte benötigt Canvas. Blockkoordinaten sind auch über die Blocksuche verfügbar.</canvas>
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
for (const id of ['target-x', 'target-z']) byId(id).oninput = () => {
  byId('nav-feedback').textContent = 'Ziel geändert. Mit „Navigation starten“ anlaufen.';
  schedulePreview(); drawMap();
};
function selectMapTarget (x, z) {
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
function drawMap () {
  if (!currentMap || !context) return;
  const map = currentMap;
  context.fillStyle = '#202b40'; context.fillRect(0, 0, map.width, map.height);
  const colors = map.palette.map(blockColor);
  map.cells.forEach((cell, i) => {
    if (!cell) return;
    const x = i % map.width; const z = Math.floor(i / map.width);
    context.fillStyle = colors[cell[0]]; context.fillRect(x, z, 1, 1);
    if (!cell[2] && (x + z) % 2 === 0) { context.fillStyle = '#d5ac50'; context.fillRect(x, z, 1, 1); }
  });
  context.strokeStyle = '#ffffff30'; context.lineWidth = .15; context.beginPath();
  for (let i = 0; i <= map.width; i += 16) { context.moveTo(i, 0); context.lineTo(i, map.height); context.moveTo(0, i); context.lineTo(map.width, i); }
  context.stroke();
  const route = mapNavigation || preview;
  if (route && route.session === map.coverage.session && route.path.length && botPosition) {
    const origin = route.origin || botPosition;
    context.beginPath(); context.moveTo(origin.x - map.x, origin.z - map.z);
    for (const point of route.path) context.lineTo(point.x - map.x, point.z - map.z);
    context.lineJoin = 'round'; context.lineCap = 'round';
    context.strokeStyle = '#3b0764'; context.lineWidth = 1.3; context.stroke();
    context.strokeStyle = '#c084fc'; context.lineWidth = .65; context.stroke();
  }
  if (searchResult && searchResult.coverage.session === map.coverage.session) {
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
  if (botPosition) {
    context.beginPath(); context.arc(botPosition.x - map.x, botPosition.z - map.z, 1.5, 0, Math.PI * 2);
    context.fillStyle = '#ef4444'; context.fill(); context.strokeStyle = '#fff'; context.lineWidth = .5; context.stroke();
  }
  const targetX = Number(byId('target-x').value); const targetZ = Number(byId('target-z').value);
  if (byId('target-x').value.trim() && byId('target-z').value.trim() && [targetX,targetZ].every(Number.isInteger) &&
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
      (cell[2] ? '' : ' – Oberhalb fehlen Daten; keine bestätigte Oberfläche.') : 'Unbekannte Daten.');
  drawMap();
}
canvas.onpointermove = event => {
  if (!currentMap) return;
  const bounds = canvas.getBoundingClientRect();
  describeMapCell(Math.floor((event.clientX - bounds.left) / bounds.width * currentMap.width), Math.floor((event.clientY - bounds.top) / bounds.height * currentMap.height));
};
canvas.onclick = event => {
  if (!currentMap) return;
  const bounds = canvas.getBoundingClientRect();
  selectMapTarget((event.clientX - bounds.left) / bounds.width * currentMap.width, (event.clientY - bounds.top) / bounds.height * currentMap.height);
};
canvas.onkeydown = event => {
  if (currentMap && mapCursor && ['Enter', ' '].includes(event.key)) {
    event.preventDefault(); selectMapTarget(mapCursor.x + .5, mapCursor.z + .5); return;
  }
  if (!currentMap || !['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  const cursor = mapCursor || { x: Math.floor(currentMap.width / 2), z: Math.floor(currentMap.height / 2) };
  describeMapCell(cursor.x + (event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0), cursor.z + (event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0));
};
async function loadMap () {
  if (mapRequest || (!mapDirty && Date.now() - lastMapAt < 5000)) return;
  const controller = mapRequest = new AbortController();
  lastMapAt = Date.now(); mapDirty = false;
  try {
    const response = await fetch('/api/map', { signal: controller.signal });
    const map = await response.json();
    if (!response.ok) throw new Error(map.error);
    if (mapRequest !== controller) return;
    currentMap = map; mapCursor = null;
    if (map.stale) mapDirty = true;
    canvas.width = map.width; canvas.height = map.height; canvas.hidden = false;
    byId('map-status').textContent = map.width + ' × ' + map.height + ' Blöcke, X: ' + map.x + ' bis ' + (map.x + map.width - 1) +
      ', Z: ' + map.z + ' bis ' + (map.z + map.height - 1) + '. Höchste bekannte Blöcke. Aktualisierung bei neuen Daten und Ankunft, sonst etwa alle 5 Sekunden.' +
      (map.stale ? ' Weltdaten wurden inzwischen aktualisiert.' : '');
    byId('map-info').textContent = 'Maus oder Finger über die Karte bewegen; Pfeiltasten zeigen benachbarte Blöcke.';
    drawMap();
  } catch (error) {
    if (mapRequest === controller) byId('map-status').textContent = 'Karte konnte nicht aktualisiert werden: ' + error.message;
  } finally { if (mapRequest === controller) mapRequest = null; }
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
    mapRequest = null; currentMap = null; mapCursor = null; lastMapAt = 0; canvas.hidden = true;
  }
  registryReady = Boolean(coverage?.ready);
  botPosition = state.position;
  if (navigationBusy || !registryReady) cancelPreview();
  else if (previewWanted && previewContext !== JSON.stringify([worldSession,latestRevision,navigationBusy,botPosition,byId('target-x').value,byId('target-z').value])) schedulePreview();
  mapNavigation = state.status === 'spawned' && navigation?.status === 'moving' && registryReady ?
    {session:coverage.session, path:navigation.path || []} : null;
  if (registryReady) { void loadBlockIds(); void loadMap(); drawMap(); }
  else {
    clearSearchResults(); byId('find').disabled = false; byId('result').textContent = '';
    if (mapRequest) mapRequest.abort();
    mapRequest = null; currentMap = null; mapCursor = null; lastMapAt = 0; canvas.hidden = true;
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
