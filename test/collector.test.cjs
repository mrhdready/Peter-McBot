const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { BotController } = require('../dist/bot.js')
const { readConfig } = require('../dist/config.js')
const { Terrain } = require('../dist/terrain.js')
const { itemFilter } = require('../dist/item-collection.js')
const { RoutePlanner } = require('../dist/pathfinder.js')

const item = (id, count = 1) => ({ network_id: id, count, metadata: 0, has_stack_id: true, stack_id: 10 + id })
function setup (t) {
  let now = 1000
  let bot
  const pickups = []
  const clients = []
  class Client extends EventEmitter {
    entityId = 10n
    queue (name, packet) {
      if (name !== 'player_auth_input') return
      for (const [id, drop] of bot.state.items) {
        if (Math.floor(packet.position.x) === Math.floor(drop.position.x) && Math.floor(packet.position.z) === Math.floor(drop.position.z) && Math.abs(packet.position.y - 1.62 - drop.position.y) < 1) {
          pickups.push(id)
          this.emit('take_item_entity', { runtime_entity_id: id, target: this.entityId })
        }
      }
    }
    close () {}
  }
  bot = new BotController(readConfig({ BEDROCK_HOST: 'localhost' }), () => { const client = new Client(); clients.push(client); return client }, () => {}, () => now)
  t.after(() => bot.stop())
  function spawn () {
    const client = clients.at(-1)
    client.emit('start_game', { player_position: { x: .5, y: 72.62, z: .5 }, dimension: 0 })
    client.emit('spawn')
    client.emit('item_registry', { itemstates: [{ name: 'minecraft:wheat', runtime_id: 1 }, { name: 'minecraft:dirt', runtime_id: 2 }] })
    client.emit('inventory_content', { window_id: 'inventory', input: Array(36).fill({ network_id: 0 }) })
    bot.state.terrain = new Terrain((x, y, z) => Math.abs(x) < 30 && Math.abs(z) < 30 ? { boxes: y === 70 ? [[0, 0, 0, 1, 1, 1]] : [], support: y === 70 } : null)
    bot.state.planningTerrain = bot.state.terrain
    for (const x of [-2, -1, 0, 1]) for (const z of [-2, -1, 0, 1]) bot.state.chunks.set(x + ':' + z, { x, z, sections: new Map(), attempts: new Map(), requests: new Map() })
  }
  bot.enqueue('connect'); bot.step(); spawn()
  const tick = async (ms = 50) => { now += ms; bot.step(); await new Promise(resolve => setImmediate(resolve)) }
  const run = async (done, limit = 1500) => { for (let i = 0; i < limit && !done(); i++) await tick(); assert.ok(done(), bot.collector.status().activity) }
  const drop = (id, x, name = 1, y = 71.2, z = .5) => clients.at(-1).emit('add_item_entity', { runtime_entity_id: id, entity_id_self: 'unique-' + id, item: item(name), position: { x, y, z } })
  const start = name => bot.collector.start({ x: .5, z: .5, label: 'Basis' }, name)
  return { bot, clients, spawn, tick, run, drop, start, pickups, now: () => now }
}

test('collector waits for new drops, filters exactly, respects anchor radius, picks up and returns', async t => {
  const { bot, start, drop, run, pickups, tick } = setup(t)
  assert.equal(start('minecraft:wheat'), null)
  await run(() => bot.collector.status().activity === 'Wartet auf Drops')
  assert.equal(bot.collector.status().enabled, true)
  drop('1', 4.5); drop('2', 8.5, 2); drop('3', 25.5)
  await run(() => pickups.includes('1') && bot.collector.status().activity === 'Wartet auf Drops')
  assert.deepEqual(pickups, ['1'])
  assert.equal(Math.floor(bot.state.position.x), 0)
  assert.equal(Math.floor(bot.state.position.z), 0)
  assert.equal(bot.state.items.size, 2)
  assert.equal(bot.farm.status().enabled, false)
  bot.state.items.delete('3')
  assert.equal(start(), null)
  await tick()
  await run(() => pickups.includes('2') && bot.collector.status().activity === 'Wartet auf Drops')
  assert.equal(bot.collector.status().item, null)
})

test('collector returns to anchor with full inventory and resumes when a slot is freed', async t => {
  const { bot, start, drop, run, tick, pickups, clients } = setup(t)
  bot.state.position = { x: 3.5, y: 72.62, z: .5 }
  clients[0].emit('inventory_content', { window_id: 0, input: Array(36).fill(item(2, 64)) })
  drop('1', 5.5)
  start()
  await run(() => bot.collector.status().activity === 'Pausiert (Inventar voll)')
  assert.equal(Math.floor(bot.state.position.x), 0)
  assert.deepEqual(pickups, [])
  await tick(2000)
  assert.match(bot.collector.status().activity, /Inventar voll/)
  bot.state.inventory.setSlot(0, { network_id: 0 })
  await run(() => pickups.includes('1'))
})

