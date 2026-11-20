const { test } = require('node:test')
const assert = require('node:assert/strict')
const { once } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { PNG } = require('pngjs')
const { BotController } = require('../dist/bot.js')
const { readConfig } = require('../dist/config.js')
const { createWebServer } = require('../dist/web.js')
const { SkinStore, normaliseSkin } = require('../dist/skin.js')

const temporaryFile = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skin-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return path.join(root, 'data', 'skin.json')
}
const makePng = (width, height, paint = () => {}) => {
  const image = new PNG({ width, height })
  for (let i = 0; i < width * height * 4; i += 4) image.data.set([10, 20, 30, 255], i)
  paint(image)
  return PNG.sync.write(image)
}
const pixel = (rgba, x, y) => [...rgba.subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 4)]

test('skin validation accepts 64x64, expands 64x32 and rejects anything else', () => {
  const square = normaliseSkin(makePng(64, 64, image => image.data.set([1, 2, 3, 4], (5 * 64 + 7) * 4)))
  assert.equal(square.length, 64 * 64 * 4)
  assert.deepEqual(pixel(square, 7, 5), [1, 2, 3, 4], 'Pixels survive including alpha')

  // The right leg's top face (4,16) is mirrored into the left leg at (23,48); the right arm (44,16) into the left arm (39,48).
  const legacy = normaliseSkin(makePng(64, 32, image => {
    image.data.set([200, 0, 0, 255], (16 * 64 + 4) * 4)
    image.data.set([0, 200, 0, 255], (16 * 64 + 44) * 4)
    image.data.set([0, 0, 200, 255], (3 * 64 + 3) * 4)
  }))
  assert.equal(legacy.length, 64 * 64 * 4)
  assert.deepEqual(pixel(legacy, 3, 3), [0, 0, 200, 255], 'The upper half is kept')
  assert.deepEqual(pixel(legacy, 23, 48), [200, 0, 0, 255])
  assert.deepEqual(pixel(legacy, 39, 48), [0, 200, 0, 255])
  assert.deepEqual(pixel(legacy, 0, 48), [0, 0, 0, 0], 'Overlay areas without a source stay transparent')

  for (const [width, height] of [[128, 128], [64, 48], [32, 32]]) {
    assert.throws(() => normaliseSkin(makePng(width, height)), error => error.status === 400 && /64x64 or 64x32/.test(error.message))
  }
  assert.throws(() => normaliseSkin(Buffer.from('not a png at all, really not')), error => error.status === 400)
  // A header that declares a huge image is rejected before decoding.
  const huge = Buffer.from(makePng(64, 64)); huge.writeUInt32BE(100000, 16); huge.writeUInt32BE(100000, 20)
  assert.throws(() => normaliseSkin(huge), /100000x100000/)
  assert.throws(() => normaliseSkin(Buffer.alloc(49153)), error => error.status === 413)
})

