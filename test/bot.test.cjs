const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { BotController } = require('../dist/bot.js')
const { readConfig } = require('../dist/config.js')

const config = readConfig({ BEDROCK_HOST: 'localhost' })
class Client extends EventEmitter {
  entityId = 10n
  sent = []
  closed = false
  queue (name, params) { this.sent.push([name, params]) }
  close () { this.closed = true; this.emit('close') }
}
function setup () {
  let time = 1000
  const clients = []
  const bot = new BotController(config, () => {
    const client = new Client()
    clients.push(client)
    return client
  }, () => {}, () => time)
  return { bot, clients, advance: ms => { time += ms; bot.step() } }
}

test('commands wait for the tick; duplicate connect does not create another client', () => {
  const { bot, clients } = setup()
  bot.enqueue('connect')
  assert.equal(clients.length, 0)
  bot.step()
  bot.enqueue('connect')
  bot.step()
  assert.equal(clients.length, 1)
  clients[0].emit('start_game', { player_position: { x: -3, y: 64, z: 5 }, dimension: 0 })
  clients[0].emit('spawn')
  assert.equal(bot.state.status, 'spawned')
  assert.equal(bot.state.position.x, -3)
  assert.deepEqual(clients[0].sent, [['request_chunk_radius', { chunk_radius: 4, max_radius: 4 }]])
  const snapshot = bot.state.snapshot()
  snapshot.position.x = 900
  assert.equal(bot.state.position.x, -3)
  clients[0].emit('server_post_move', { position: { x: -3, y: 72, z: 5 } })
  assert.equal(bot.state.position.y, 72)
  bot.stop()
})

test('disconnect cancels a scheduled reconnect and clears stale world data', () => {
  const { bot, clients, advance } = setup()
  bot.enqueue('connect'); bot.step()
  bot.state.chunks.set('0:0:0', {})
  clients[0].emit('error', new Error('network lost'))
  assert.equal(bot.state.status, 'reconnecting')
  assert.equal(bot.state.chunks.size, 0)
  advance(999)
  assert.equal(clients.length, 1)
  bot.enqueue('disconnect'); bot.step(); advance(60000)
  assert.equal(clients.length, 1)
  assert.equal(bot.state.status, 'disconnected')
  bot.stop()
})

test('retries are bounded, and a new manual connect resets the retry budget', () => {
  const { bot, clients, advance } = setup()
  bot.enqueue('connect'); bot.step()
  for (let attempt = 0; attempt < 5; attempt++) {
    clients.at(-1).emit('error', new Error('offline'))
    if (attempt < 4) advance(30000)
  }
  assert.equal(bot.state.status, 'error')
  advance(60000)
  assert.equal(clients.length, 5)
  bot.enqueue('connect'); bot.step()
  assert.equal(clients.length, 6)
  bot.stop()
})

test('a stalled login is timed out, and old client events cannot replace new state', () => {
  const { bot, clients, advance } = setup()
  bot.enqueue('connect'); bot.step()
  advance(30000)
  assert.equal(bot.state.status, 'reconnecting')
  advance(1000)
  clients[0].emit('spawn')
  assert.equal(bot.state.status, 'connecting')
  bot.stop()
})

test('death prevents automatic reconnection; other entities do not move the bot', () => {
  const { bot, clients, advance } = setup()
  bot.enqueue('connect'); bot.step()
  const client = clients[0]
  client.emit('start_game', { player_position: { x: 0, y: 64, z: 0 }, dimension: 0 })
  client.emit('respawn', { state: 0 })
  assert.equal(bot.state.status, 'connecting', 'Respawn search during login is not a death notification')
  client.emit('respawn', { state: 1, position: { x: 0, y: 72.62, z: 0 } })
  assert.equal(bot.state.position.y, 72.62)
  assert.deepEqual(client.sent.at(-1), ['respawn', { position: { x: 0, y: 72.62, z: 0 }, state: 2, runtime_entity_id: 10n }])
  client.emit('respawn', { state: 1, position: { x: 0, y: 100, z: 0 } })
  assert.equal(bot.state.position.y, 72.62, 'Initial spawn is acknowledged only once')
  client.emit('move_player', { runtime_id: 11n, position: { x: 99, y: 1, z: 99 } })
  assert.equal(bot.state.position.x, 0)
  client.emit('entity_event', { runtime_entity_id: 10n, event_id: 'death_animation' })
  assert.equal(bot.state.status, 'dead')
  advance(60000)
  assert.equal(clients.length, 1)
  assert.equal(client.closed, true)
  bot.stop()
})

