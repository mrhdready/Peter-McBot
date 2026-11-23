const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { BotController } = require('../dist/bot.js')
const { readConfig } = require('../dist/config.js')
const { Terrain } = require('../dist/terrain.js')

const config = readConfig({ BEDROCK_HOST: 'localhost', BOT_NAME: 'Peter Bot' })
const key = (x, y, z) => x + ':' + y + ':' + z
const flush = () => new Promise(resolve => setImmediate(resolve))
const item = (networkId, count, stackId) => ({ network_id: networkId, count, metadata: 0, has_stack_id: true, stack_id: stackId, block_runtime_id: 0, extra: { has_nbt: false, can_place_on: [], can_destroy: [] } })

// A bot on a flat floor (y=70, feet at 71) with stubbed crops. The fake server breaks a ripe crop on stop_break (and drops
// the queued items), hands drops to the bot when an input packet stands on their column, and plants the held seed after a top-face click.
function setup (t, { inventory = [item(300, 5, 11)] } = {}) {
  let time = 1000
  const crops = new Map()
  const drops = []
  const pickups = []
  let bot
  class FarmClient extends EventEmitter {
    entityId = 10n
    sent = []
    queue (name, params) {
      this.sent.push([name, params])
      if (name === 'player_auth_input') {
        for (const action of params.block_action ?? []) {
          const p = action.position
          if (action.action === 'stop_break' && crops.get(key(p.x, p.y, p.z))?.growth === 7) {
            crops.delete(key(p.x, p.y, p.z))
            for (const drop of drops.splice(0)) this.emit('add_item_entity', drop)
          }
        }
        for (const [id, entity] of bot.state.items) {
          if (Math.floor(entity.position.x) !== Math.floor(params.position.x) || Math.floor(entity.position.z) !== Math.floor(params.position.z)) continue
          pickups.push(id)
          this.emit('take_item_entity', { runtime_entity_id: BigInt(id), target: 10n })
        }
      }
      const data = name === 'inventory_transaction' ? params.transaction.transaction_data : null
      if (data?.action_type === 'click_block' && data.face === 1) crops.set(key(data.block_position.x, data.block_position.y + 1, data.block_position.z), { kind: data.held_item.network_id === 303 ? 'beetroot' : 'wheat', growth: 0 })
    }
    close () { this.emit('close') }
  }
  const clients = []
  bot = new BotController(config, () => { const client = new FarmClient(); clients.push(client); return client }, () => {}, () => time)
  t.after(() => bot.stop())
  bot.enqueue('connect'); bot.step()
  const client = clients[0]
  client.emit('start_game', { player_position: { x: .5, y: 72.62, z: .5 }, dimension: 0 })
  client.emit('spawn')
  client.emit('item_registry', { itemstates: [{ name: 'minecraft:wheat_seeds', runtime_id: 300 }, { name: 'minecraft:wheat', runtime_id: 301 }, { name: 'minecraft:dirt', runtime_id: 302 }, { name: 'minecraft:beetroot_seeds', runtime_id: 303 }, { name: 'minecraft:beetroot', runtime_id: 304 }] })
  client.emit('inventory_content', { window_id: 'inventory', input: Array.from({ length: 36 }, (_, i) => inventory[i] ?? { network_id: 0 }) })
  bot.state.terrain = new Terrain((x, y, z) => Math.abs(x) < 10 && Math.abs(z) < 10 ? { boxes: y === 70 ? [[0, 0, 0, 1, 1, 1]] : [], support: y === 70 } : null)
  bot.state.planningTerrain = bot.state.terrain
  bot.state.chunks.set('0:0', { x: 0, z: 0, sections: new Map(), attempts: new Map(), requests: new Map() })
  bot.state.cropAt = (x, y, z) => crops.get(key(x, y, z)) ?? null
  bot.state.blockNameAt = (x, y, z) => crops.has(key(x, y, z)) ? 'minecraft:wheat' : y === 70 ? 'minecraft:farmland' : 'minecraft:air'
  bot.state.blockRuntimeIdAt = () => 1
  let scans = 0
  bot.state.ripeCrops = async () => {
    scans++
    return [...crops].filter(([, crop]) => crop.growth === 7).map(([at, crop]) => { const [x, y, z] = at.split(':').map(Number); return { x, y, z, kind: crop.kind } })
  }
  const reports = []
  bot.farm.onReport = text => reports.push(text)
  // Runs ticks until `done` holds (or `limit` ticks passed); each tick lets the farm loop's promises settle.
  const run = async (done = () => false, limit = 2000) => {
    for (let i = 0; i < limit && !done(); i++) { time += 50; bot.step(); await flush() }
    return done()
  }
  const blockActions = () => client.sent.filter(([name, params]) => name === 'player_auth_input' && params.block_action).map(([, params]) => params.block_action.map(action => action.action))
  return { bot, client, clients, crops, drops, pickups, reports, run, blockActions, scans: () => scans, now: () => time }
}

