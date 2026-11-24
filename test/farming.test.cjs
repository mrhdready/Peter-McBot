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
  const serverSlots = Array.from({ length: 36 }, (_, i) => inventory[i] ?? { network_id: 0 })
  const crops = new Map()
  const blocks = new Map()
  const drops = []
  const pickups = []
  let bot
  class FarmClient extends EventEmitter {
    entityId = 10n
    sent = []
    queue (name, params) {
      this.sent.push([name, params])
      if (name === 'item_stack_request') queueMicrotask(() => {
        const request = params.requests[0]
        const action = request.actions[0]
        for (const ref of [action.source, action.destination]) {
          assert.equal(ref.slot_type.container_id, ref.slot < 9 ? 'hotbar' : 'hotbar_and_inventory')
          assert.equal(ref.stack_id, serverSlots[ref.slot].stack_id ?? 0)
        }
        const from = action.source.slot; const to = action.destination.slot
        if (action.type_id === 'swap') [serverSlots[from], serverSlots[to]] = [serverSlots[to], serverSlots[from]]
        else {
          assert.equal(action.type_id, 'place')
          assert.equal(action.count, serverSlots[from].count)
          serverSlots[to] = { ...serverSlots[from], count: (serverSlots[to].count ?? 0) + action.count, stack_id: 1000 + to }
          serverSlots[from] = { network_id: 0 }
        }
        this.emit('item_stack_response', { responses: [{ status: 'ok', request_id: request.request_id, containers: [{
          slot_type: { container_id: 'hotbar_and_inventory' },
          slots: [from, to].map(slot => ({ slot, count: serverSlots[slot].count ?? 0, item_stack_id: serverSlots[slot].stack_id ?? 0 }))
        }] }] })
      })
      if (name === 'player_auth_input') {
        for (const action of params.block_action ?? []) {
          const p = action.position
          if (action.action === 'stop_break' && crops.has(key(p.x, p.y, p.z))) {
            crops.delete(key(p.x, p.y, p.z))
            for (const drop of drops.splice(0)) this.emit('add_item_entity', drop)
            this.emit('harvest', p)
          }
        }
        for (const [id, entity] of bot.state.items) {
          if (Math.floor(entity.position.x) !== Math.floor(params.position.x) || Math.floor(entity.position.z) !== Math.floor(params.position.z)) continue
          pickups.push(id)
          this.emit('take_item_entity', { runtime_entity_id: BigInt(id), target: 10n })
        }
      }
      const data = name === 'inventory_transaction' ? params.transaction.transaction_data : null
      if (data?.action_type === 'click_block') {
        const at = data.block_position
        const bush = crops.get(key(at.x, at.y, at.z))
        if (bush?.kind === 'sweet_berry_bush') bush.growth = 1
        if (data.held_item.network_id === 305 && data.face !== 1) {
          const [dx, dz, direction] = {2:[0,-1,0], 3:[0,1,2], 4:[-1,0,3], 5:[1,0,1]}[data.face]
          crops.set(key(at.x + dx, at.y, at.z + dz), {kind:'cocoa', growth:0, direction})
        }
      }
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
  client.emit('item_registry', { itemstates: [{ name: 'minecraft:wheat_seeds', runtime_id: 300 }, { name: 'minecraft:wheat', runtime_id: 301 }, { name: 'minecraft:dirt', runtime_id: 302 }, { name: 'minecraft:beetroot_seeds', runtime_id: 303 }, { name: 'minecraft:beetroot', runtime_id: 304 }, { name: 'minecraft:cocoa_beans', runtime_id: 305 }] })
  client.emit('inventory_content', { window_id: 'inventory', input: Array.from({ length: 36 }, (_, i) => inventory[i] ?? { network_id: 0 }) })
  bot.state.terrain = new Terrain((x, y, z) => Math.abs(x) < 10 && Math.abs(z) < 10 ? { boxes: y === 70 ? [[0, 0, 0, 1, 1, 1]] : [], support: y === 70 } : null)
  bot.state.planningTerrain = bot.state.terrain
  bot.state.chunks.set('0:0', { x: 0, z: 0, sections: new Map(), attempts: new Map(), requests: new Map() })
  bot.state.cropAt = (x, y, z) => crops.get(key(x, y, z)) ?? null
  bot.state.blockNameAt = (x, y, z) => blocks.get(key(x, y, z)) ?? (crops.has(key(x, y, z)) ? 'minecraft:' + crops.get(key(x, y, z)).kind : y === 70 ? 'minecraft:farmland' : 'minecraft:air')
  bot.state.blockRuntimeIdAt = () => 1
  let scans = 0
  bot.state.ripeCrops = async () => {
    scans++
    return [...crops].filter(([at, crop]) => bot.state.harvestable(...at.split(':').map(Number), crop)).map(([at, crop]) => { const [x, y, z] = at.split(':').map(Number); return { x, y, z, kind: crop.kind, ...(crop.direction === undefined ? {} : {direction:crop.direction}) } })
  }
  const reports = []
  bot.farm.onReport = text => reports.push(text)
  // Runs ticks until `done` holds (or `limit` ticks passed); each tick lets the farm loop's promises settle.
  const run = async (done = () => false, limit = 2000) => {
    for (let i = 0; i < limit && !done(); i++) { time += 50; bot.step(); await flush() }
    return done()
  }
  const blockActions = () => client.sent.filter(([name, params]) => name === 'player_auth_input' && params.block_action).map(([, params]) => params.block_action.map(action => action.action))
  return { bot, client, clients, crops, blocks, drops, pickups, reports, run, blockActions, scans: () => scans, now: () => time }
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


test('sugar cane harvesting preserves the base and returns to the anchor after the round', async t => {
  const {bot, crops, run} = setup(t)
  for (const y of [71, 72, 73]) crops.set(key(3, y, 0), {kind:'reeds', growth:0})
  bot.farm.configure({field:false, blocks:false, cane:true, cocoa:false, berries:false})
  bot.farm.start({x:.5, z:.5, label:'Basis'}, true)
  assert.ok(await run(() => !bot.farm.status().enabled))
  assert.deepEqual(crops.get(key(3, 71, 0)), {kind:'reeds', growth:0})
  assert.equal(crops.has(key(3, 72, 0)), false)
  assert.equal(crops.has(key(3, 73, 0)), false)
  assert.equal(Math.floor(bot.state.position.x), 0)
  assert.equal(Math.floor(bot.state.position.z), 0)
  assert.ok(Math.abs(bot.state.position.y - 72.62) < .08)
  assert.equal(bot.farm.status().lastSummary, '2 Zuckerrohr geerntet, 0 neu gepflanzt.')
})

test('only enabled groups are harvested; disabling a group completes the started harvest and replant', async t => {
  const {bot, client, crops, run} = setup(t)
  crops.set(key(0,71,1), {kind:'wheat', growth:7})
  crops.set(key(1,71,1), {kind:'wheat', growth:7})
  crops.set(key(2,72,1), {kind:'reeds', growth:0})
  crops.set(key(2,71,1), {kind:'reeds', growth:0})
  client.once('harvest', () => bot.farm.configure({field:false, blocks:false, cane:false, cocoa:false, berries:false}))
  bot.farm.start({x:.5,z:.5,label:'Basis'}, true)
  assert.ok(await run(() => !bot.farm.status().enabled))
  assert.equal(crops.get(key(0,71,1)).growth, 0, 'The started harvest is replanted')
  assert.equal(crops.get(key(1,71,1)).growth, 7, 'The next target is left alone')
  assert.ok(crops.has(key(2,72,1)), 'Disabled cane is untouched')
})

test('ripe berries are picked by interaction without breaking or planting the bush', async t => {
  const {bot, crops, client, run, blockActions} = setup(t)
  crops.set(key(1,71,0), {kind:'sweet_berry_bush', growth:3})
  crops.set(key(2,71,0), {kind:'sweet_berry_bush', growth:2})
  bot.farm.configure({field:false, blocks:false, cane:false, cocoa:false, berries:true})
  bot.farm.start({x:.5,z:.5,label:'Basis'}, true)
  assert.ok(await run(() => !bot.farm.status().enabled))
  assert.equal(crops.get(key(1,71,0)).growth, 1)
  assert.equal(crops.get(key(2,71,0)).growth, 2)
  assert.deepEqual(blockActions(), [])
  const clicks = client.sent.filter(([name]) => name === 'inventory_transaction')
  assert.equal(clicks.length, 1)
  assert.equal(clicks[0][1].transaction.transaction_data.held_item.network_id, 0)
})

test('cocoa uses a reachable floor below the pod and replants on the original log face in all orientations', async t => {
  const offsets = [[0,1],[-1,0],[0,-1],[1,0]]
  for (let direction = 0; direction < 4; direction++) {
    const {bot, crops, blocks, client, run} = setup(t, {inventory:[item(305,64,19)]})
    const [dx,dz] = offsets[direction]
    crops.set(key(2,74,2), {kind:'cocoa', growth:2, direction})
    blocks.set(key(2+dx,74,2+dz), 'minecraft:jungle_log')
    crops.set(key(5,79,5), {kind:'cocoa', growth:2, direction})
    blocks.set(key(5+dx,79,5+dz), 'minecraft:jungle_log')
    bot.farm.configure({field:false, blocks:false, cane:false, cocoa:true, berries:false})
    bot.farm.start({x:.5,z:.5,label:'Basis'}, true)
    assert.ok(await run(() => !bot.farm.status().enabled))
    assert.deepEqual(crops.get(key(2,74,2)), {kind:'cocoa',growth:0,direction})
    assert.equal(crops.get(key(5,79,5)).growth, 2, 'Too high above the floor remains untouched')
    const click = client.sent.find(([name]) => name === 'inventory_transaction')[1].transaction.transaction_data
    assert.deepEqual(click.block_position, {x:2+dx,y:74,z:2+dz})
    assert.equal(click.face, [2,5,3,4][direction])
    const inputs = client.sent.filter(([name, p]) => name === 'player_auth_input' && p.block_action?.some(a => a.action === 'start_break'))
    assert.ok(inputs.every(([,p]) => Math.abs(p.position.y - 72.62) < .08), 'Harvest from floor level')
  }
})

test('cocoa at head height is replanted from beside the pod after collecting its drops', async t => {
  const { bot, crops, blocks, drops, pickups, client, run } = setup(t, { inventory: [item(305, 64, 19)] })
  crops.set(key(1, 72, 0), { kind: 'cocoa', growth: 2, direction: 0 })
  blocks.set(key(1, 72, 1), 'minecraft:jungle_log')
  drops.push({ runtime_entity_id: 50n, entity_id_self: 51n, item: { network_id: 305, count: 1 }, position: { x: 1.5, y: 71.2, z: .5 } })
  bot.farm.configure({ field: false, blocks: false, cane: false, cocoa: true, berries: false })
  bot.farm.start({ x: .5, z: .5, label: 'Basis' }, true)
  assert.ok(await run(() => !bot.farm.status().enabled))
  assert.deepEqual(pickups, ['50'])
  assert.equal(crops.get(key(1, 72, 0)).growth, 0)
  const click = client.sent.find(([name]) => name === 'inventory_transaction')[1].transaction.transaction_data
  assert.ok(Math.floor(click.player_pos.x) !== 1 || Math.floor(click.player_pos.z) !== 0,
    'Leave the drop column before planting cocoa into the head space')
})

test('cocoa on different trunk faces requires walking around the tree before harvesting and replanting', async t => {
  const { bot, crops, blocks, client, run } = setup(t, { inventory: [item(305, 64, 19)] })
  const pods = [[2, 1, 0], [1, 2, 3], [2, 3, 2], [3, 2, 1]]
  for (const [x, z, direction] of pods) crops.set(key(x, 72, z), { kind: 'cocoa', growth: 2, direction })
  for (let y = 71; y <= 75; y++) blocks.set(key(2, y, 2), 'minecraft:jungle_log')
  bot.state.terrain = new Terrain((x, y, z) => Math.abs(x) < 10 && Math.abs(z) < 10
    ? { boxes: y === 70 || (x === 2 && z === 2 && y >= 71 && y <= 75) ? [[0, 0, 0, 1, 1, 1]] : [], support: y === 70 || (x === 2 && z === 2 && y >= 71 && y <= 75) } : null)
  bot.state.planningTerrain = bot.state.terrain
  bot.farm.configure({ field: false, blocks: false, cane: false, cocoa: true, berries: false })
  bot.farm.start({ x: .5, z: .5, label: 'Basis' }, true)
  assert.ok(await run(() => !bot.farm.status().enabled))
  for (const [x, z, direction] of pods) assert.deepEqual(crops.get(key(x, 72, z)), { kind: 'cocoa', growth: 0, direction })
  const actions = client.sent.filter(([name, p]) => name === 'player_auth_input' && p.block_action?.some(a => a.action === 'start_break'))
  assert.equal(actions.length, 4)
  for (const [, packet] of actions) {
    const pod = packet.block_action[0].position
    const direction = pods.find(([x, z]) => x === pod.x && z === pod.z)[2]
    const [dx, dz] = [[0, 1], [-1, 0], [0, -1], [1, 0]][direction]
    assert.ok((packet.position.x - pod.x - .5) * dx + (packet.position.z - pod.z - .5) * dz <= .08,
      'Harvest from the exposed side of each pod, without reaching through the trunk')
  }
})

test('blocked anchor return stays visible and retries; manual navigation cancels farming', async t => {
  const {bot, run, now} = setup(t)
  bot.farm.start({x:.5,y:75,z:.5,label:'Oben'})
  assert.ok(await run(() => bot.farm.status().activity === 'Anker nicht erreichbar; wartet'))
  const first = now()
  await run(() => now() - first >= 31000)
  assert.equal(bot.farm.status().enabled, true)
  assert.equal(bot.farm.status().activity, 'Anker nicht erreichbar; wartet')
  bot.enqueue({type:'navigate', x:2, z:0}); bot.step()
  assert.equal(bot.farm.status().enabled, false)
  await run(() => bot.state.navigation.status === 'arrived')
  assert.equal(bot.state.navigation.target.x, 2)
})


test('block fruit uses sustained breaking; stems, decoration and unripe crops stay untouched', async t => {
  const {bot,client,crops,run} = setup(t)
  crops.set(key(1,71,0),{kind:'melon_block',growth:-1})
  crops.set(key(2,71,0),{kind:'pumpkin',growth:-1})
  crops.set(key(3,71,0),{kind:'pumpkin',growth:-1})
  crops.set(key(0,71,0),{kind:'melon_stem',growth:7})
  const original = bot.state.harvestable.bind(bot.state)
  bot.state.harvestable = (x,y,z,crop = bot.state.cropAt(x,y,z)) => crop?.kind === 'melon_block' ? x===1 : crop?.kind === 'pumpkin' ? x===2 : original(x,y,z,crop)
  bot.farm.configure({field:false,blocks:true,cane:false,cocoa:false,berries:false})
  bot.farm.start({x:.5,z:.5,label:'Basis'},true)
  assert.ok(await run(() => !bot.farm.status().enabled))
  assert.equal(crops.has(key(1,71,0)),false)
  assert.equal(crops.has(key(2,71,0)),false)
  assert.ok(crops.has(key(3,71,0)))
  assert.ok(crops.has(key(0,71,0)))
  const actions = client.sent.flatMap(([name,p]) => name === 'player_auth_input' ? p.block_action ?? [] : [])
  assert.equal(actions.filter(a=>a.action==='start_break').length,2)
  assert.ok(actions.filter(a=>a.action==='continue_break').length>=60)
  assert.equal(client.sent.filter(([name])=>name==='inventory_transaction').length,0)
  const serializer = require('bedrock-protocol/src/transforms/serializer').createSerializer('1.26.60')
  for (const [name,params] of client.sent.filter(([name])=>name==='player_auth_input' || name==='mob_equipment')) {
    assert.ok(serializer.createPacketBuffer({name,params}).length>0,'Sustained break packets serialize')
  }
})


test('farming swaps seeds from slot 35 into a full hotbar and preserves both items', async t => {
  const inventory = Array.from({ length: 9 }, (_, i) => item(302, 64, i + 1))
  inventory[35] = item(300, 5, 99)
  const { bot, client, crops, reports, run } = setup(t, { inventory })
  crops.set(key(1, 71, 1), { kind: 'wheat', growth: 7 })
  bot.farm.start({ x: .5, z: .5, label: 'Bot' }, true)
  assert.ok(await run(() => !bot.farm.status().enabled))
  assert.ok(reports.includes('1 Weizen geerntet, 1 neu gepflanzt.'))
  const swap = client.sent.find(([name]) => name === 'item_stack_request')[1].requests[0].actions[0]
  assert.equal(swap.type_id, 'swap')
  assert.equal(swap.source.slot, 35)
  assert.equal(bot.state.inventory.packetItem(0).network_id, 300)
  assert.equal(bot.state.inventory.packetItem(35).network_id, 302)
  assert.deepEqual(bot.state.inventory.items(), [{ name: 'minecraft:dirt', count: 576 }, { name: 'minecraft:wheat_seeds', count: 5 }])
})

test('empty hand moves a full hotbar stack into main inventory before harvesting berries', async t => {
  const inventory = Array.from({ length: 9 }, (_, i) => item(302, 64, i + 1))
  const { bot, client, crops, run } = setup(t, { inventory })
  crops.set(key(1, 71, 1), { kind: 'sweet_berry_bush', growth: 3 })
  bot.farm.configure({field:false, blocks:false, cane:false, cocoa:false, berries:true})
  bot.farm.start({ x: .5, z: .5, label: 'Bot' }, true)
  assert.ok(await run(() => !bot.farm.status().enabled))
  assert.equal(crops.get(key(1, 71, 1)).growth, 1)
  assert.equal(bot.state.inventory.slotList()[0], null)
  assert.equal(bot.state.inventory.packetItem(9).network_id, 302)
  const equipment = client.sent.find(([name]) => name === 'mob_equipment')[1]
  assert.equal(equipment.item.network_id, 0)
  assert.equal(equipment.selected_slot, 0)
})

test('empty hand can merge matching stacks when all inventory slots are occupied', async t => {
  const inventory = Array.from({ length: 36 }, (_, i) => item(302, 64, i + 1))
  inventory[0] = item(302, 1, 1)
  inventory[35] = item(302, 63, 36)
  const { bot, crops, run } = setup(t, { inventory })
  crops.set(key(1, 71, 1), { kind: 'sweet_berry_bush', growth: 3 })
  bot.farm.configure({field:false, blocks:false, cane:false, cocoa:false, berries:true})
  bot.farm.round = () => bot.farm.holdEmpty({ x: 1.5, y: 71.5, z: 1.5 })
  bot.farm.start({ x: .5, z: .5, label: 'Bot' }, true)
  assert.ok(await run(() => !bot.farm.status().enabled))
  assert.equal(bot.state.inventory.slotList()[0], null)
  assert.equal(bot.state.inventory.slotList()[35].count, 64)
})

test('empty hand reports a full inventory without discarding items', async t => {
  const inventory = Array.from({ length: 36 }, (_, i) => item(302, 64, i + 1))
  const { bot, client, crops, reports, run } = setup(t, { inventory })
  crops.set(key(1, 71, 1), { kind: 'sweet_berry_bush', growth: 3 })
  bot.farm.configure({field:false, blocks:false, cane:false, cocoa:false, berries:true})
  bot.farm.round = () => bot.farm.holdEmpty({ x: 1.5, y: 71.5, z: 1.5 })
  bot.farm.start({ x: .5, z: .5, label: 'Bot' }, true)
  assert.ok(await run(() => !bot.farm.status().enabled))
  assert.equal(crops.get(key(1, 71, 1)).growth, 3)
  assert.ok(reports.some(report => report.includes('freier Hotbar-Slot')))
  assert.equal(client.sent.some(([name]) => name === 'item_stack_request'), false)
  assert.equal(bot.state.inventory.items()[0].count, 2304)
})