test('only one heartbeat runs; shutdown stops it and rejects more commands', async () => {
  const { bot } = setup()
  bot.start(); bot.start()
  const timer = bot.timer
  assert.ok(timer)
  bot.start()
  assert.equal(bot.timer, timer)
  bot.stop()
  const tick = bot.state.tick
  await new Promise(resolve => setTimeout(resolve, 70))
  assert.equal(bot.state.tick, tick)
  assert.equal(bot.enqueue('connect'), false)
})

test('zero health stops the bot without an automatic respawn', () => {
  const { bot, clients, advance } = setup()
  bot.enqueue('connect'); bot.step()
  clients[0].emit('set_health', { health: 20 })
  assert.equal(bot.state.status, 'connecting')
  clients[0].emit('set_health', { health: 0 })
  assert.equal(bot.state.status, 'dead')
  advance(60000)
  assert.equal(clients.length, 1)
  assert.equal(clients[0].sent.some(([name]) => name === 'respawn'), false)
  bot.stop()
})

test('configuration rejects invalid input', () => {
  assert.throws(() => readConfig({}), /BEDROCK_HOST/)
  assert.throws(() => readConfig({ BEDROCK_HOST: 'localhost', BEDROCK_PORT: 'NaN' }), /BEDROCK_PORT/)
  assert.throws(() => readConfig({ BEDROCK_HOST: 'localhost', CHUNK_RADIUS: '3' }), /CHUNK_RADIUS/)
  assert.throws(() => readConfig({ BEDROCK_HOST: 'localhost', BEDROCK_TRANSPORT: 'http' }), /TRANSPORT/)
  assert.throws(() => readConfig({ BEDROCK_HOST: 'localhost', BEDROCK_ICE_HOST: 'not-an-ip' }), /ICE_HOST/)
  assert.equal(readConfig({ BEDROCK_HOST: 'localhost', BEDROCK_ICE_HOST: '192.0.2.10' }).iceHost, '192.0.2.10')
})

