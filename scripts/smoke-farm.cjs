// Explicit live test for the planned farming mode: logs in as its own bot instance (stop the regular bot first, it uses the
// same name), finds the nearest ripe crop (wheat/carrots/potatoes/beetroot with growth 7, or SMOKE_TARGET="x y z" / SMOKE_CROP=<name>),
// walks into reach if needed, breaks it (trying several block-action variants until the server confirms), records the drops
// (add_item_entity / take_item_entity), walks onto them to pick them up, moves the seed into the hotbar, selects it and
// replants (two variants; a crop counts as planted only if it still stands 3 s later). Needs a fresh `pnpm build`
// (farmland became standable). Choose a crop at the edge of a field next to walkable, integer-height ground.
// SMOKE_MODE=feature instead runs one real round of the farming mode (`farming once` around the current position) and
// reports the farmer's chat lines, ripe crops before/after and whether every harvested spot holds a young crop again.
// Report: data/farm-smoke-result.json.
const fs = require('node:fs')
const { createClient } = require('bedrock-protocol')
const { readConfig } = require('../dist/config.js')
const { BotController } = require('../dist/bot.js')

const CROPS = { wheat: 'wheat_seeds', carrots: 'carrot', potatoes: 'potato', beetroot: 'beetroot_seeds' }
const RIPE = 7
const REACH = 4
const WATCHED = /update_block|item_entity|take_item|remove_entity|inventory|item_stack|mob_equipment|level_event|level_sound|start_game|correct_player/

const config = readConfig()
const wantedCrop = process.env.SMOKE_CROP?.trim().toLowerCase() || null
if (wantedCrop && !CROPS[wantedCrop]) throw new Error('SMOKE_CROP must be one of ' + Object.keys(CROPS).join(', '))
const forced = process.env.SMOKE_TARGET?.trim() ? process.env.SMOKE_TARGET.trim().split(/[\s,]+/).map(Number) : null
if (forced && (forced.length !== 3 || !forced.every(Number.isInteger))) throw new Error('SMOKE_TARGET must be "x y z"')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const plain = value => JSON.parse(JSON.stringify(value, (key, item) => typeof item === 'bigint' ? item.toString() : item))
const report = { checkedAt: new Date().toISOString(), result: 'failed', host: config.host, steps: [], packets: [], counts: {}, drops: [], pickups: [], removed: [] }
// The crop position watched during a plant attempt: when the young crop appeared and when it vanished again.
let watchSpot = null
const step = (text, data) => { console.log(text, data === undefined ? '' : JSON.stringify(plain(data))); report.steps.push({ at: Date.now(), text, ...(data === undefined ? {} : { data: plain(data) }) }) }
let bot, client
let recording = false

async function until (predicate, ms, label) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (['dead', 'error'].includes(bot.state.status)) throw new Error('Bot ' + bot.state.status + ': ' + bot.state.lastError)
    const value = predicate()
    if (value) return value
    await wait(50)
  }
  throw new Error('Timed out waiting for ' + label)
}
const short = name => name.replace(/^minecraft:/, '')
const itemName = id => bot.state.inventory.names.get(id) ?? '#' + id
const countOf = name => bot.state.inventory.items().filter(item => short(item.name) === name).reduce((sum, item) => sum + item.count, 0)
const eye = () => bot.state.position
// The bot keys its block ranges by the canonical "minecraft:" name.
const range = name => bot.state.blocks?.['minecraft:' + name]
const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)

// Sends one input tick that looks at `target` (yaw and pitch) and carries extra flags and fields.
function look (send, target, flags = [], fields = {}) {
  bot.navigator.face((name, params) => {
    if (name !== 'player_auth_input') return send(name, params)
    const p = eye()
    const pitch = Math.atan2(p.y - target.y, Math.hypot(target.x - p.x, target.z - p.z)) * 180 / Math.PI
    send(name, { ...params, pitch, interact_rotation: { x: pitch, z: params.yaw }, input_data: [...params.input_data, ...flags], ...fields })
  }, { x: target.x, z: target.z })
}
// Keeps sending plain input ticks (the server handles clicks only together with input) until `done` or the timeout.
async function ticksUntil (send, target, done, ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (done()) return true
    look(send, target)
    await wait(50)
  }
  return Boolean(done())
}

