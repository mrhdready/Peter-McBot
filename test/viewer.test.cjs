const { test } = require('node:test')
const assert = require('node:assert/strict')
const { once } = require('node:events')
const { Worker } = require('node:worker_threads')
const path = require('node:path')
const fs = require('node:fs')
const { ViewerMapping, VIEWER_VERSION, viewerPose } = require('../dist/viewer-mapping.js')
const { WorldState } = require('../dist/state.js')
const { createWebServer } = require('../dist/web.js')
const { io } = require('socket.io-client')

const bedrock = require('prismarine-registry')('bedrock_1.26.60')
const java = require('minecraft-data')(VIEWER_VERSION)
const Block = require('prismarine-block')(VIEWER_VERSION)
const Chunk = require('prismarine-chunk')(VIEWER_VERSION)
const mapping = new ViewerMapping('1.26.60')
const id = name => bedrock.blocksByName[name].defaultState
const section = () => ({ data: new Uint32Array(8192).fill(id('air')) })
const column = () => ({ x: -1, z: 0, sections: new Map(), announced: true, attempts: new Map(), requests: new Map() })

test('viewer maps palettes, new stair corners, water layers and unsupported blocks to valid Java states', () => {
  assert.equal(mapping.stateId(id('stone')), java.blocksByName.stone.defaultState)
  assert.equal(Block.fromStateId(mapping.stateId(id('grass_block')), 1).name, 'grass_block')
  assert.equal(mapping.stateId(id('air')), java.blocksByName.air.defaultState)
  assert.equal(mapping.stateId(id('air'), id('water')), java.blocksByName.water.defaultState)
  const stairs = Block.fromStateId(mapping.stateId(id('oak_stairs')), 1)
  assert.equal(stairs.name, 'oak_stairs')
  assert.equal(stairs.getProperties().shape, 'straight')
  assert.equal(Block.fromStateId(mapping.stateId(id('oak_stairs'), id('water')), 1).getProperties().waterlogged, true)
  assert.equal(mapping.stateId(999999), mapping.fallback)
  assert.equal(mapping.stateId(id('hard_pink_stained_glass')), mapping.fallback)
  for (let i = 0; i < bedrock.blockStates.length; i++) assert.ok(java.blocksByStateId[mapping.stateId(i)])
})

test('viewer serializes both height extremes and preserves confirmed air versus unknown sections in source data', async () => {
  const c = column()
  const low = section(); const high = section()
  low.data[0] = id('stone')
  high.data[(15 << 8) | (15 << 4) | 15] = id('grass_block')
  c.sections.set(-4, low); c.sections.set(19, high); c.sections.set(0, { data: null })
  const result = await mapping.column(c, () => false)
  const chunk = Chunk.fromJson(result.chunk)
  assert.equal(chunk.getBlockStateId({ x: 0, y: -64, z: 0 }), java.blocksByName.stone.defaultState)
  assert.equal(Block.fromStateId(chunk.getBlockStateId({ x: 15, y: 319, z: 15 }), 1).name, 'grass_block')
  assert.equal(c.sections.has(1), false)
  assert.equal(c.sections.get(0).data, null)
  assert.equal(await mapping.column(c, () => true), null)
})

test('viewer camera converts cardinal directions and pitch without adding eye height', () => {
  const position = { x: 1, y: -20, z: 3 }
  for (const [yaw, x, z] of [[0, 0, 1], [90, -1, 0], [-90, 1, 0], [180, 0, -1]]) {
    const pose = viewerPose(position, yaw, 30)
    assert.ok(Math.abs(-Math.sin(pose.yaw) - x) < 1e-10)
    assert.ok(Math.abs(-Math.cos(pose.yaw) - z) < 1e-10)
    assert.equal(pose.pitch, -Math.PI / 6)
    assert.deepEqual(pose.position, position)
  }
})