test('protocol events populate the world, apply block batches and clear it on dimension change', { timeout: 10000 }, async t => {
  const { bot, clients } = setup()
  t.after(() => bot.stop())
  bot.enqueue('connect'); bot.step()
  const client = clients[0]
  client.emit('start_game', { player_position: { x: 0, y: 64, z: 0 }, dimension: 'overworld', block_network_ids_are_hashes: true })
  client.emit('spawn')
  client.emit('level_chunk', { x: 0, z: 0, dimension: 0, cache_enabled: false })
  const waitFor = async predicate => {
    const end = Date.now() + 5000
    while (!predicate()) {
      assert.ok(Date.now() < end, 'World worker timed out')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  await waitFor(() => bot.state.coverage().ready)
  bot.step()
  assert.ok(client.sent.some(([name]) => name === 'subchunk_request'))
  const fixture = require('./fixtures/bedrock-1.26.65-subchunk.json')
  client.emit('subchunk', { dimension: 0, cache_enabled: false, origin: { x: 0, y: 0, z: 0 },
    entries: [{ dx: 0, dy: 0, dz: 0, result: 'success', payload: Buffer.from(fixture.payload, 'base64') }] })
  await waitFor(() => bot.state.coverage().knownSubchunks === 1)
  assert.ok((await bot.searchBlocks('stone', 2)).hits.length > 0)
  const registry = require('prismarine-registry')('bedrock_1.26.60')
  registry.handleStartGame({ itemstates: [], block_network_ids_are_hashes: true })
  const hash = name => Number(Object.entries(registry.blocksByRuntimeId).find(([, block]) => block.stateId === registry.blocksByName[name].defaultState)[0]) >>> 0
  client.emit('update_subchunk_blocks', { x: 0, y: 0, z: 0,
    blocks: [{ position: { x: 1, y: 2, z: 3 }, runtime_id: hash('diamond_ore') }],
    extra: [{ position: { x: 1, y: 2, z: 3 }, runtime_id: hash('water') }] })
  assert.ok((await bot.searchBlocks('diamond_ore', 10)).hits.some(p => p.x === 1 && p.y === 2 && p.z === 3))
  client.emit('change_dimension', { dimension: 1 })
  assert.equal(bot.state.coverage().knownSubchunks, 0)
  assert.equal(bot.state.coverage().ready, false)
})

test('navigation starts on the central tick; stop cancels queued starts and death ends all inputs', () => {
  const { bot, clients, advance } = setup()
  bot.enqueue('connect'); bot.step()
  const client = clients[0]
  client.emit('start_game', { player_position: { x: .5, y: 72.62, z: .5 }, dimension: 0 })
  client.emit('spawn')
  const { Terrain } = require('../dist/terrain.js')
  bot.state.terrain = new Terrain((x,y,z) => Math.abs(x) < 10 && Math.abs(z) < 10 ? { boxes: y === 70 ? [[0,0,0,1,1,1]] : [], support: y === 70 } : null)
  bot.state.chunks.set('0:0', { x:0, z:0, sections:new Map(), attempts:new Map(), requests:new Map() })
  assert.equal(bot.enqueue({ type: 'navigate', x: 3, z: 0 }), true)
  assert.equal(bot.state.navigation.status, 'idle')
  for (let i=0;i<20 && ['idle','planning'].includes(bot.state.navigation.status);i++) advance(50)
  assert.equal(bot.state.navigation.status, 'moving')
  advance(50); advance(50)
  assert.ok(client.sent.some(([name]) => name === 'player_auth_input'))
  bot.enqueue({ type: 'navigate', x: -3, z: 0 })
  bot.enqueue('stop_navigation'); advance(50)
  assert.equal(bot.state.navigation.status, 'stopped')
  assert.equal(client.sent.filter(([name]) => name === 'player_auth_input').at(-1)[1].move_vector.z, 0)
  const count = client.sent.length
  advance(50); advance(50)
  assert.equal(client.sent.length, count)
  bot.enqueue({ type: 'navigate', x: 4, z: 0 }); advance(50); advance(50)
  for (let i = 0; i < 32; i++) assert.equal(bot.enqueue('connect'), true)
  assert.equal(bot.enqueue('stop_navigation'), true, 'Stop has a reserved slot even when the normal queue is full')
  advance(50)
  assert.equal(bot.state.navigation.status, 'stopped')
  bot.enqueue({ type: 'navigate', x: 4, z: 0 }); advance(50); advance(50)
  client.emit('set_health', { health: 0 })
  const deathCount = client.sent.length
  advance(1000)
  assert.equal(client.sent.length, deathCount)
  assert.equal(bot.state.status, 'dead')
  assert.equal(bot.enqueue({ type: 'navigate', x: NaN, z: 0 }), false)
  bot.stop()
})

test('initial loading screen sends both protocol-2225 edges once, regardless of spawn packet order', () => {
  for (const spawnFirst of [false, true]) {
    const { bot, clients } = setup()
    bot.enqueue('connect'); bot.step()
    const client = clients[0]
    client.emit('start_game', { player_position: { x: .5, y: 32769.62, z: .5 }, dimension: 0 })
    if (spawnFirst) client.emit('spawn')
    client.emit('respawn', { state: 1, position: { x: .5, y: 72.62, z: .5 } })
    if (!spawnFirst) client.emit('spawn')
    client.emit('spawn')
    client.emit('respawn', { state: 1, position: { x: .5, y: 100, z: .5 } })
    assert.deepEqual(client.sent.filter(([name]) => name === 'serverbound_loading_screen').map(([, packet]) => packet), [
      { type: 1, loading_screen_id: undefined }, { type: 2, loading_screen_id: undefined }
    ])
    bot.stop()
  }
})
