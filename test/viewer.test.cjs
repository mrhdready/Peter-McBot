const { test } = require('node:test')
const assert = require('node:assert/strict')
const { once } = require('node:events')
const { Worker } = require('node:worker_threads')
const path = require('node:path')
const fs = require('node:fs')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { ViewerMapping, VIEWER_VERSION, viewerPose } = require('../dist/viewer-mapping.js')
const { WorldState } = require('../dist/state.js')
const { createWebServer } = require('../dist/web.js')
const { io } = require('socket.io-client')
const { viewerEntity } = require('../dist/entities.js')
const { viewerEntities, MAX_VIEWER_ENTITIES, viewerItems, MAX_VIEWER_ITEMS } = require('../dist/viewer-stream.js')

const bedrock = require('prismarine-registry')('bedrock_1.26.60')
const java = require('minecraft-data')(VIEWER_VERSION)
const Block = require('prismarine-block')(VIEWER_VERSION)
const Chunk = require('prismarine-chunk')(VIEWER_VERSION)
const mapping = new ViewerMapping('1.26.60')
const id = name => bedrock.blocksByName[name].defaultState
const section = () => ({ data: new Uint32Array(8192).fill(id('air')) })
const column = () => ({ x: -1, z: 0, sections: new Map(), announced: true, attempts: new Map(), requests: new Map() })
const mob = (type, x, z, extra = {}) => ({ uniqueId: '-' + x, type, position: { x, y: 64, z }, yaw: 90, headYaw: 45, pitch: 10, living: true, name: '', flags: new Set(), ...extra })

test('viewer starts mesh workers in a browser without Node globals', () => {
  const rendererPath = require.resolve('prismarine-viewer/viewer/lib/worldrenderer')
  const workers = []
  const browser = vm.createContext({
    window: {}, module: { exports: {} }, require: createRequire(rendererPath),
    Worker: class { constructor (url) { workers.push(url) } }
  })
  assert.equal(vm.runInContext('typeof __dirname', browser), 'undefined')
  vm.runInContext(fs.readFileSync(rendererPath, 'utf8'), browser, { filename: rendererPath })
  const { WorldRenderer } = browser.module.exports
  const renderer = new WorldRenderer(new (require('three').Scene)())
  assert.equal(renderer.workers.length, 4)
  assert.deepEqual(workers, Array(4).fill('/viewer/worker.js'))
})

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

test('viewer maps blocks newer than Java 1.21.4 and draws Bedrock chests as single chests', () => {
  assert.equal(VIEWER_VERSION, '1.21.11')
  const copper = Block.fromStateId(mapping.stateId(id('copper_chest')), 1)
  assert.equal(copper.name, 'copper_chest')
  assert.equal(copper.getProperties().type, 'single')
  assert.equal(Block.fromStateId(mapping.stateId(id('chest')), 1).getProperties().type, 'single')
  assert.equal(require('prismarine-viewer/viewer/lib/version').getVersion(VIEWER_VERSION), VIEWER_VERSION)
})

test('viewer maps Bedrock-only variants to the closest table entry and poplar to birch', () => {
  const state = (name, props) => bedrock.blockStates.findIndex(s => s.name === name &&
    Object.entries(props).every(([key, value]) => String(s.states[key]?.value ?? s.states[key]) === String(value)))
  const toJava = i => Block.fromStateId(mapping.stateId(i), 1)
  assert.equal(toJava(state('pumpkin', { 'minecraft:cardinal_direction': 'south' })).name, 'pumpkin')
  const bamboo = toJava(state('bamboo', { age_bit: 1, bamboo_leaf_size: 'large_leaves', bamboo_stalk_thickness: 'thick' }))
  assert.equal(bamboo.name, 'bamboo')
  assert.equal(bamboo.getProperties().leaves, 'large')
  const log = toJava(state('poplar_log', { pillar_axis: 'x' }))
  assert.equal(log.name, 'birch_log')
  assert.equal(log.getProperties().axis, 'x')
  assert.equal(toJava(state('red_poplar_leaves', { persistent_bit: 0 })).name, 'birch_leaves')
  assert.equal(mapping.issue(state('poplar_log', { pillar_axis: 'z' })), null)
  // Every block the table lists gets a translation; its target may still be newer than Java 1.21.11 (no-java-block).
  const data = require('minecraft-data/data.js').bedrock['1.26.60'].blocksB2J
  const listed = new Set(Object.keys(data).map(key => key.slice(0, key.indexOf('[')).replace(/^minecraft:/, '')))
  const unmapped = bedrock.blockStates.filter((s, i) => mapping.issue(i) === 'no-translation' && listed.has(s.name)).map(s => s.name)
  assert.deepEqual([...new Set(unmapped)], [])
  // Live value with minecraft-data 3.119.0 (Bedrock 1.26.60 → Java 1.21.11); a rise means a mapping regression.
  assert.ok(mapping.missing <= 3427, `${mapping.missing} Bedrock states unmapped`)
})

