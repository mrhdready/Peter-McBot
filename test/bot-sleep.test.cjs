const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { BotController } = require('../dist/bot.js')
const { readConfig } = require('../dist/config.js')
const { Terrain } = require('../dist/terrain.js')
const flush = () => new Promise(resolve => setImmediate(resolve))

function setup (t) {
  let now = 1000
  const clients = []
  class Client extends EventEmitter {
    entityId = 10n
    sent = []
    queue (name, params) { this.sent.push({ name, params }) }
    close () { this.emit('close') }
  }
  const bot = new BotController(readConfig({ BEDROCK_HOST: 'localhost' }), () => { const client = new Client(); clients.push(client); return client }, () => {}, () => now)
  t.after(() => bot.stop())
  bot.enqueue('connect'); bot.step()
  const client = clients[0]
  client.emit('start_game', { player_position: { x: .5, y: 72.62, z: .5 }, dimension: 0 })
  client.emit('spawn')
  client.emit('inventory_content', { window_id: 'inventory', input: Array(36).fill({ network_id: 0 }) })
  const registry = require('prismarine-registry')('bedrock_1.26.60')
  const Block = require('prismarine-block')(registry)
  const bed = registry.blocksByName.bed
  const id = Array.from({ length: bed.maxStateId - bed.minStateId + 1 }, (_, i) => bed.minStateId + i)
    .find(id => { const p = Block.fromStateId(id, 0).getProperties(); return p.head_piece_bit === 1 && p.occupied_bit === 0 })
  bot.state.blockIds = () => ['minecraft:bed']
  const point = { x: 2, y: 71, z: 0, distance: 2 }
  bot.state.searchBlocks = async () => ({ hits: [point] })
  bot.state.stateIdAt = () => id; bot.state.blockNameAt = () => 'minecraft:bed'; bot.state.blockRuntimeIdAt = () => 777; bot.state.canSeeBlock = () => true
  bot.state.terrain = new Terrain((x, y, z) => Math.abs(x) < 30 && Math.abs(z) < 30 ? { boxes: y === 70 ? [[0, 0, 0, 1, 1, 1]] : [], support: y === 70 } : null)
  bot.state.planningTerrain = bot.state.terrain
  for (const x of [-1, 0, 1]) for (const z of [-1, 0, 1]) bot.state.chunks.set(x + ':' + z, { x, z, sections: new Map(), attempts: new Map(), requests: new Map() })
  const tick = async (ms = 50) => { now += ms; bot.step(); await flush() }
  const night = () => client.emit('set_time', { time: 14000 })
  const sleeping = value => client.emit('set_entity_data', { runtime_entity_id: 10n, metadata: [{ key: 'player_flags', value: value ? 2 : 0 }] })
  return { bot, client, tick, night, sleeping, point }
}

test('central heartbeat preserves a navigation goal and sends no movement while sleeping', async t => {
  const s = setup(t)
  s.bot.enqueue({ type: 'navigate', x: 8, z: 0 }); await s.tick()
  s.bot.sleep.configure({ enabled: true, onlyWithPlayers: false }); s.night()
  await s.tick(); await s.tick()
  assert.equal(s.bot.sleep.status().phase, 'clicking')
  s.sleeping(true); await s.tick()
  const count = s.client.sent.length
  await s.tick(10000)
  assert.equal(s.client.sent.length, count, 'Sleeping does not emit movement or work packets')
  s.sleeping(false); await s.tick()
  assert.equal(s.bot.sleep.active, false)
  assert.deepEqual(s.bot.state.navigation.target, { x: 8, z: 0 })
  assert.ok(['planning', 'moving', 'arrived'].includes(s.bot.state.navigation.status))
})

test('new navigation waits while sleeping and Stop discards the paused goal and queued jobs', async t => {
  const s = setup(t)
  s.bot.enqueue({ type: 'navigate', x: 8, z: 0 }); await s.tick()
  s.bot.sleep.configure({ enabled: true, onlyWithPlayers: false }); s.night()
  await s.tick(); await s.tick(); s.sleeping(true); await s.tick()
  s.bot.enqueue({ type: 'navigate', x: 9, z: 0 }); await s.tick()
  assert.notEqual(s.bot.state.navigation.target?.x, 9)
  s.bot.enqueue('stop_navigation'); await s.tick()
  assert.equal(s.bot.sleep.status().blocked, true)
  assert.equal(s.bot.sleep.status().phase, 'waking')
  s.sleeping(false); await s.tick()
  await s.tick(60000)
  assert.equal(s.bot.sleep.active, false)
  assert.notEqual(s.bot.state.navigation.target?.x, 9)
  assert.notEqual(s.bot.state.navigation.status, 'moving')
})

