// Explicit live test: logs in as its own bot instance (stop the regular bot first, it uses the same name),
// searches the loaded chunks for every chest block ID, walks next to the nearest chest (or SMOKE_CHEST="x y z"),
// opens it with one click, records the container packets and contents, moves ONE item of SMOKE_ITEM (or the first
// inventory item) into the first empty chest slot and back again, then closes the chest.
// SMOKE_CONTAINER overrides the container name used for the chest side of the stack requests (default "level_entity").
// SMOKE_MODE=commands tests the put/get chat commands instead (see commands() below).
// Report: data/chest-smoke-result.json.
const fs = require('node:fs')
const { createClient } = require('bedrock-protocol')
const { readConfig } = require('../dist/config.js')
const { BotController } = require('../dist/bot.js')

const CHEST_IDS = ['chest', 'trapped_chest', 'copper_chest', 'exposed_copper_chest', 'weathered_copper_chest', 'oxidized_copper_chest',
  'waxed_copper_chest', 'waxed_exposed_copper_chest', 'waxed_weathered_copper_chest', 'waxed_oxidized_copper_chest']
const REACH = 4.5
const EMPTY_ITEM = { network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: false, can_place_on: [], can_destroy: [] } }
const WATCHED = /container|inventory|item_stack|block_event|block_entity|level_event|level_sound|update_block/

const config = readConfig()
const wanted = process.env.SMOKE_ITEM?.trim().toLowerCase().replace(/^minecraft:/, '') || null
const chestContainer = process.env.SMOKE_CONTAINER?.trim() || 'level_entity'
const forcedChest = process.env.SMOKE_CHEST?.trim() ? process.env.SMOKE_CHEST.trim().split(/[\s,]+/).map(Number) : null
if (forcedChest && (forcedChest.length !== 3 || !forcedChest.every(Number.isInteger))) throw new Error('SMOKE_CHEST must be "x y z"')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const plain = value => JSON.parse(JSON.stringify(value, (key, item) => typeof item === 'bigint' ? item.toString() : item))
const report = { checkedAt: new Date().toISOString(), result: 'failed', host: config.host, wanted, chestContainer, steps: [], packets: [] }
const step = (text, data) => { console.log(text, data === undefined ? '' : JSON.stringify(data)); report.steps.push({ at: Date.now(), text, ...(data === undefined ? {} : { data: plain(data) }) }) }
let bot, client
let recording = false
let rawSlots = []
report.counts = {}
// Packets the script waits for, by name; each entry is consumed once.
const inbox = []

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
const nextPacket = (name, ms, match = () => true) => until(() => {
  const index = inbox.findIndex(entry => entry.name === name && match(entry.params))
  return index >= 0 ? inbox.splice(index, 1)[0].params : null
}, ms, name)
const itemName = id => bot.state.inventory.names.get(id) ?? '#' + id
const decodeItems = items => (items ?? []).map((item, slot) => item?.network_id ? { slot, name: itemName(item.network_id), count: item.count, stackId: item.has_stack_id ? item.stack_id : null } : null)

// SMOKE_MODE=commands: runs "put <item> 1" and then "get <item> 1" through the real chat command code (replies go to public chat)
// and checks the replies and the inventory. The item is SMOKE_ITEM or the first one in the inventory.
async function commands () {
  const { ChatCommands } = require('../dist/chat-commands.js')
  const sender = process.env.SMOKE_SENDER?.trim() || 'Smoke'
  const chat = new ChatCommands(bot, null, config.radius * 16, config.username)
  const replies = []
  const say = bot.say.bind(bot)
  bot.say = message => { replies.push({ at: Date.now(), message }); console.log('reply', message); return say(message) }
  const item = bot.state.inventory.items().find(entry => !wanted || entry.name.replace(/^minecraft:/, '') === wanted)
  if (!item) { report.result = wanted ? 'item-missing' : 'inventory-empty'; return }
  const short = item.name.replace(/^minecraft:/, '')
  const count = () => bot.state.inventory.items().find(entry => entry.name === item.name)?.count ?? 0
  const final = /abgelegt|geholt|Abgebrochen|komme an keine|Keine Kiste|nicht möglich|Mein Inventar|Nichts|Kein /
  report.commands = []
  for (const [verb, expected, delta] of [['put', `1 ${short} in 1 Kiste abgelegt.`, -1], ['get', `1 ${short} aus 1 Kiste geholt.`, 1]]) {
    const before = count(); const start = replies.length
    const line = `${config.username} ${verb} ${short} 1`
    step('Command', line)
    await chat.handle(sender, line)
    const reply = await until(() => replies.slice(start).find(entry => final.test(entry.message)), 90000, verb + ' reply').catch(() => null)
    await until(() => !bot.chestBusy, 5000, 'chest closed').catch(() => null)
    report.commands.push({ line, replies: replies.slice(start).map(entry => entry.message), countBefore: before, countAfter: count(), expected })
    if (reply?.message !== expected || count() !== before + delta) { report.result = verb + '-failed'; return }
    // The chat cooldown is 2 s per sender.
    await wait(2500)
  }
  report.inventoryAfter = bot.state.inventory.items()
  report.result = 'passed'
}