test('skin store persists atomically, builds the login fields and falls back on a broken file', async t => {
  const file = temporaryFile(t)
  const store = new SkinStore(file)
  assert.deepEqual(store.status(), { saved: null, model: null, active: null, error: null })
  assert.deepEqual(store.connectSkinData(), {}, 'Without a saved skin bedrock-protocol keeps its default')

  await assert.rejects(store.save(makePng(64, 64).toString('base64'), 'giant'), error => error.status === 400)
  await assert.rejects(store.save('***', 'classic'), error => error.status === 400)
  await assert.rejects(store.save(makePng(128, 128).toString('base64'), 'classic'), error => error.status === 400)
  assert.equal(fs.existsSync(file), false, 'Rejected uploads write nothing')

  const status = await store.save(makePng(64, 32).toString('base64'), 'slim')
  assert.match(status.saved, /^[0-9a-f]{64}$/)
  assert.equal(status.model, 'slim')
  assert.equal(status.active, null, 'Saving does not change the running connection')
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['skin.json'], 'No temp files remain')
  assert.equal(PNG.sync.read(store.png()).height, 64, 'The stored PNG is normalised')

  const restarted = new SkinStore(file)
  assert.deepEqual(restarted.status(), status, 'The skin survives a restart')
  const login = restarted.connectSkinData()
  assert.equal(login.SkinId, 'Custom_' + status.saved.slice(0, 16))
  assert.equal(Buffer.from(login.SkinData, 'base64').length, 64 * 64 * 4)
  assert.equal(login.SkinImageWidth, 64); assert.equal(login.SkinImageHeight, 64)
  assert.deepEqual(JSON.parse(Buffer.from(login.SkinResourcePatch, 'base64')), { geometry: { default: 'geometry.humanoid.customSlim' } })
  assert.equal(login.ArmSize, 'slim')
  assert.equal(login.PersonaSkin, false)
  assert.deepEqual(login.PersonaPieces, [])
  assert.equal(restarted.status().active, status.saved, 'The connection remembers the skin it sent')

  await restarted.remove()
  assert.equal(fs.existsSync(file), false)
  assert.equal(restarted.status().saved, null)
  assert.equal(restarted.status().active, status.saved, 'Deleting needs a reconnect as well')
  assert.deepEqual(restarted.connectSkinData(), {})
  assert.equal(restarted.status().active, null)

  fs.writeFileSync(file, '{"model":"classic"')
  const broken = new SkinStore(file)
  assert.match(broken.status().error, /Invalid skin file/)
  const logged = []; const original = console.error; console.error = (...args) => logged.push(args.join(' '))
  try { assert.deepEqual(broken.connectSkinData(), {}, 'A broken file connects with the default skin') } finally { console.error = original }
  assert.match(logged[0], /default skin/)
  assert.equal(fs.readFileSync(file, 'utf8'), '{"model":"classic"', 'The broken file is not overwritten')
  await broken.save(makePng(64, 64).toString('base64'), 'classic')
  assert.equal(broken.status().error, null, 'An upload replaces the broken file')
})