async function walkNear (target, label) {
  const p = eye()
  const spots = []
  for (let dx = -3; dx <= 3; dx++) {
    for (let dz = -3; dz <= 3; dz++) {
      for (const feetY of [target.y, target.y - 1, target.y + 1]) {
        if (!bot.state.canStandAt(target.x + dx + .5, target.z + dz + .5, feetY)) continue
        const eyeAt = { x: target.x + dx + .5, y: feetY + 1.62, z: target.z + dz + .5 }
        const reach = distance(eyeAt, { x: target.x + .5, y: target.y + .5, z: target.z + .5 })
        if (reach <= REACH) spots.push({ x: target.x + dx, z: target.z + dz, feetY, reach, d: Math.hypot(target.x + dx - p.x, target.z + dz - p.z) })
      }
    }
  }
  spots.sort((a, b) => a.d - b.d)
  if (!spots.length) return { status: 'no-stand-spot' }
  step('Walking to ' + label, spots[0])
  bot.enqueue({ type: 'navigate', x: spots[0].x, z: spots[0].z })
  await wait(200)
  const status = await until(() => ['arrived', 'error', 'stopped'].includes(bot.state.navigation.status) && bot.state.navigation.status, 90000, 'navigation')
  await wait(400)
  return { status, spot: spots[0], message: bot.state.navigation.message, position: { ...eye() } }
}