test('one round harvests a 3×3 cluster with block actions, collects the drop, replants after abort_break and reports once', async t => {
  const { bot, client, crops, drops, pickups, reports, run, blockActions } = setup(t)
  crops.set(key(0, 71, 1), { kind: 'wheat', growth: 7 })
  crops.set(key(1, 71, 1), { kind: 'wheat', growth: 7 })
  crops.set(key(5, 71, 5), { kind: 'wheat', growth: 3 })
  drops.push({ runtime_entity_id: 50n, entity_id_self: 51n, item: { network_id: 300, count: 1 }, position: { x: 1.4, y: 71.2, z: 1.6 } })
  assert.equal(bot.farm.start({ x: .5, z: .5, label: 'Bot' }, true), null)
  assert.ok(await run(() => !bot.farm.status().enabled), 'The single round ends')
  assert.deepEqual(reports, ['Farming einmal: Bot, Radius 24.', '2 Weizen geerntet, 2 neu gepflanzt.', 'Farming aus (ein Durchgang erledigt).'])
  // Both crops are broken from the bot's own column (it reaches both), then replanted, each after abort_break.
  assert.deepEqual(blockActions(), [['start_break', 'predict_break'], ['stop_break'], ['start_break', 'predict_break'], ['stop_break'], ['abort_break'], ['abort_break']])
  const breakInput = client.sent.find(([name, params]) => name === 'player_auth_input' && params.block_action)[1]
  assert.ok(breakInput.input_data.includes('block_action'))
  assert.ok(breakInput.pitch > 0, 'The bot looks down at the crop')
  assert.deepEqual(pickups, ['50'], 'The drop is picked up by walking onto its column')
  assert.equal(bot.state.items.size, 0)
  const clicks = client.sent.filter(([name]) => name === 'inventory_transaction').map(([, params]) => params.transaction.transaction_data)
  assert.deepEqual(clicks.map(click => [click.block_position, click.face, click.hotbar_slot, click.click_pos]), [
    [{ x: 0, y: 70, z: 1 }, 1, 0, { x: .5, y: 1, z: .5 }], [{ x: 1, y: 70, z: 1 }, 1, 0, { x: .5, y: 1, z: .5 }]])
  assert.equal(clicks[0].held_item.stack_id, 11)
  const equipment = client.sent.filter(([name]) => name === 'mob_equipment').map(([, params]) => params)
  assert.equal(equipment.length, 1, 'The seed is selected once')
  assert.equal(equipment[0].selected_slot, 0)
  const names = client.sent.map(([name, params]) => name === 'player_auth_input' && params.block_action ? params.block_action[0].action : name)
  assert.ok(names.indexOf('mob_equipment') < names.indexOf('abort_break') && names.indexOf('abort_break') < names.indexOf('inventory_transaction'))
  assert.deepEqual(crops.get(key(0, 71, 1)), { kind: 'wheat', growth: 0 })
  assert.deepEqual(crops.get(key(1, 71, 1)), { kind: 'wheat', growth: 0 })
  assert.deepEqual(crops.get(key(5, 71, 5)), { kind: 'wheat', growth: 3 }, 'Unripe crops stay')
  assert.equal(bot.farm.status().lastSummary, '2 Weizen geerntet, 2 neu gepflanzt.')
})

test('without seed a harvested spot stays empty and is reported once; the summary counts it', async t => {
  const { bot, client, crops, reports, run } = setup(t, { inventory: [item(302, 3, 12)] })
  crops.set(key(1, 71, 1), { kind: 'wheat', growth: 7 })
  bot.farm.start({ x: .5, z: .5, label: 'Bot' }, true)
  assert.ok(await run(() => !bot.farm.status().enabled))
  assert.deepEqual(reports, ['Farming einmal: Bot, Radius 24.', 'Kein wheat_seeds zum Nachpflanzen; die Stellen bleiben leer.',
    '1 Weizen geerntet, 0 neu gepflanzt, 1 Stelle(n) ohne Saatgut.', 'Farming aus (ein Durchgang erledigt).'])
  assert.equal(crops.has(key(1, 71, 1)), false)
  assert.equal(client.sent.filter(([name]) => name === 'inventory_transaction').length, 0)
})