test('skin HTTP API validates uploads, serves the preview and publishes the status', async t => {
  const skins = new SkinStore(temporaryFile(t))
  const bot = new BotController(readConfig({ BEDROCK_HOST: 'localhost' }), () => { throw new Error('unused') })
  const web = createWebServer(bot, undefined, undefined, skins)
  t.after(() => { bot.stop(); web.close() })
  web.server.listen(0, '127.0.0.1'); await once(web.server, 'listening')
  const base = `http://127.0.0.1:${web.server.address().port}`
  const post = (url, body, headers = {}) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body })
  assert.match(await fetch(base).then(r => r.text()), /const skinEnabled = true;/)
  assert.equal((await fetch(base + '/api/skin')).status, 404)
  assert.equal((await fetch(base + '/api/skin', { method: 'POST', body: '{}' })).status, 415)
  assert.equal((await post('/api/skin', '{}', { Origin: 'https://foreign.example' })).status, 403)
  assert.equal((await post('/api/skin', 'nope')).status, 400)
  assert.equal((await post('/api/skin', JSON.stringify({ png: makePng(64, 16).toString('base64'), model: 'classic' }))).status, 400)
  assert.equal((await post('/api/skin', JSON.stringify({ png: 'A'.repeat(70000), model: 'classic' }))).status, 413)

  const png = makePng(64, 64)
  const created = await post('/api/skin', JSON.stringify({ png: png.toString('base64'), model: 'classic' }))
  assert.equal(created.status, 201)
  const status = await created.json()
  assert.equal(status.model, 'classic')
  const preview = await fetch(base + '/api/skin?h=' + status.saved)
  assert.equal(preview.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), skins.png())

  const abort = new AbortController()
  t.after(() => abort.abort())
  const events = await fetch(base + '/api/events', { signal: abort.signal })
  const reader = events.body.getReader()
  assert.match(new TextDecoder().decode((await reader.read()).value), new RegExp(`"skin":\\{"saved":"${status.saved}"`))
  await reader.cancel()

  assert.equal((await post('/api/skin/delete', '{}')).status, 400)
  const deleted = await post('/api/skin/delete')
  assert.equal(deleted.status, 200)
  assert.equal((await deleted.json()).saved, null)
  assert.equal((await fetch(base + '/api/skin')).status, 404)

  const plain = createWebServer(bot)
  t.after(() => plain.close())
  plain.server.listen(0, '127.0.0.1'); await once(plain.server, 'listening')
  const plainBase = `http://127.0.0.1:${plain.server.address().port}`
  assert.match(await fetch(plainBase).then(r => r.text()), /const skinEnabled = false;/)
  assert.equal((await fetch(plainBase + '/api/skin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404)
})

test('skin panel uploads the file, shows a pending skin and reconnects on request', async t => {
  const bot = new BotController(readConfig({ BEDROCK_HOST: 'localhost' }), () => { throw new Error('unused') })
  const web = createWebServer(bot, undefined, undefined, new SkinStore(temporaryFile(t)))
  t.after(() => { bot.stop(); web.close() })
  web.server.listen(0, '127.0.0.1'); await once(web.server, 'listening')
  const page = await fetch(`http://127.0.0.1:${web.server.address().port}`).then(r => r.text())
  const elements = new Map()
  const context = new Proxy({}, { get (target, key) { return target[key] || (() => {}) } })
  const element = () => ({
    children: [], textContent: '', value: '', hidden: false, disabled: false, style: {},
    replaceChildren (...children) { this.children = children },
    append (...children) { this.children.push(...children) },
    getContext: () => context,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 320 })
  })
  const byId = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id) }
  const saved = { saved: 'a'.repeat(64), model: 'slim', active: null, error: null }
  const requests = []
  let events
  const browser = vm.createContext({
    document: { getElementById: byId, createElement: element },
    AbortController, URLSearchParams, setTimeout, clearTimeout, Date, btoa,
    requestAnimationFrame: callback => { callback(); return null },
    EventSource: class { constructor () { events = this } },
    fetch: async (url, options = {}) => {
      requests.push({ url, options })
      const body = url === '/api/skin' ? saved : url === '/api/block-ids' ? { blockIds: [] } : { command: url }
      return { ok: true, json: async () => body }
    }
  })
  vm.runInContext(page.match(/<script>([\s\S]*?)<\/script>/)[1], browser)
  const state = { status: 'spawned', position: null, dimension: null, loadedChunks: 0, skin: { saved: null, model: null, active: null, error: null },
    navigation: { status: 'idle', target: null, feetY: null, remaining: 0, message: null, path: [] } }
  const publish = () => events.onmessage({ data: JSON.stringify(state) })
  publish()
  assert.equal(byId('skin-panel').hidden, false)
  assert.equal(byId('skin-preview').hidden, true)
  assert.match(byId('skin-status').textContent, /Standard-Skin aktiv/)
  assert.equal(byId('skin-reconnect').hidden, true)
  assert.equal(byId('skin-reset').disabled, true)

  await byId('skin-upload').onclick()
  assert.match(byId('skin-feedback').textContent, /PNG-Datei wählen/)
  const png = makePng(64, 64)
  byId('skin-file').files = [{ size: png.length, arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.length) }]
  byId('skin-model').value = 'slim'
  await byId('skin-upload').onclick()
  const upload = requests.filter(r => r.url === '/api/skin').at(-1)
  assert.deepEqual(JSON.parse(upload.options.body), { png: png.toString('base64'), model: 'slim' })
  assert.match(byId('skin-feedback').textContent, /nächsten Verbindung/)
  assert.equal(byId('skin-preview').hidden, false)
  assert.equal(byId('skin-preview').src, '/api/skin?h=' + saved.saved)
  assert.match(byId('skin-status').textContent, /Eigener Skin \(Slim\) gespeichert – beim nächsten Verbinden aktiv/)
  assert.equal(byId('skin-reconnect').hidden, false)

  await byId('skin-reconnect').onclick()
  assert.deepEqual(requests.slice(-2).map(r => r.url), ['/api/disconnect', '/api/connect'], 'Reconnect disconnects first, then connects')
  state.skin = { ...saved, active: saved.saved }; publish()
  assert.match(byId('skin-status').textContent, /Eigener Skin \(Slim\) aktiv/)
  assert.equal(byId('skin-reconnect').hidden, true)
  state.status = 'disconnected'; state.skin = { ...saved, error: 'Invalid skin file' }; publish()
  assert.match(byId('skin-status').textContent, /fehlerhaft/)
  assert.equal(byId('skin-reset').disabled, false)
})