test('wake teleport above the floor settles before resuming the interrupted navigation', async t => {
  const s = setup(t)
  s.bot.enqueue({ type: 'navigate', x: 8, z: 0 }); await s.tick()
  s.bot.sleep.configure({ enabled: true, onlyWithPlayers: false }); s.night()
  await s.tick(); await s.tick(); s.sleeping(true); await s.tick()
  const position = { x: .5, y: 72.91, z: .5 }
  s.client.emit('move_player', { runtime_id: 10n, position, mode: 'teleport' })
  const count = s.client.sent.length
  await s.tick()
  assert.equal(s.client.sent.length, count, 'No gravity packets while sleeping')
  s.sleeping(false); await s.tick()
  assert.ok(s.bot.state.position.y < position.y)
  assert.deepEqual(s.bot.state.lastServerPosition, position)
  assert.equal(s.bot.state.navigation.status, 'planning')
  for (let i = 0; i < 300 && ['planning', 'moving'].includes(s.bot.state.navigation.status); i++) await s.tick()
  assert.equal(s.bot.state.navigation.status, 'arrived', s.bot.state.navigation.message)
  assert.deepEqual(s.bot.state.navigation.target, { x: 8, z: 0 })
})

test('far server sleep notice triggers but a nearby confirmed wake aborts the bed approach', async t => {
  const s = setup(t)
  s.bot.sleep.configure({ enabled: true, onlyWithPlayers: true }); s.night()
  await s.tick()
  assert.equal(s.bot.sleep.active, false)
  s.client.emit('text', { type: 'translation', needs_translation: true, message: 'chat.type.sleeping', parameters: ['Player', '1'] })
  await s.tick()
  assert.equal(s.bot.sleep.active, true)
  s.client.emit('add_player', { username: 'Player', runtime_id: 20n, unique_id: 200n, position: { x: 1, y: 72.62, z: 1 }, metadata: [{ key: 'player_flags', value: 0 }] })
  await s.tick()
  assert.equal(s.bot.sleep.active, false)
  assert.equal(s.client.sent.some(p => p.name === 'inventory_transaction'), false)
})

test('farther beds use the shared planner and navigation without resuming the interrupted task', async t => {
  const s = setup(t)
  s.point.x = 10; s.point.distance = 10
  s.bot.sleep.configure({ enabled: true, onlyWithPlayers: false }); s.night()
  await s.tick()
  for (let i = 0; i < 200 && s.bot.sleep.status().phase === 'searching'; i++) await s.tick()
  assert.equal(s.bot.sleep.status().phase, 'moving')
  for (let i = 0; i < 200 && s.bot.sleep.status().phase === 'moving'; i++) await s.tick()
  assert.equal(s.bot.sleep.status().phase, 'clicking')
  await s.tick()
  assert.equal(s.client.sent.some(p => p.name === 'inventory_transaction'), true)
  assert.ok(s.bot.state.position.x > 6)
})

test('Collector state survives the sleep pause and restarts from the current position after waking', async t => {
  const s = setup(t)
  assert.equal(s.bot.collector.start({ x: .5, z: .5, label: 'Basis' }), null)
  s.bot.sleep.configure({ enabled: true, onlyWithPlayers: false }); s.night()
  await s.tick(); await s.tick(); s.sleeping(true); await s.tick()
  assert.equal(s.bot.collector.status().enabled, true)
  assert.equal(s.bot.collector.status().activity, 'Pausiert (Schlafen)')
  s.sleeping(false); await s.tick()
  assert.equal(s.bot.collector.status().enabled, true)
  assert.deepEqual(s.bot.collector.status().anchor, { x: .5, z: .5, label: 'Basis' })
  assert.notEqual(s.bot.collector.status().activity, 'Pausiert (Schlafen)')
})

test('old client clock and sleep events cannot affect the reconnected world', async t => {
  const s = setup(t)
  s.night(); s.sleeping(true)
  s.bot.enqueue('disconnect'); await s.tick()
  s.client.emit('set_time', { time: 18000 }); s.sleeping(true)
  assert.equal(s.bot.conditions.time(10000), null)
  assert.equal(s.bot.conditions.selfSleeping, null)
})