test('rounds repeat every 30 s; a chat pause delays the next one by a minute; UI navigation and stop switch farming off, chat targets do not', async t => {
  const { bot, reports, run, scans, now } = setup(t)
  bot.farm.start({ x: .5, z: .5, label: 'Bot' })
  assert.ok(await run(() => scans() === 1 && bot.farm.status().activity === 'Wartet auf reife Pflanzen', 20))
  const first = now()
  await run(() => now() - first >= 29000)
  assert.equal(scans(), 1)
  assert.ok(await run(() => scans() === 2, 60))
  bot.farm.pause()
  assert.equal(bot.farm.status().activity, 'Pausiert (Chat-Befehl)')
  const paused = now()
  await run(() => now() - paused >= 59000)
  assert.equal(scans(), 2, 'No round during the pause')
  assert.ok(await run(() => scans() === 3, 60))
  bot.enqueue({ type: 'navigate', x: 3, z: 3, origin: { player: 'Alex', label: 'Alex' } })
  await run(undefined, 1)
  assert.equal(bot.farm.status().enabled, true, 'A chat target does not end farming')
  bot.enqueue({ type: 'navigate', x: 3, z: 3 })
  await run(undefined, 1)
  assert.equal(bot.farm.status().enabled, false)
  assert.equal(reports.at(-1), 'Farming aus (UI-Navigation).')
  bot.farm.start({ x: .5, z: .5, label: 'Bot' })
  bot.enqueue('stop_navigation')
  await run(undefined, 1)
  assert.equal(reports.at(-1), 'Farming aus (Stopp).')
})

test('a disconnect ends the running action but keeps farming on; it continues after the next spawn', async t => {
  const { bot, clients, crops, run, scans } = setup(t)
  bot.farm.start({ x: .5, z: .5, label: 'Bot' })
  assert.ok(await run(() => scans() === 1, 20))
  clients[0].emit('close')
  assert.equal(bot.farm.status().enabled, true)
  assert.equal(bot.farm.status().activity, 'Wartet auf Verbindung')
  assert.equal(bot.state.items.size, 0)
  // Reconnect: the retry creates a new client; the round starts again once the inventory is known.
  assert.ok(await run(() => clients.length === 2, 100))
  const client = clients[1]
  client.emit('start_game', { player_position: { x: .5, y: 72.62, z: .5 }, dimension: 0 })
  client.emit('spawn')
  client.emit('item_registry', { itemstates: [{ name: 'minecraft:wheat_seeds', runtime_id: 300 }] })
  client.emit('inventory_content', { window_id: 'inventory', input: Array.from({ length: 36 }, (_, i) => i === 0 ? item(300, 5, 11) : { network_id: 0 }) })
  crops.clear()
  assert.ok(await run(() => scans() === 2, 20), 'Farming resumes after the spawn without waiting for the scan interval')
})

test('beetroot is replanted with its seeds and counts only seeds above 64 plus all fruit as surplus', async t => {
  const { bot, client, crops, reports, run } = setup(t, { inventory: [item(303, 64, 11), item(303, 1, 12), item(304, 8, 13)] })
  crops.set(key(1, 71, 1), { kind: 'beetroot', growth: 7 })
  crops.set(key(2, 71, 1), { kind: 'beetroot', growth: 3 })
  bot.farm.start({ x: .5, z: .5, label: 'Bot' }, true)
  assert.ok(await run(() => !bot.farm.status().enabled))
  assert.deepEqual(crops.get(key(1, 71, 1)), { kind: 'beetroot', growth: 0 })
  assert.deepEqual(crops.get(key(2, 71, 1)), { kind: 'beetroot', growth: 3 })
  assert.ok(reports.includes('1 Rote Bete geerntet, 1 neu gepflanzt.'))
  const click = client.sent.find(([name]) => name === 'inventory_transaction')[1].transaction.transaction_data
  assert.equal(click.held_item.network_id, 303)
  const { RESERVE, DEPOSIT } = require('../dist/farming.js')
  assert.equal(RESERVE.beetroot_seeds, 64)
  assert.equal(RESERVE.beetroot, undefined)
  assert.ok(DEPOSIT.includes('beetroot_seeds'))
  assert.ok(DEPOSIT.includes('beetroot'))
  assert.equal(bot.farm.surplus(), 9, 'Eight fruit and one seed above the reserve may be stored')
})