async function main () {
  bot = new BotController(config, options => {
    client = createClient({
      host: options.host, port: options.port, version: options.version, username: options.username, transport: options.transport,
      offline: true, raknetBackend: 'jsp-raknet', skinData: { SelfSignedId: require('bedrock-protocol/src/datatypes/util').uuidFrom(options.username) },
      connectTimeout: 9000, pingTimeout: 5000, conLog: console.log,
      ...(options.transport === 'nethernet' ? { nethernet: { webrtcBackend: 'werift', signalling: 'http', serverKeyPath: './data/server-key.sha256', iceHost: options.iceHost } } : {})
    })
    client.on('start_game', packet => {
      // Whether block breaking goes through player_auth_input block actions, and the movement authority.
      report.startGame = plain(Object.fromEntries(Object.entries(packet).filter(([key]) => /author|rewind|movement|block_break/.test(key))))
    })
    client.on('add_item_entity', packet => {
      if (recording) report.drops.push({ at: Date.now(), id: String(packet.runtime_entity_id), uniqueId: String(packet.entity_id_self), name: itemName(packet.item?.network_id), count: packet.item?.count, position: plain(packet.position) })
    })
    client.on('remove_entity', packet => {
      const id = String(packet.entity_id_self)
      // remove_entity carries the unique ID; add_item_entity gives both, so match on the unique one.
      const drop = report.drops.find(entry => entry.uniqueId === id)
      if (recording && drop) report.removed.push(drop.id)
    })
    client.on('update_block', packet => {
      const spot = watchSpot; const p = packet.position
      if (!spot || p.x !== spot.x || p.y !== spot.y || p.z !== spot.z) return
      if (packet.block_runtime_id >>> 0 === spot.youngRuntime) spot.events.placed ??= Date.now()
      else if (spot.events.placed) spot.events.destroyed ??= Date.now()
    })
    client.on('set_time', packet => { report.time = packet.time })
    client.on('take_item_entity', packet => {
      if (recording) report.pickups.push({ at: Date.now(), id: String(packet.runtime_entity_id), by: String(packet.target), byBot: String(packet.target) === String(client.entityId) })
    })
    client.on('packet', packet => {
      const name = packet.data.name
      if (recording) report.counts[name] = (report.counts[name] || 0) + 1
      if (name === 'start_game' || !recording || !WATCHED.test(name)) return
      if (report.packets.length < 800) report.packets.push({ at: Date.now(), name, params: plain(packet.data.params) })
    })
    return client
  })
  const send = (name, params) => {
    if (recording && report.packets.length < 800) report.packets.push({ at: Date.now(), sent: true, name, params: plain(params) })
    client.queue(name, params)
  }
  bot.start()
  bot.enqueue('connect')
  await until(() => bot.state.status === 'spawned' && bot.state.position, 30000, 'spawn')
  await until(() => bot.state.inventory.known, 10000, 'inventory_content')
  await until(() => bot.state.coverage().complete, 20000, 'complete chunk coverage').catch(() => step('Chunks not complete after 20 s; searching anyway'))
  report.position = { ...eye() }
  report.inventoryBefore = bot.state.inventory.items()

  // SMOKE_MODE=feature: one real round of the farming mode (src/farming.ts) around the current position instead of the probes.
  if (process.env.SMOKE_MODE?.trim() === 'feature') {
    recording = true
    report.mode = 'feature'
    report.farmReports = []
    bot.farm.onReport = text => { step('Farm: ' + text); report.farmReports.push(text) }
    const ripeBefore = await bot.state.ripeCrops({ ...eye() }, bot.farm.radius)
    report.ripeBefore = ripeBefore.length
    const error = bot.farm.start({ x: eye().x, z: eye().z, label: 'Smoke' }, true)
    if (error) { report.result = 'not-started'; report.error = error; return }
    await until(() => !bot.farm.status().enabled, 300000, 'farming round')
    report.farm = bot.farm.status()
    // Every harvested spot of the round should hold a young crop again.
    report.ripeAfter = (await bot.state.ripeCrops({ ...report.position }, bot.farm.radius)).length
    report.replanted = ripeBefore.map(spot => ({ ...spot, now: bot.state.cropAt(spot.x, spot.y, spot.z) }))
    report.itemsLeft = [...bot.state.items.values()]
    report.inventoryAfter = bot.state.inventory.items()
    const summary = report.farmReports.find(text => / geerntet, /.test(text))
    report.result = summary && report.replanted.every(spot => spot.now?.kind === spot.kind) ? 'passed' : 'check-report'
    return
  }

  // 1. Crop states: the ripe state must be min + 7 with growth 7 in the registry.
  const registry = require('prismarine-registry')('bedrock_1.26.60')
  report.cropStates = {}
  for (const name of Object.keys(CROPS)) {
    const block = range(name)
    const states = block ? registry.blockStates?.[block.min + RIPE]?.states : null
    report.cropStates[name] = block ? { min: block.min, max: block.max, ripeGrowth: states?.growth?.value ?? states?.growth ?? null } : null
  }
  step('Crop states', report.cropStates)

  // 2. Find the nearest ripe crop.
  const kinds = wantedCrop ? [wantedCrop] : Object.keys(CROPS)
  const ripe = []
  if (forced) {
    const state = bot.state.stateAt(forced[0], forced[1], forced[2])
    const kind = kinds.find(name => range(name)?.min + RIPE === state)
    if (!kind) { report.result = 'target-not-ripe'; report.targetState = state; return }
    ripe.push({ kind, x: forced[0], y: forced[1], z: forced[2] })
  } else {
    const found = await bot.state.searchBlocks(kinds, 100, eye())
    report.search = { outcome: found.outcome, hits: found.hits.length, limitReached: found.limitReached }
    for (const hit of found.hits) {
      const state = bot.state.stateAt(hit.x, hit.y, hit.z)
      const kind = kinds.find(name => range(name).min + RIPE === state)
      if (kind) ripe.push({ kind, ...hit })
    }
  }
  report.ripe = ripe.slice(0, 10)
  step('Ripe crops', report.ripe.slice(0, 5))
  const crop = ripe[0]
  if (!crop) { report.result = 'no-ripe-crop'; return }
  report.crop = crop
  const cropCenter = { x: crop.x + .5, y: crop.y + .25, z: crop.z + .5 }
  const seed = CROPS[crop.kind]
  const ripeState = range(crop.kind).min + RIPE
  const youngState = range(crop.kind).min

  // 3. Walk into reach.
  if (distance(eye(), cropCenter) > REACH) {
    report.walk = await walkNear(crop, 'crop')
    if (report.walk.status !== 'arrived') { report.result = 'navigation-' + report.walk.status; return }
  }
  report.reach = distance(eye(), cropCenter)
  step('Reach to crop', report.reach)

  // 4. Break: block actions in player_auth_input (server-authoritative breaking), legacy player_action as fallback.
  recording = true
  const at = { x: crop.x, y: crop.y, z: crop.z }
  const action = name => ({ action: name, position: at, face: 1 })
  const variants = [
    { label: 'A-start+predict', ticks: [[action('start_break'), action('predict_break')], [action('stop_break')]] },
    { label: 'B-start,crack,predict,stop', ticks: [[action('start_break')], [action('crack_break')], [action('predict_break')], [action('stop_break')]] },
    { label: 'C-start-only', ticks: [[action('start_break')]] },
    { label: 'D-legacy-player_action', legacy: true }
  ]
  const broken = () => { const state = bot.state.stateAt(crop.x, crop.y, crop.z); return state !== null && state !== ripeState }
  report.breakAttempts = []
  let breakWinner = null
  for (const variant of variants) {
    step('Breaking: ' + variant.label)
    if (variant.legacy) {
      const p = eye()
      send('player_action', { runtime_entity_id: client.entityId, action: 'start_break', position: at, result_position: at, face: 1 })
      send('inventory_transaction', { transaction: { legacy: { legacy_request_id: 0 }, transaction_type: 'item_use', actions: [],
        transaction_data: { action_type: 'break_block', trigger_type: 'player_input', block_position: at, face: 1, hotbar_slot: 0, hand: 'main_hand',
          held_item: bot.state.inventory.heldItem(0), player_pos: { ...p }, click_pos: { x: .5, y: .5, z: .5 }, block_runtime_id: bot.state.blockRuntimeIdAt(crop.x, crop.y, crop.z) ?? 0,
          client_prediction: 'success', client_cooldown_state: 'off' } } })
      send('player_action', { runtime_entity_id: client.entityId, action: 'stop_break', position: at, result_position: at, face: 1 })
    } else {
      for (const blockAction of variant.ticks) {
        look(send, cropCenter, ['block_action'], { block_action: blockAction })
        await wait(50)
      }
    }
    const ok = await ticksUntil(send, cropCenter, broken, 1500)
    report.breakAttempts.push({ label: variant.label, broken: ok, stateAfter: bot.state.stateAt(crop.x, crop.y, crop.z) })
    if (ok) { breakWinner = variant.label; break }
  }
  report.breakWinner = breakWinner
  if (!breakWinner) { report.result = 'not-broken'; return }
  report.stateAfterBreak = bot.state.stateAt(crop.x, crop.y, crop.z)
  report.airAfterBreak = report.stateAfterBreak === bot.state.air

  // 5. Drops: walk onto each drop's column (farmland is standable now) until the server reports the pickup.
  const seedsBefore = countOf(seed)
  await ticksUntil(send, cropCenter, () => false, 1000)
  report.dropsAfterBreak = report.drops.map(drop => ({ ...drop }))
  report.pickupWalks = []
  await collectDrops(send, cropCenter)
  report.pickedUpAll = openDrops().length === 0
  report.seedDelta = countOf(seed) - seedsBefore
  report.inventoryAfterHarvest = bot.state.inventory.items()

  // 5b. Wheat often drops no seed (runs 3 and 4). Harvest further ripe crops of the same kind with the proven variant A
  //     until a seed is in the inventory (at most 5); the test spot to replant stays the first crop.
  report.extraHarvests = []
  for (const extra of ripe.filter(entry => entry.kind === crop.kind && entry !== crop).slice(0, 5)) {
    if (countOf(seed) > 0) break
    const center = { x: extra.x + .5, y: extra.y + .25, z: extra.z + .5 }
    if (distance(eye(), center) > REACH) {
      const walk = await walkNear(extra, 'extra crop')
      if (walk.status !== 'arrived') { report.extraHarvests.push({ ...extra, skipped: 'navigation-' + walk.status }); continue }
    }
    const spot = { x: extra.x, y: extra.y, z: extra.z }
    const ripeHere = () => bot.state.stateAt(extra.x, extra.y, extra.z) === ripeState
    if (!ripeHere()) { report.extraHarvests.push({ ...extra, skipped: 'not-ripe-anymore' }); continue }
    look(send, center, ['block_action'], { block_action: [{ action: 'start_break', position: spot, face: 1 }, { action: 'predict_break', position: spot, face: 1 }] })
    await wait(50)
    look(send, center, ['block_action'], { block_action: [{ action: 'stop_break', position: spot, face: 1 }] })
    const broke = await ticksUntil(send, center, () => !ripeHere(), 1500)
    await ticksUntil(send, center, () => false, 1000)
    await collectDrops(send, center)
    report.extraHarvests.push({ ...extra, broke, seedsNow: countOf(seed) })
    step('Extra harvest', report.extraHarvests.at(-1))
  }
  report.seedsForPlanting = countOf(seed)

  // 6. Plant. Run 1 (2026-11-20): the server placed the crop and destroyed it in the same tick (particle_destroy, seed dropped),
  //    probably because the break state from harvesting was still active while the bot looked at the spot.
  //    P1 ends the break state with abort_break first; P2 clicks while the following input ticks look horizontally.
  const soil = { x: crop.x, y: crop.y - 1, z: crop.z }
  const soilTop = { x: crop.x + .5, y: crop.y - .0625, z: crop.z + .5 }
  const youngRuntime = bot.state.runtimeIds.get(youngState)
  const planted = () => bot.state.stateAt(crop.x, crop.y, crop.z) === youngState
  report.plantAttempts = []
  let plantWinner = null
  const plantVariants = [
    { label: 'P1-abort_break-first', before: () => look(send, soilTop, ['block_action'], { block_action: [action('abort_break')] }), lookDown: true },
    { label: 'P2-horizontal-ticks', before: () => {}, lookDown: false }
  ]
  for (const variant of plantVariants) {
    if (distance(eye(), cropCenter) > REACH || Math.hypot(eye().x - cropCenter.x, eye().z - cropCenter.z) < 1) {
      const back = await walkNear(crop, 'crop again')
      if (back.status !== 'arrived') { report.plantAttempts.push({ label: variant.label, skipped: 'navigation-' + back.status }); continue }
    }
    const hand = await holdSeed(send, seed, soilTop)
    if (hand.error) { report.plantAttempts.push({ label: variant.label, skipped: hand.error }); break }
    step('Planting: ' + variant.label, { slot: hand.index, count: hand.held.count })
    const events = { placed: null, destroyed: null }
    const start = Date.now()
    watchSpot = { x: crop.x, y: crop.y, z: crop.z, youngRuntime, events }
    variant.before()
    await ticksUntil(send, soilTop, () => false, 150)
    const soilRuntime = bot.state.blockRuntimeIdAt(soil.x, soil.y, soil.z) ?? 0
    send('inventory_transaction', { transaction: { legacy: { legacy_request_id: 0 }, transaction_type: 'item_use', actions: [],
      transaction_data: { action_type: 'click_block', trigger_type: 'player_input', block_position: soil, face: 1, hotbar_slot: hand.index, hand: 'main_hand',
        held_item: hand.held, player_pos: { ...eye() }, click_pos: { x: .5, y: 1, z: .5 }, block_runtime_id: soilRuntime, client_prediction: 'success', client_cooldown_state: 'off' } } })
    const horizontal = { x: soilTop.x, y: eye().y, z: soilTop.z }
    // Wait 3 s and require the crop to still stand at the end, not only to have appeared.
    await ticksUntil(send, variant.lookDown ? soilTop : horizontal, () => false, 3000)
    watchSpot = null
    const ok = planted()
    report.plantAttempts.push({ label: variant.label, planted: ok, placedAfterMs: events.placed && events.placed - start,
      destroyedAfterMs: events.destroyed && events.destroyed - start, stateAfter: bot.state.stateAt(crop.x, crop.y, crop.z) })
    step('Plant result', report.plantAttempts.at(-1))
    if (ok) { plantWinner = variant.label; break }
    // A destroyed crop drops the seed again; collect it for the next variant.
    await ticksUntil(send, soilTop, () => false, 800)
    await collectDrops(send, cropCenter)
  }
  report.plantWinner = plantWinner
  await wait(500)
  report.inventoryAfter = bot.state.inventory.items()
  report.result = plantWinner ? 'passed' : 'harvested-not-planted'
}