test('off cancels queued navigation and stops an active collector immediately', async t => {
  const { bot, start, drop, tick } = setup(t)
  drop('1', 8.5); start(); await tick()
  assert.equal(bot.collector.status().activity, 'Läuft zum Drop')
  bot.collector.off(); await tick()
  assert.notEqual(bot.state.navigation.status, 'moving')
  assert.equal(bot.state.position.x, .5)
  start(); await tick(); await tick()
  assert.ok(['moving', 'planning'].includes(bot.state.navigation.status))
  bot.collector.off()
  assert.equal(bot.state.navigation.status, 'stopped')
  const stopped = { ...bot.state.position }
  for (let i = 0; i < 5; i++) await tick()
  assert.deepEqual(bot.state.position, stopped)
})

test('manual pause invalidates pending collector commands; repeated pause extends the deadline', async t => {
  const { bot, start, drop, tick, now } = setup(t)
  drop('1', 8.5); start(); await tick()
  bot.collector.pause()
  bot.enqueue({ type: 'navigate', x: 3, z: 0, origin: { player: 'Alex', label: 'Ziel' } })
  await tick()
  assert.equal(bot.state.navigation.target.x, 3)
  assert.equal(bot.collector.status().pausedUntil, now() - 50 + 60000)
  await tick(10000); bot.collector.pause()
  const until = bot.collector.status().pausedUntil
  assert.equal(until, now() + 60000)
  await tick(59000)
  assert.match(bot.collector.status().activity, /Pausiert/)
  await tick(1001)
  assert.equal(bot.collector.status().pausedUntil, null)
  assert.equal(bot.collector.status().enabled, true)
})

test('farm, UI navigation and stop disable collector; stale farm targets cannot replace collector', async t => {
  const { bot, start, drop, tick } = setup(t)
  start(); bot.farm.start({ x: .5, z: .5, label: 'Feld' })
  assert.equal(bot.collector.status().enabled, false)
  assert.equal(bot.farm.status().enabled, true)
  start()
  assert.equal(bot.farm.status().enabled, false)
  drop('1', 8.5); await tick()
  bot.enqueue({ type: 'navigate', x: 2, z: 0 }); await tick()
  assert.equal(bot.collector.status().enabled, false)
  assert.equal(bot.state.navigation.target.x, 2)
  start(); await tick(); bot.enqueue('stop_navigation'); await tick()
  assert.equal(bot.collector.status().enabled, false)
  assert.equal(bot.state.navigation.status, 'stopped')
})

test('unreachable drops are skipped for 30 seconds while other drops are collected', async t => {
  const { bot, start, drop, tick, run, pickups } = setup(t)
  bot.state.chunks.delete('1:0')
  drop('1', 16.5); start(); await tick(); await tick(); await tick()
  assert.equal(bot.collector.status().enabled, true)
  drop('2', 4.5)
  await run(() => pickups.includes('2'))
  assert.ok(bot.state.items.has('1'))
  for (let i = 0; i < 10; i++) await tick()
  assert.notEqual(bot.state.navigation.target?.x, 16)
  await tick(30000)
  await run(() => bot.state.navigation.target?.x === 16)
})

test('vanished drops stop collection navigation and live snapshots discard removed entities', async t => {
  const { bot, start, drop, tick, clients } = setup(t)
  drop('1', 8.5); start(); await tick(); await tick()
  assert.equal(bot.state.snapshot().items[0].name, 'minecraft:wheat')
  clients[0].emit('remove_entity', { entity_id_self: 'unique-1' })
  await tick()
  assert.equal(bot.state.snapshot().items.length, 0)
  assert.equal(bot.state.navigation.status, 'stopped')
  assert.equal(bot.collector.status().enabled, true)
})

test('disconnect retains collector anchor/filter and clears stale drops; spawn resumes collection', async t => {
  const { bot, start, drop, tick, clients, spawn, run, pickups } = setup(t)
  drop('1', 8.5); start('wheat'); await tick(); await tick()
  clients[0].emit('close')
  assert.equal(bot.collector.status().activity, 'Wartet auf Verbindung')
  assert.equal(bot.collector.status().item, 'wheat')
  assert.equal(bot.state.items.size, 0)
  await tick(1000); spawn(); drop('2', 3.5)
  await run(() => pickups.includes('2'))
  assert.deepEqual(bot.collector.status().anchor, { x: .5, z: .5, label: 'Basis' })
})

test('invalid item filters leave the current job untouched and Minecraft namespace alone is optional', t => {
  const { bot, start } = setup(t)
  start('wheat')
  assert.match(start('<script>'), /Ungültige/)
  assert.equal(bot.collector.status().item, 'wheat')
  assert.equal(itemFilter('minecraft:wheat'), 'wheat')
  assert.equal(itemFilter('addon:wheat'), 'addon:wheat')
  assert.equal(itemFilter('WHEAT'), 'wheat')
  for (const value of [42, {}, [], 'x'.repeat(111), 'a b']) assert.throws(() => itemFilter(value))
})

