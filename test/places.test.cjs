/* Code generated/edited by Claude Opus 5.5: saved places, navigation history, their HTTP API and the map pins. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { once } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { BotController } = require('../dist/bot.js')
const { readConfig } = require('../dist/config.js')
const { createWebServer } = require('../dist/web.js')
const { PlaceStore, POI_MAX, HISTORY_MAX } = require('../dist/places.js')

const temporaryRoot = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'places-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}
const poi = (overrides = {}) => ({ name: 'Basis', icon: 'home', x: 5, z: -3, dimension: 0, ...overrides })

test('place store validates, persists per server/world and separates dimensions', async t => {
  const root = temporaryRoot(t)
  const store = new PlaceStore(root, 'server-a', 'world-1', () => 1234)
  const saved = await store.add(poi({ name: '  Ba   sis  ' }))
  assert.equal(saved.name, 'Ba sis', 'Whitespace is normalised')
  assert.equal(saved.createdAt, 1234)
  assert.match(saved.id, /^[0-9a-f-]{36}$/)
  assert.equal(store.revision, 1)
  assert.deepEqual((await store.list(0)).pois, [saved])
  assert.deepEqual((await store.list(1)).pois, [], 'Other dimensions stay separate')
  assert.deepEqual((await new PlaceStore(root, 'server-a', 'world-1').list(0)).pois, [saved], 'Places survive a restart')
  assert.deepEqual((await new PlaceStore(root, 'server-a', 'world-2').list(0)).pois, [], 'Another world key has its own places')
  for (const input of [poi({ name: '' }), poi({ name: 'x'.repeat(41) }), poi({ icon: 'skull' }), poi({ x: 1.5 }), poi({ z: 30000001 }), poi({ dimension: 3 }), poi({ x: '1' })]) {
    await assert.rejects(store.add(input), error => error.status === 400, JSON.stringify(input))
  }
  assert.equal(store.revision, 1, 'Rejected input changes nothing')
  await assert.rejects(store.remove('00000000-0000-0000-0000-000000000000'), error => error.status === 404)
  await store.remove(saved.id)
  assert.deepEqual((await store.list(0)).pois, [])
  await assert.rejects(store.list(5), error => error.status === 400)
})

test('place store limits places per dimension', async t => {
  const store = new PlaceStore(temporaryRoot(t), 'server', 'world')
  await Promise.all(Array.from({ length: POI_MAX }, (_, i) => store.add(poi({ name: 'P' + i, x: i }))))
  assert.equal((await store.list(0)).pois.length, POI_MAX, 'Concurrent additions are serialised without losing any')
  await assert.rejects(store.add(poi()), error => error.status === 409)
  await store.add(poi({ dimension: 1 }))
})

test('navigation history keeps the newest distinct targets per dimension', async t => {
  let now = 0
  const store = new PlaceStore(temporaryRoot(t), 'server', 'world', () => ++now)
  for (let i = 0; i < HISTORY_MAX + 2; i++) await store.recordNavigation(0, i, 0)
  await store.recordNavigation(1, 99, 99)
  let { history } = await store.list(0)
  assert.equal(history.length, HISTORY_MAX)
  assert.deepEqual(history.map(entry => entry.x), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2])
  await store.recordNavigation(0, 5, 0)
  history = (await store.list(0)).history
  assert.equal(history.length, HISTORY_MAX)
  assert.deepEqual(history.slice(0, 3).map(entry => entry.x), [5, 11, 10], 'A repeated target moves to the top instead of repeating')
  assert.equal(history.filter(entry => entry.x === 5).length, 1)
  assert.deepEqual((await store.list(1)).history.map(entry => [entry.x, entry.z]), [[99, 99]])
  await assert.rejects(store.recordNavigation(0, 0.5, 0), error => error.status === 400)
})

test('an unreadable places file is reported and never overwritten', async t => {
  const root = temporaryRoot(t)
  const store = new PlaceStore(root, 'server', 'world')
  await store.add(poi())
  const [file] = fs.readdirSync(root)
  fs.writeFileSync(path.join(root, file), '{"pois":[{"id":1}],"history":[]}')
  const broken = new PlaceStore(root, 'server', 'world')
  await assert.rejects(broken.list(0), /Invalid places file/)
  await assert.rejects(broken.add(poi()), /Invalid places file/)
  assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), '{"pois":[{"id":1}],"history":[]}')
})

test('HTTP places API validates requests, records navigation and announces revisions', async t => {
  const bot = new BotController(readConfig({ BEDROCK_HOST: 'localhost' }), () => { throw new Error('unused') })
  const store = new PlaceStore(temporaryRoot(t), 'server', 'world')
  const web = createWebServer(bot, undefined, store)
  const legacy = createWebServer(bot)
  t.after(() => { bot.stop(); web.close(); legacy.close() })
  web.server.listen(0, '127.0.0.1'); legacy.server.listen(0, '127.0.0.1')
  await Promise.all([once(web.server, 'listening'), once(legacy.server, 'listening')])
  const base = `http://127.0.0.1:${web.server.address().port}`
  const legacyBase = `http://127.0.0.1:${legacy.server.address().port}`
  assert.match(await fetch(base).then(r => r.text()), /const placesEnabled = true;/)
  assert.match(await fetch(legacyBase).then(r => r.text()), /const placesEnabled = false;/)
  assert.equal((await fetch(legacyBase + '/api/pois?dimension=0')).status, 404)
  const json = { 'Content-Type': 'application/json' }
  const post = (url, body, headers = json) => fetch(base + url, { method: 'POST', headers, body })
  for (const query of ['', '?dimension=', '?dimension=3', '?dimension=x']) assert.equal((await fetch(base + '/api/pois' + query)).status, 400, query)
  const empty = await fetch(base + '/api/pois?dimension=0').then(r => r.json())
  assert.deepEqual(empty.pois, []); assert.deepEqual(empty.history, [])
  assert.deepEqual(empty.icons, ['home', 'mine', 'portal', 'farm', 'storage', 'star'])
  assert.equal((await post('/api/pois', JSON.stringify(poi()), {})).status, 415)
  assert.equal((await post('/api/pois', JSON.stringify(poi()), { ...json, Origin: 'https://foreign.example' })).status, 403)
  assert.equal((await post('/api/pois', JSON.stringify(poi({ name: 'x'.repeat(600) })))).status, 413)
  for (const body of ['bad', 'null', '[]', JSON.stringify(poi({ name: '' }))]) assert.equal((await post('/api/pois', body)).status, 400, body)
  const created = await post('/api/pois', JSON.stringify(poi()))
  assert.equal(created.status, 201)
  const { poi: saved } = await created.json()
  assert.equal(saved.name, 'Basis')
  assert.deepEqual((await fetch(base + '/api/pois?dimension=0').then(r => r.json())).pois, [saved])
  const abort = new AbortController()
  t.after(() => abort.abort())
  const events = await fetch(base + '/api/events', { signal: abort.signal })
  const reader = events.body.getReader()
  assert.match(new TextDecoder().decode((await reader.read()).value), /"placesRevision":1/)
  await reader.cancel()
  assert.equal((await post('/api/pois/delete', JSON.stringify({ id: saved.id }))).status, 200)
  assert.equal((await post('/api/pois/delete', JSON.stringify({ id: saved.id }))).status, 404)
  assert.equal((await post('/api/pois/delete', '{}')).status, 400)
  bot.state.status = 'spawned'; bot.state.dimension = 'overworld'
  const revision = store.revision
  assert.equal((await post('/api/navigate', '{"x":3,"z":4}')).status, 202)
  const end = Date.now() + 2000
  while (store.revision === revision && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual((await fetch(base + '/api/pois?dimension=0').then(r => r.json())).history.map(entry => [entry.x, entry.z]), [[3, 4]])
  assert.equal((await post('/api/navigate', '{"x":3.5,"z":4}')).status, 400)
  assert.equal(store.revision, revision + 1, 'Rejected navigation is not recorded')
})

test('map pins show an overlay on hover or first tap and select places as targets', async t => {
  const bot = new BotController(readConfig({ BEDROCK_HOST: 'localhost' }), () => { throw new Error('unused') })
  const web = createWebServer(bot, undefined, new PlaceStore(temporaryRoot(t), 'server', 'world'))
  t.after(() => { bot.stop(); web.close() })
  web.server.listen(0, '127.0.0.1'); await once(web.server, 'listening')
  const page = await fetch(`http://127.0.0.1:${web.server.address().port}`).then(r => r.text())
  const elements = new Map()
  const context = new Proxy({}, { get (target, key) {
    if (key === 'createImageData') return (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) })
    return target[key] || (() => {})
  } })
  const element = () => ({
    children: [], textContent: '', value: '', hidden: false, disabled: false, style: {},
    replaceChildren (...children) { this.children = children },
    append (...children) { this.children.push(...children) },
    getContext: () => context,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 320 })
  })
  const byId = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id) }
  const coverage = { session: 1, ready: true, knownSubchunks: 24, totalSubchunks: 1176, completeChunks: 1, expectedChunks: 49, radius: 4 }
  const map = { x: -16, z: -16, width: 32, height: 32, palette: ['minecraft:stone'], cells: Array(1024).fill(null), coverage }
  const state = { status: 'spawned', position: { x: 0, y: 70, z: 0 }, dimension: 'overworld', loadedChunks: 1, coverage, placesRevision: 1,
    navigation: { status: 'idle', target: null, feetY: null, remaining: 0, message: null, path: [] } }
  const base = { id: '11111111-1111-1111-1111-111111111111', name: 'Basis', icon: 'home', x: 5, z: -3, dimension: 0, createdAt: 0 }
  let places = { dimension: 0, pois: [base], history: [{ x: 7, z: 7, dimension: 0, at: 0 }] }
  const requests = []
  let events
  const browser = vm.createContext({
    document: { getElementById: byId, createElement: element },
    AbortController, URLSearchParams, setTimeout, clearTimeout, Date,
    requestAnimationFrame: callback => { callback(); return null },
    EventSource: class { constructor () { events = this } },
    fetch: async (url, options = {}) => {
      requests.push({ url, options })
      const body = url === '/api/map' ? map : url.startsWith('/api/pois?') ? places
        : url === '/api/pois' ? { poi: JSON.parse(options.body) } : url === '/api/pois/delete' ? { deleted: JSON.parse(options.body).id }
          : url === '/api/block-ids' ? { blockIds: [] } : { path: [], session: 2 }
      return { ok: true, json: async () => body }
    }
  })
  vm.runInContext(page.match(/<script>([\s\S]*?)<\/script>/)[1], browser)
  const settle = () => new Promise(resolve => setImmediate(resolve))
  const publish = async () => { events.onmessage({ data: JSON.stringify(state) }); await settle(); await settle() }
  await publish()
  const canvas = byId('map'); const overlay = byId('map-pin-overlay')
  assert.equal(byId('places-panel').hidden, false)
  assert.equal(byId('poi-list').children.length, 1)
  assert.match(byId('poi-list').children[0].children[0].textContent, /🏠 Basis – X: 5, Z: -3 \(6 Blöcke entfernt\)/)
  assert.equal(byId('history-list').children.length, 1)
  const poiPin = byId('map-pins').children.find(pin => pin.textContent === '📍')
  assert.ok(poiPin, 'A saved place is a pin')
  assert.equal(poiPin.style.left, (21.5 / 32 * 100) + '%')
  // The pin glyph sits above its tip at (215, 135); the hit area is centred 14 px higher.
  canvas.onpointermove({ clientX: 215, clientY: 121 })
  assert.equal(overlay.hidden, false)
  assert.match(overlay.textContent, /🏠 Basis\nX: 5, Z: -3\n6 Blöcke entfernt\nKlicken/)
  canvas.onpointermove({ clientX: 40, clientY: 40 })
  assert.equal(overlay.hidden, true, 'Leaving the pin hides the overlay')
  canvas.onclick({ clientX: 215, clientY: 121 })
  assert.equal(byId('target-x').value, '5'); assert.equal(byId('target-z').value, '-3')
  assert.match(byId('nav-feedback').textContent, /Basis \(X: 5, Z: -3\)/)
  assert.equal(requests.filter(r => r.url === '/api/navigate').length, 0, 'Selecting a place does not start movement')
  byId('target-x').value = ''; byId('target-z').value = ''
  canvas.onpointerdown({ pointerType: 'touch', button: 0, clientX: 215, clientY: 121 })
  canvas.onclick({ clientX: 215, clientY: 121 })
  assert.equal(overlay.hidden, false); assert.match(overlay.textContent, /Erneut tippen/)
  assert.equal(byId('target-x').value, '', 'The first tap only shows the overlay')
  overlay.onclick()
  assert.equal(byId('target-x').value, '5', 'Tapping the overlay marks the place')
  assert.equal(overlay.hidden, true)
  byId('target-x').value = ''; byId('target-z').value = ''
  canvas.onclick({ clientX: 215, clientY: 121 }); canvas.onclick({ clientX: 215, clientY: 121 })
  assert.equal(byId('target-x').value, '5', 'A second tap on the pin marks it as well')
  canvas.onclick({ clientX: 215, clientY: 121 })
  canvas.onclick({ clientX: 30, clientY: 300 })
  assert.equal(overlay.hidden, true, 'Tapping elsewhere closes the overlay')
  assert.equal(byId('target-x').value, '-13', 'and selects the tapped cell as before')
  byId('poi-name').value = ''
  await byId('poi-save-bot').onclick()
  assert.match(byId('poi-feedback').textContent, /Namen/)
  assert.equal(requests.filter(r => r.url === '/api/pois').length, 0)
  byId('poi-name').value = 'Mine'; byId('poi-icon').value = 'mine'
  byId('target-x').value = '5'; byId('target-z').value = '-3'
  await byId('poi-save-target').onclick()
  assert.deepEqual(JSON.parse(requests.filter(r => r.url === '/api/pois').at(-1).options.body), { name: 'Mine', icon: 'mine', x: 5, z: -3, dimension: 0 })
  assert.equal(byId('poi-name').value, '')
  byId('poi-name').value = 'Spawn'
  await byId('poi-save-bot').onclick()
  assert.deepEqual(JSON.parse(requests.filter(r => r.url === '/api/pois').at(-1).options.body), { name: 'Spawn', icon: 'mine', x: 0, z: 0, dimension: 0 })
  await settle()
  const deleteButton = () => byId('poi-list').children[0].children[2]
  await deleteButton().onclick()
  assert.equal(deleteButton().textContent, 'Wirklich löschen?')
  assert.equal(requests.filter(r => r.url === '/api/pois/delete').length, 0, 'The first click only arms the deletion')
  await deleteButton().onclick()
  assert.deepEqual(JSON.parse(requests.filter(r => r.url === '/api/pois/delete').at(-1).options.body), { id: base.id })
  places = { dimension: 0, pois: [], history: [] }
  state.placesRevision = 2; await publish()
  assert.equal(byId('poi-list').children.length, 0)
  assert.ok(!byId('map-pins').children.some(pin => pin.textContent === '📍'), 'A deleted place loses its pin')
  assert.equal(byId('poi-empty').hidden, false)
})