// Drops not yet picked up by the bot and not removed otherwise.
const openDrops = () => report.drops.filter(drop => !report.pickups.some(pickup => pickup.id === drop.id) && !report.removed.includes(drop.id))

async function collectDrops (send, lookAt) {
  for (let round = 0; round < 4 && openDrops().length; round++) {
    const drop = openDrops()[0]
    const column = { x: Math.floor(drop.position.x), z: Math.floor(drop.position.z) }
    step('Walking onto drop', { id: drop.id, name: drop.name, ...column })
    bot.enqueue({ type: 'navigate', x: column.x, z: column.z })
    await wait(200)
    const status = await until(() => ['arrived', 'error', 'stopped'].includes(bot.state.navigation.status) && bot.state.navigation.status, 30000, 'navigation').catch(() => 'timeout')
    const picked = await ticksUntil(send, lookAt, () => !openDrops().some(open => open.id === drop.id), 1500)
    report.pickupWalks.push({ id: drop.id, column, status, message: bot.state.navigation.message, position: { ...eye() }, picked })
    if (!picked && status !== 'arrived') break
  }
}

// Puts a stack of `seed` into the hotbar if needed and selects it with mob_equipment.
async function holdSeed (send, seed, lookAt) {
  let slots = bot.state.inventory.slotList()
  let index = slots.findIndex((slot, i) => i < 9 && slot && short(slot.name) === seed)
  if (index < 0) {
    const from = slots.findIndex(slot => slot && short(slot.name) === seed)
    const to = slots.findIndex((slot, i) => i < 9 && !slot)
    if (from < 0) return { error: 'no-seed' }
    if (to < 0) return { error: 'hotbar-full' }
    const move = { name: slots[from].name, count: slots[from].count, from: { container: 'inventory', slot: from, stackId: slots[from].stackId }, to: { container: 'hotbar', slot: to, stackId: 0 } }
    report.seedMove = await bot.state.inventory.place(send, move, Date.now()).catch(error => ({ error: error.message }))
    step('Seed moved to hotbar', report.seedMove)
    await wait(300)
    slots = bot.state.inventory.slotList()
    index = slots[to] && short(slots[to].name) === seed ? to : -1
    if (index < 0) return { error: 'seed-move-failed' }
  }
  const slot = slots[index]
  // The raw packet item may be stale after a stack move; the server's stack ID and count are authoritative.
  const held = { ...(slot.raw ?? {}), count: slot.count, has_stack_id: true, stack_id: slot.stackId }
  send('mob_equipment', { runtime_entity_id: client.entityId, item: held, slot: index, selected_slot: index, window_id: 'inventory' })
  await ticksUntil(send, lookAt, () => false, 300)
  return { index, held }
}

main().catch(error => { report.error = error.stack || error.message; console.error(report.error); process.exitCode = 1 }).finally(() => {
  bot?.stop()
  fs.mkdirSync('data', { recursive: true })
  fs.writeFileSync('data/farm-smoke-result.json', JSON.stringify(report, null, 2) + '\n')
  console.log('Report: data/farm-smoke-result.json, result ' + report.result)
  setTimeout(() => process.exit(), 500).unref()
})