test('height-aware planner traverses a ramp to a drop more than three blocks above the anchor', t => {
  const { bot, start, drop } = setup(t)
  const world = bot.state
  world.terrain = new Terrain((x, y, z) => {
    if (x < 0 || x > 5 || z !== 0) return null
    const floor = 70 + x
    return { boxes: y <= floor ? [[0, 0, 0, 1, 1, 1]] : [], support: y <= floor }
  })
  world.planningTerrain = world.terrain
  const planner = new RoutePlanner(world, world.position, { x: 5, z: 0, y: 76.2 })
  let path = null
  for (let i = 0; i < 200 && !path; i++) path = planner.step()
  assert.equal(path.at(-1).y, 76)
  drop('high', 5.5, 1, 76.2)
  start()
  bot.step()
  assert.equal(bot.commands[0].y, 76.2, 'Collector forwards the drop height without an anchor height cutoff')
})

test('height target does not accept another floor of the same X/Z column', t => {
  const { bot } = setup(t)
  const planner = new RoutePlanner(bot.state, bot.state.position, { x: 0, z: 0, y: 78 })
  assert.throws(() => { for (let i = 0; i < 2000; i++) planner.step() }, /Kein Weg|Suchlimit/)
})


test('absolute and delta entity movement update live item positions; obsolete clients cannot restore drops', async t => {
  const { bot, drop, clients, tick, spawn } = setup(t)
  drop('1', 8.5)
  clients[0].emit('move_entity', {runtime_entity_id:'1',position:{x:3.5,y:75.2,z:1.5}})
  clients[0].emit('move_entity_delta', {runtime_entity_id:'1',y:76.2})
  assert.deepEqual(bot.state.snapshot().items[0], {id:'1',name:'minecraft:wheat',count:1,x:3.5,y:76.2,z:1.5})
  clients[0].emit('close'); await tick(1000); spawn()
  clients[0].emit('add_item_entity', {runtime_entity_id:'old',item:item(1),position:{x:.5,y:71.2,z:.5}})
  assert.equal(bot.state.items.size, 0)
})


test('round summary totals confirmed pickups by item, includes incidental drops and stays silent while idle', async t => {
  const { bot, start, drop, run, tick, clients } = setup(t)
  const reports = []
  bot.collector.onReport = text => reports.push(text)
  start('wheat')
  drop('1', 4.5); drop('2', 4.5, 2)
  bot.state.items.get('1').count = 12
  bot.state.items.get('2').count = 3
  await run(() => bot.collector.status().lastSummary !== null)
  assert.equal(Math.floor(bot.state.position.x), 0, 'The round reports after returning to the anchor')
  assert.equal(bot.collector.status().lastSummary, 'Collector-Runde: 3 dirt, 12 wheat gesammelt.')
  assert.equal(reports.filter(text => text.startsWith('Collector-Runde:')).length, 1)
  // Duplicate pickup notifications and empty scans cannot add another report.
  clients[0].emit('take_item_entity', { runtime_entity_id:'1', target:10n })
  for (let i = 0; i < 5; i++) await tick(1000)
  assert.equal(reports.filter(text => text.startsWith('Collector-Runde:')).length, 1)
  drop('3', 3.5); drop('4', 5.5)
  await run(() => bot.collector.status().lastSummary === 'Collector-Runde: 2 wheat gesammelt.')
  assert.equal(reports.filter(text => text.startsWith('Collector-Runde:')).length, 2)
})

test('other players, despawns and paused pickups do not count; interrupted rounds report confirmed pickups once', async t => {
  const { bot, start, drop, tick, clients } = setup(t)
  const reports = []
  bot.collector.onReport = text => reports.push(text)
  const client = clients[0]
  start()
  drop('other', 6.5); client.emit('take_item_entity', {runtime_entity_id:'other',target:99n})
  drop('gone', 7.5); client.emit('remove_entity', {entity_id_self:'unique-gone'})
  drop('unknown', 8.5); client.emit('take_item_entity', {runtime_entity_id:'unknown'})
  await tick()
  assert.equal(bot.collector.status().lastSummary, null)
  drop('own', 2.5); client.emit('take_item_entity', {runtime_entity_id:'own',target:10})
  bot.collector.pause()
  assert.equal(bot.collector.status().lastSummary, 'Collector-Runde: 1 wheat gesammelt.')
  drop('manual', 2.5); client.emit('take_item_entity', {runtime_entity_id:'manual',target:10n})
  bot.collector.off()
  assert.equal(reports.filter(text => text.startsWith('Collector-Runde:')).length, 1)
})