test('bundled viewer worker meshes blocks below zero and at the world ceiling', { timeout: 15000 }, async t => {
  const entry = path.resolve(__dirname, '../dist/ui/viewer/worker.js')
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    global.self = {};
    global.postMessage = (data, transfer) => parentPort.postMessage(data, transfer);
    parentPort.on('message', data => self.onmessage({ data }));
    require(${JSON.stringify(entry)});
  `, { eval: true })
  t.after(() => worker.terminate())
  const c = column()
  for (const y of [-4, 19]) { const s = section(); s.data[0] = id('stone'); c.sections.set(y, s) }
  const { chunk } = await mapping.column(c, () => false)
  const geometry = new Map()
  const ready = new Promise((resolve, reject) => {
    worker.on('error', reject)
    worker.on('message', data => {
      if (data.type === 'geometry' && data.geometry.positions.length) geometry.set(data.key, data.geometry)
      if (geometry.size === 2) resolve()
    })
  })
  worker.postMessage({ type: 'version', version: VIEWER_VERSION })
  worker.postMessage({ type: 'blockStates', json: JSON.parse(fs.readFileSync(path.resolve(__dirname, '../dist/ui/viewer/blocksStates/1.21.4.json'))) })
  worker.postMessage({ type: 'chunk', x: -16, z: 0, chunk })
  for (const y of [-64, 304]) worker.postMessage({ type: 'dirty', x: -16, y, z: 0, value: true })
  await ready
  assert.ok(geometry.has('-16,-64,0'))
  assert.ok(geometry.has('-16,304,0'))
  const nextGeneration = new Promise(resolve => worker.on('message', data => {
    if (data.type === 'geometry' && data.generation === 7) resolve(data)
  }))
  worker.postMessage({ type: 'reset', generation: 7 })
  worker.postMessage({ type: 'version', version: VIEWER_VERSION })
  worker.postMessage({ type: 'blockStates', json: JSON.parse(fs.readFileSync(path.resolve(__dirname, '../dist/ui/viewer/blocksStates/1.21.4.json'))) })
  worker.postMessage({ type: 'chunk', x: -16, z: 0, chunk })
  worker.postMessage({ type: 'dirty', x: -16, y: -64, z: 0, value: true })
  assert.equal((await nextGeneration).generation, 7)
})

test('viewer socket streams changes, evictions and resets without moving the bot; assets stay local', { timeout: 20000 }, async t => {
  const world = new WorldState(6)
  world.status = 'spawned'; world.position = { x: -1, y: 65.62, z: 1 }
  const coverage = world.coverage.bind(world)
  world.coverage = () => ({ ...coverage(), ready: true })
  const c = column(); const initial = section(); initial.data[0] = id('stone'); c.sections.set(-4, initial)
  world.chunks.set('-1:0', c)
  const bot = { state: world, farm: { status: () => ({}) }, collector: { status: () => ({}) } }
  const web = createWebServer(bot)
  t.after(() => web.close())
  web.server.listen(0, '127.0.0.1'); await once(web.server, 'listening')
  const base = `http://127.0.0.1:${web.server.address().port}`
  const socket = io(base, { path: '/api/viewer/socket', transports: ['websocket'], reconnection: false })
  t.after(() => socket.disconnect())
  let reset
  socket.on('reset', data => { reset = data })
  const nextColumn = () => new Promise(resolve => socket.once('loadChunk', (data, ack) => { ack(); resolve(data) }))
  const first = await nextColumn()
  assert.equal(reset.radius, 6)
  assert.equal(reset.version, VIEWER_VERSION)
  assert.equal(first.x, -16)
  assert.equal(Chunk.fromJson(first.chunk).getBlockStateId({ x: 0, y: -64, z: 0 }), java.blocksByName.stone.defaultState)
  const next = nextColumn()
  const changed = section(); changed.data[0] = id('glass'); c.sections.set(-4, changed)
  const update = await next
  assert.equal(Chunk.fromJson(update.chunk).getBlockStateId({ x: 0, y: -64, z: 0 }), java.blocksByName.glass.defaultState)
  const unloaded = once(socket, 'unloadChunk'); world.chunks.delete('-1:0')
  assert.equal((await unloaded)[0].x, -16)
  const cleared = once(socket, 'reset'); world.clearChunks()
  assert.notEqual((await cleared)[0].session, first.session)
  assert.deepEqual(world.position, { x: -1, y: 65.62, z: 1 })
  const response = await fetch(base + '/viewer/index.js', { headers: { 'accept-encoding': 'gzip' } })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/javascript')
  assert.equal(response.headers.get('content-encoding'), 'gzip')
  assert.ok((await response.text()).includes('createBotViewer'))
  assert.equal((await fetch(base + '/viewer/../package.json')).status, 404)
  const page = await fetch(base)
  assert.match(page.headers.get('content-security-policy'), /worker-src 'self'/)
  assert.match(await page.text(), /id="world-view"/)
})

test('viewer discards a column converted during a session reset and rejects foreign origins', { timeout: 15000 }, async t => {
  const world = new WorldState()
  world.position = { x: 0, y: 65, z: 0 }
  const coverage = world.coverage.bind(world)
  world.coverage = () => ({ ...coverage(), ready: true })
  const old = column(); const s = section(); s.data[0] = id('stone'); old.sections.set(0, s)
  world.chunks.set('-1:0', old)
  const web = createWebServer({ state: world })
  t.after(() => web.close())
  web.server.listen(0, '127.0.0.1'); await once(web.server, 'listening')
  const base = `http://127.0.0.1:${web.server.address().port}`
  const foreign = io(base, { path: '/api/viewer/socket', transports: ['websocket'], reconnection: false, extraHeaders: { Origin: 'https://foreign.example' } })
  t.after(() => foreign.disconnect())
  await once(foreign, 'connect_error')
  const socket = io(base, { path: '/api/viewer/socket', transports: ['websocket'], reconnection: false })
  t.after(() => socket.disconnect())
  const chunks = []
  socket.on('loadChunk', (data, ack) => { chunks.push(data); ack() })
  // Reset is reliable; volatile position packets may be dropped during the handshake.
  await once(socket, 'reset')
  world.clearChunks()
  const fresh = column(); const replacement = section(); replacement.data[0] = id('glass'); fresh.sections.set(0, replacement)
  world.chunks.set('-1:0', fresh)
  const [data] = await once(socket, 'loadChunk')
  assert.equal(data.session, world.worldSession)
  assert.equal(chunks.length, 1)
  assert.equal(Chunk.fromJson(data.chunk).getBlockStateId({ x: 0, y: 0, z: 0 }), java.blocksByName.glass.defaultState)
})