async function main () {
  bot = new BotController(config, options => {
    client = createClient({
      host: options.host, port: options.port, version: options.version, username: options.username, transport: options.transport,
      offline: true, raknetBackend: 'jsp-raknet', skinData: { SelfSignedId: require('bedrock-protocol/src/datatypes/util').uuidFrom(options.username) },
      connectTimeout: 9000, pingTimeout: 5000, conLog: console.log,
      ...(options.transport === 'nethernet' ? { nethernet: { webrtcBackend: 'werift', signalling: 'http', serverKeyPath: './data/server-key.sha256', iceHost: options.iceHost } } : {})
    })
    // Raw items of the bot's own inventory, to send the real held item with a click.
    client.on('inventory_content', packet => { if (packet.window_id === 'inventory' || packet.window_id === 0) rawSlots = [...(packet.input ?? [])] })
    client.on('inventory_slot', packet => { if (packet.window_id === 'inventory' || packet.window_id === 0) rawSlots[packet.slot] = packet.item })
    client.on('packet', packet => {
      const name = packet.data.name
      if (recording) report.counts[name] = (report.counts[name] || 0) + 1
      if (!recording || !WATCHED.test(name)) return
      const params = plain(packet.data.params)
      inbox.push({ name, params })
      if (report.packets.length < 600) report.packets.push({ at: Date.now(), name, params })
    })
    return client
  })
  const send = (name, params) => {
    if (report.packets.length < 600) report.packets.push({ at: Date.now(), sent: true, name, params: plain(params) })
    client.queue(name, params)
  }
  bot.start()
  bot.enqueue('connect')
  await until(() => bot.state.status === 'spawned' && bot.state.position, 30000, 'spawn')
  await until(() => bot.state.inventory.known, 10000, 'inventory_content')
  // Give the chunk loader time to fill the radius before searching.
  await until(() => bot.state.coverage().complete, 20000, 'complete chunk coverage').catch(() => step('Chunks not complete after 20 s; searching anyway'))
  report.position = { ...bot.state.position }
  report.inventoryBefore = bot.state.inventory.items()
  if (process.env.SMOKE_MODE === 'commands') return commands()

  // 1. Which chest IDs exist in this data version, and where are chests?
  report.chestIds = {}
  const candidates = []
  for (const id of CHEST_IDS) {
    try {
      const result = await bot.state.searchBlocks(id, 20, bot.state.position)
      report.chestIds[id] = { known: true, hits: result.hits.length, outcome: result.outcome }
      candidates.push(...result.hits.map(hit => ({ id, ...hit })))
    } catch (error) {
      report.chestIds[id] = { known: false, error: error.message }
    }
  }
  candidates.sort((a, b) => a.distance - b.distance)
  report.candidates = candidates.slice(0, 20)
  step('Chest candidates', report.candidates.slice(0, 5))
  const chest = forcedChest ? { x: forcedChest[0], y: forcedChest[1], z: forcedChest[2] } : candidates[0]
  if (!chest) { report.result = 'no-chest'; return }
  report.chest = { ...chest }

  // 2. Walk next to the chest unless it is already in reach.
  const eyeDistance = () => { const p = bot.state.position; return Math.hypot(chest.x + .5 - p.x, chest.y + .5 - p.y, chest.z + .5 - p.z) }
  if (eyeDistance() > REACH) {
    const p = bot.state.position
    const spots = []
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      for (const feetY of [chest.y, chest.y - 1, chest.y + 1]) {
        if (bot.state.canStandAt(chest.x + dx + .5, chest.z + dz + .5, feetY)) spots.push({ x: chest.x + dx, z: chest.z + dz, feetY, d: Math.hypot(chest.x + dx - p.x, chest.z + dz - p.z) })
      }
    }
    spots.sort((a, b) => a.d - b.d)
    report.standSpots = spots
    if (!spots.length) { report.result = 'no-stand-spot'; return }
    step('Walking to', spots[0])
    bot.enqueue({ type: 'navigate', x: spots[0].x, z: spots[0].z })
    await wait(200)
    const status = await until(() => ['arrived', 'error', 'stopped'].includes(bot.state.navigation.status) && bot.state.navigation.status, 90000, 'navigation')
    report.navigation = { status, message: bot.state.navigation.message, position: { ...bot.state.position } }
    if (status !== 'arrived') { report.result = 'navigation-' + status; return }
    await wait(500)
  }
  report.eyeDistance = eyeDistance()
  step('Eye distance to chest', report.eyeDistance)

  // 3. Open: click the chest, trying variants until the server answers with container_open.
  //    A: side face towards the bot (like a door), the real item of hotbar slot 0 as held item, pitch 0.
  //    B: like A, but first select an empty hotbar slot (mob_equipment) and click with an empty hand.
  //    C: like B, but looking down at the chest (pitch aimed at the block centre).
  recording = true
  const p = bot.state.position
  const runtimeId = bot.state.runtimeIds.get(bot.state.stateAt(chest.x, chest.y, chest.z))
  report.blockRuntimeId = runtimeId ?? null
  report.blockAbove = bot.state.runtimeIds.get(bot.state.stateAt(chest.x, chest.y + 1, chest.z)) ?? null
  report.blockAboveIsAir = bot.state.stateAt(chest.x, chest.y + 1, chest.z) === bot.state.air
  const dx = p.x - chest.x - .5; const dz = p.z - chest.z - .5
  const face = Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 5 : 4) : (dz > 0 ? 3 : 2)
  const click = { x: face === 5 ? 1 : face === 4 ? 0 : .5, y: .5, z: face === 3 ? 1 : face === 2 ? 0 : .5 }
  const pitch = Math.atan2(p.y - (chest.y + .5), Math.hypot(dx, dz)) * 180 / Math.PI
  const emptyHotbar = [0, 1, 2, 3, 4, 5, 6, 7, 8].find(slot => !rawSlots[slot]?.network_id)
  report.rawHotbar0 = plain(rawSlots[0] ?? null)
  // B opened the chest in the first live run (2026-11-20); A failed. A stays as fallback for a full hotbar.
  const attempts = []
  if (emptyHotbar !== undefined) {
    attempts.push({ label: 'B-empty-slot', slot: emptyHotbar, held: EMPTY_ITEM, pitch: 0, select: true })
    attempts.push({ label: 'C-empty-slot-pitch', slot: emptyHotbar, held: EMPTY_ITEM, pitch, select: true })
  }
  attempts.push({ label: 'A-real-held-item', slot: 0, held: rawSlots[0]?.network_id ? rawSlots[0] : EMPTY_ITEM, pitch: 0 })
  report.attempts = []
  let open = null
  for (const attempt of attempts) {
    if (attempt.select) {
      send('mob_equipment', { runtime_entity_id: client.entityId, item: EMPTY_ITEM, slot: attempt.slot, selected_slot: attempt.slot, window_id: 'inventory' })
      await wait(200)
    }
    // Face the chest; the navigator always sends pitch 0, so the input packet is patched for variant C.
    bot.navigator.face((name, params) => send(name, name === 'player_auth_input' ? { ...params, pitch: attempt.pitch, interact_rotation: { x: attempt.pitch, z: params.yaw } } : params), { x: chest.x + .5, z: chest.z + .5 })
    await wait(100)
    step('Clicking chest: ' + attempt.label, { face, click, runtimeId, slot: attempt.slot, pitch: attempt.pitch })
    send('inventory_transaction', { transaction: { legacy: { legacy_request_id: 0 }, transaction_type: 'item_use', actions: [],
      transaction_data: { action_type: 'click_block', trigger_type: 'player_input', block_position: { x: chest.x, y: chest.y, z: chest.z }, face, hotbar_slot: attempt.slot, hand: 'main_hand',
        held_item: attempt.held, player_pos: { ...p }, click_pos: click, block_runtime_id: runtimeId ?? 0, client_prediction: 'success', client_cooldown_state: 'off' } } })
    open = await nextPacket('container_open', 2500).catch(() => null)
    report.attempts.push({ label: attempt.label, opened: Boolean(open) })
    if (open) break
  }
  if (!open) { report.result = 'not-opened'; await wait(1000); return }
  report.containerOpen = open
  const windowId = open.window_id
  // The window ID may be reported as a number in one packet and as an enum name in the other; any non-player window counts.
  const playerWindows = ['inventory', 0, 'armor', 120, 'offhand', 119, 'ui', 124]
  const content = await nextPacket('inventory_content', 2000, params => params.window_id === windowId || !playerWindows.includes(params.window_id)).catch(() => null)
  report.chestContent = content ? { window_id: content.window_id, container: content.container, size: content.input?.length ?? null, slots: decodeItems(content.input).filter(Boolean) } : null
  step('Chest opened', { windowId, windowType: open.window_type, size: report.chestContent?.size })

  // 4. Move one item in and back out again; stack IDs come from the server's answers.
  const own = bot.state.inventory.slots.map((slot, index) => slot && { index, ...slot }).filter(Boolean)
    .find(slot => !wanted || slot.name.replace(/^minecraft:/, '') === wanted)
  report.moved = own ? { name: own.name, fromSlot: own.index, countBefore: own.count } : null
  const emptySlot = content?.input?.findIndex(item => !item?.network_id) ?? -1
  if (!own || emptySlot < 0) {
    report.result = !own ? (wanted ? 'item-missing' : 'inventory-empty') : 'chest-full'
  } else {
    await wait(300)
    const ownContainer = own.index < 9 ? 'hotbar' : 'inventory'
    const slotInfo = (container, slot, stackId) => ({ slot_type: { container_id: container, dynamic_container_id: undefined }, slot, stack_id: stackId })
    const legacy = { take: 0, place: 1 }
    let nextId = -1001
    const request = actions => {
      const id = nextId; nextId -= 2
      // An item moved earlier in the same request is addressed by the request ID instead of a stack ID.
      const resolved = actions.map(action => JSON.parse(JSON.stringify(action).replace(/"stack_id":"REQ"/g, '"stack_id":' + id)))
      send('item_stack_request', { requests: [{ request_id: id, actions: resolved, custom_names: [], cause: 'chat_public' }] })
      return nextPacket('item_stack_response', 3000, params => params.responses?.some(response => response.request_id === id))
        .then(params => params.responses.find(response => response.request_id === id)).catch(error => ({ error: error.message }))
    }
    const ok = response => response?.status === 'ok' || response?.status === 0
    const move = (type, from, to) => ({ type_id: type, legacy_type_id: legacy[type], count: 1, source: from, destination: to })
    // Variants: action type × chest container name × direct or via the cursor; the first one the server accepts wins.
    const containers = [...new Set([chestContainer, 'level_entity', 'container'])]
    const variants = []
    for (const container of containers) {
      for (const type of ['place', 'take']) variants.push({ label: `direct-${type}-${container}`, container, route: 'direct', type })
    }
    for (const container of containers) variants.push({ label: `cursor-${container}`, container, route: 'cursor' })
    const actionsFor = (variant, from, to) => variant.route === 'direct'
      ? [move(variant.type, from, to)]
      : [move('take', from, slotInfo('cursor', 0, 0)), move('place', slotInfo('cursor', 0, 'REQ'), to)]
    const slotOf = (response, containers, slot) => response?.containers?.find(entry => containers.includes(entry.slot_type?.container_id))?.slots?.find(entry => entry.slot === slot)
    report.placeVariants = []
    let winner = null; let placed = null
    for (const variant of variants) {
      const response = await request(actionsFor(variant, slotInfo(ownContainer, own.index, own.stackId), slotInfo(variant.container, emptySlot, 0)))
      report.placeVariants.push({ label: variant.label, response })
      step('Place ' + variant.label, response)
      if (ok(response)) { winner = variant; placed = response; break }
    }
    const inChest = slotOf(placed, [winner?.container, 'level_entity', 'container'], emptySlot)
    report.placeWinner = winner?.label ?? null
    if (!winner) {
      report.result = 'place-rejected'
    } else if (!inChest) {
      report.result = 'place-unclear'
    } else {
      const back = slotOf(placed, [ownContainer], own.index)
      const take = await request(actionsFor(winner, slotInfo(winner.container, emptySlot, inChest.item_stack_id), slotInfo(ownContainer, own.index, back?.count ? back.item_stack_id : 0)))
      report.take = take
      step('Take back ' + winner.label, take)
      report.result = ok(take) ? 'passed' : 'take-rejected'
    }
  }

  // 5. Close the chest and record the server's answer.
  send('container_close', { window_id: windowId, window_type: open.window_type, server: false })
  report.containerClose = await nextPacket('container_close', 2000).catch(() => null)
  await wait(1000)
  report.inventoryAfter = bot.state.inventory.items()
}

main().catch(error => { report.error = error.stack || error.message; console.error(report.error); process.exitCode = 1 }).finally(() => {
  bot?.stop()
  fs.mkdirSync('data', { recursive: true })
  fs.writeFileSync('data/chest-smoke-result.json', JSON.stringify(report, null, 2) + '\n')
  console.log('Report: data/chest-smoke-result.json, result ' + report.result)
  setTimeout(() => process.exit(), 500).unref()
})
