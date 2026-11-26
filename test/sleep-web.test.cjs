const { test } = require('node:test')
const assert = require('node:assert/strict')
const { once } = require('node:events')
const vm = require('node:vm')
const { BotController } = require('../dist/bot.js')
const { readConfig } = require('../dist/config.js')
const { createWebServer } = require('../dist/web.js')

test('sleep HTTP settings validate trust boundaries and appear in status and SSE while disconnected', async t => {
  const bot = new BotController(readConfig({ BEDROCK_HOST: 'localhost' }), () => { throw new Error('No live connection allowed') })
  const web = createWebServer(bot)
  t.after(() => { bot.stop(); web.close() })
  web.server.listen(0, '127.0.0.1'); await once(web.server, 'listening')
  const base = `http://127.0.0.1:${web.server.address().port}`
  const post = (body, headers = { 'Content-Type': 'application/json' }) => fetch(base + '/api/sleep', { method: 'POST', headers, body: JSON.stringify(body) })
  assert.equal((await post({}, {})).status, 415)
  assert.equal((await post({}, { 'Content-Type': 'application/json', Origin: 'https://foreign.example' })).status, 403)
  assert.equal((await post({ enabled: true })).status, 400)
  assert.equal((await post({ enabled: 'true', onlyWithPlayers: false })).status, 400)
  assert.equal((await post({ enabled: true, onlyWithPlayers: false, extra: true })).status, 400)
  assert.equal((await post({ padding: 'x'.repeat(300) })).status, 413)
  assert.equal((await post({ enabled: true, onlyWithPlayers: true })).status, 202)
  const state = await fetch(base + '/api/status').then(r => r.json())
  assert.equal(state.sleep.enabled, true); assert.equal(state.sleep.onlyWithPlayers, true)
  assert.equal(state.environment.clock, null); assert.equal(state.environment.light, null)
  const abort = new AbortController(); t.after(() => abort.abort())
  const reader = (await fetch(base + '/api/events', { signal: abort.signal })).body.getReader()
  const snapshot = JSON.parse(new TextDecoder().decode((await reader.read()).value).replace(/^data: /, ''))
  await reader.cancel()
  assert.equal(snapshot.sleep.enabled, true)
  assert.equal(snapshot.environment.light, null)
})

test('UI renders time and estimated zero light and saves the two switches without losing a disabled subsetting', async t => {
  const bot = new BotController(readConfig({ BEDROCK_HOST: 'localhost' }), () => { throw new Error('No live connection allowed') })
  const web = createWebServer(bot)
  t.after(() => { bot.stop(); web.close() })
  web.server.listen(0, '127.0.0.1'); await once(web.server, 'listening')
  const page = await fetch(`http://127.0.0.1:${web.server.address().port}`).then(r => r.text())
  assert.match(page, /id="world-clock"/)
  assert.match(page, /id="sleep-with-players"[^>]*disabled/)
  const elements = new Map()
  const canvas = new Proxy({}, { get (target, key) { return target[key] || (() => {}) } })
  const element = () => ({ children: [], value: '', textContent: '', style: {}, hidden: false, disabled: false, checked: false,
    replaceChildren (...children) { this.children = children }, append (...children) { this.children.push(...children) },
    getContext: () => canvas, getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 320 }) })
  const byId = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id) }
  let events; const requests = []
  const browser = vm.createContext({ document: { getElementById: byId, createElement: element }, AbortController, URLSearchParams, setTimeout, clearTimeout, Date, btoa,
    requestAnimationFrame: callback => { callback(); return null }, EventSource: class { constructor () { events = this } },
    fetch: async (url, options = {}) => {
      requests.push({ url, options })
      return { ok: true, json: async () => ({ sleep: { ...JSON.parse(options.body), message: 'Gespeichert.' } }) }
    }
  })
  vm.runInContext(page.match(/<script>([\s\S]*?)<\/script>/)[1], browser)
  const state = { status: 'disconnected', position: null, dimension: null, loadedChunks: 0,
    environment: { clock: '00:07', light: 0 }, sleep: { enabled: false, onlyWithPlayers: true, message: 'Aus.' } }
  events.onmessage({ data: JSON.stringify(state) })
  assert.equal(byId('world-clock').textContent, 'Ingame 00:07')
  assert.equal(byId('world-light').textContent, 'Licht ≈ 0/15')
  assert.equal(byId('sleep-with-players').disabled, true)
  assert.equal(byId('sleep-with-players').checked, true)
  byId('sleep-enabled').checked = true
  await byId('sleep-enabled').onchange()
  const request = requests.find(r => r.url === '/api/sleep')
  assert.deepEqual(JSON.parse(request.options.body), { enabled: true, onlyWithPlayers: true })
  assert.equal(byId('sleep-with-players').disabled, false)
  state.environment = { clock: null, light: null }
  events.onmessage({ data: JSON.stringify(state) })
  assert.equal(byId('world-light').textContent, 'Licht unbekannt')
  assert.equal(byId('world-clock').textContent, 'Uhrzeit unbekannt')
})