test('viewer diagnosis reports fallback states with reason and world position', async () => {
  const withModels = new ViewerMapping('1.26.60', new Set(['stone']))
  assert.equal(withModels.issue(id('stone')), null)
  assert.equal(withModels.issue(id('grass_block')), 'no-model')
  assert.ok(['no-translation', 'no-java-block'].includes(withModels.issue(id('hard_pink_stained_glass'))))
  assert.match(withModels.describe(id('hard_pink_stained_glass')), /^hard_pink_stained_glass\[/)
  assert.ok(withModels.withoutModel > 0)
  const c = column(); const s = section()
  s.data[(1 << 8) | (2 << 4) | 3] = id('hard_pink_stained_glass')
  s.data[0] = id('stone')
  c.sections.set(-4, s)
  const issues = []
  await withModels.column(c, () => false, (state, x, y, z) => issues.push([state, x, y, z]))
  assert.deepEqual(issues, [[id('hard_pink_stained_glass'), -16 + 1, -64 + 2, 3]])
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
  const html = await page.text()
  assert.match(html, /id="world-view"/)
  assert.match(html, /id="viewer-invert-x" type="checkbox" role="switch"/)
  assert.match(html, /id="viewer-invert-y" type="checkbox" role="switch"/)
})

test('viewer socket streams the bot identity and other players with viewer-space look', { timeout: 15000 }, async t => {
  const world = new WorldState(4)
  world.status = 'spawned'; world.position = { x: 0, y: 65.62, z: 0 }
  world.players.set('20', { name: 'Alex', position: { x: 5, y: 65.62, z: -3 }, uniqueId: '-5', uuid: 'u', yaw: 90, pitch: 30 })
  world.players.set('21', { name: 'Bob', position: { x: 1, y: 64, z: 1 }, uniqueId: '-6', uuid: 'v' })
  world.entities.set('30', mob('horse', 2, 2, { width: 1.4, height: 1.6 }))
  world.items.set('40', { uniqueId: '-40', name: 'minecraft:wheat_seeds', count: 3, position: { x: 1, y: 64.125, z: 2 } })
  const bot ={ state: world, username: 'Peter', conditions: { selfSleeping: true }, farm: { status: () => ({}) }, collector: { status: () => ({}) } }
  const web = createWebServer(bot)
  t.after(() => web.close())
  web.server.listen(0, '127.0.0.1'); await once(web.server, 'listening')
  const socket = io(`http://127.0.0.1:${web.server.address().port}`, { path: '/api/viewer/socket', transports: ['websocket'], reconnection: false })
  t.after(() => socket.disconnect())
  const [data] = await once(socket, 'position')
  assert.equal(data.session, world.worldSession)
  assert.deepEqual(data.position, world.position)
  assert.deepEqual(data.self, { name: 'Peter', sleeping: true })
  assert.deepEqual(data.entities, JSON.parse(JSON.stringify(viewerEntities(world))), 'mobs ride in the same packet')
  assert.equal(data.entities[0].type, 'horse')
  assert.deepEqual(data.items, [{ id: '40', name: 'wheat_seeds', count: 3, position: { x: 1, y: 64.125, z: 2 } }], 'items ride in the same packet')
  // The expectation goes through JSON like the socket payload (-0 becomes 0).
  assert.deepEqual(data.players, JSON.parse(JSON.stringify([
    { id: '20', name: 'Alex', ...viewerPose({ x: 5, y: 65.62, z: -3 }, 90, 30) },
    { id: '21', name: 'Bob', ...viewerPose({ x: 1, y: 64, z: 1 }, 0, 0) }
  ])))
  world.players.delete('20')
  const [later] = await once(socket, 'position')
  assert.deepEqual(later.players.map(player => player.id), ['21'])
})

test('viewer entity look comes from server bounding box, minecraft-data or a fallback and skips non-mobs', () => {
  const logs = []
  const log = console.log
  console.log = line => logs.push(line)
  try {
    assert.deepEqual(viewerEntity(mob('horse', 0, 0, { width: 1.4, height: 1.6 })), { category: 'passive', width: 1.4, height: 1.6 })
    assert.deepEqual(viewerEntity(mob('zombie', 0, 0)), { category: 'hostile', width: 0.6, height: 1.8 })
    assert.deepEqual(viewerEntity(mob('chicken', 0, 0, { flags: new Set(['baby']) })), { category: 'passive', width: 0.2, height: 0.35 }, 'data sizes are halved for babies')
    // Live: a baby chicken reports the adult bounding box; the server's scale shrinks it, else babies are halved.
    assert.deepEqual(viewerEntity(mob('chicken', 0, 0, { flags: new Set(['baby']), width: 0.6, height: 0.8, scale: 0.25 })), { category: 'passive', width: 0.15, height: 0.2 })
    assert.deepEqual(viewerEntity(mob('chicken', 0, 0, { flags: new Set(['baby']), width: 0.6, height: 0.8 })), { category: 'passive', width: 0.3, height: 0.4 })
    assert.deepEqual(viewerEntity(mob('chicken', 0, 0, { width: 0.6, height: 0.8, scale: 1 })), { category: 'passive', width: 0.6, height: 0.8 })
    // Missing from the 1.21.80 entity list that minecraft-data serves for 1.26.60.
    assert.deepEqual(viewerEntity(mob('trader_llama', 0, 0, { width: 0.9, height: 1.87 })), { category: 'passive', width: 0.9, height: 1.87 })
    assert.deepEqual(viewerEntity(mob('copper_golem', 0, 0)), { category: 'other', width: 0.8, height: 0.8 })
    assert.deepEqual(viewerEntity(mob('chest_boat', 0, 0, { living: false })), { category: 'other', width: 0.8, height: 0.8 }, 'boats are drawn')
    assert.equal(viewerEntity(mob('leash_knot', 0, 0, { living: false })), null)
    assert.equal(viewerEntity(mob('arrow', 0, 0, { living: false })), null)
    assert.equal(viewerEntity(mob('xp_orb', 0, 0, { living: false })), null)
    assert.equal(viewerEntity(mob('future_projectile', 0, 0, { living: false })), null, 'unknown types without health are skipped')
    viewerEntity(mob('copper_golem', 0, 0))
  } finally { console.log = log }
  assert.equal(logs.filter(line => line === '[viewer] unknown entity type minecraft:copper_golem').length, 1, 'unknown types are logged once')
})

test('viewer entities are limited to the live radius and the nearest ones, in viewer space', () => {
  const world = new WorldState(4)
  assert.deepEqual(viewerEntities(world), [], 'nothing without a bot position')
  world.position = { x: 0, y: 65.62, z: 0 }
  world.entities.set('1', mob('cow', 3, 4, { name: 'Berta', flags: new Set(['baby']) }))
  world.entities.set('2', mob('cow', 70, 0))
  world.entities.set('3', mob('leash_knot', 1, 1, { living: false }))
  const [cow] = viewerEntities(world)
  assert.deepEqual(viewerEntities(world).map(entity => entity.id), ['1'], 'outside the radius and non-mobs are dropped')
  const pose = viewerPose({ x: 3, y: 64, z: 4 }, 90, 10)
  assert.deepEqual(cow, { id: '1', type: 'cow', category: 'passive', width: 0.45, height: 0.7, baby: true, name: 'Berta',
    position: pose.position, yaw: pose.yaw, headYaw: viewerPose(null, 45, 0).yaw, pitch: pose.pitch })
  for (let i = 0; i < MAX_VIEWER_ENTITIES + 10; i++) world.entities.set('n' + i, mob('pig', 10 + i * .1, 0))
  const drawn = viewerEntities(world)
  assert.equal(drawn.length, MAX_VIEWER_ENTITIES)
  assert.equal(drawn[0].id, '1', 'nearest first')
  assert.equal(drawn.at(-1).id, 'n' + (MAX_VIEWER_ENTITIES - 2))
})

test('viewer items are limited to the live radius and the nearest ones, without the minecraft prefix', () => {
  const world = new WorldState(4)
  const drop = (name, x, z, count = 1) => ({ uniqueId: '-' + x, name, count, position: { x, y: 64.125, z } })
  world.items.set('1', drop('minecraft:dirt', 3, 4, 5))
  assert.deepEqual(viewerItems(world), [], 'nothing without a bot position')
  world.position = { x: 0, y: 65.62, z: 0 }
  world.items.set('2', drop('minecraft:dirt', 70, 0))
  world.items.set('3', drop('#999', 1, 1))
  assert.deepEqual(viewerItems(world), [
    { id: '3', name: '#999', count: 1, position: { x: 1, y: 64.125, z: 1 } },
    { id: '1', name: 'dirt', count: 5, position: { x: 3, y: 64.125, z: 4 } }
  ], 'outside the radius is dropped, nearest first, unknown IDs keep their name')
  for (let i = 0; i < MAX_VIEWER_ITEMS + 10; i++) world.items.set('n' + i, drop('minecraft:wheat', 10 + i * .1, 0))
  for (let i = 0; i < MAX_VIEWER_ENTITIES; i++) world.entities.set('m' + i, mob('pig', 5, 0))
  const drawn = viewerItems(world)
  assert.equal(drawn.length, MAX_VIEWER_ITEMS, 'mobs do not count against the item limit')
  assert.equal(drawn.at(-1).id, 'n' + (MAX_VIEWER_ITEMS - 3))
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
