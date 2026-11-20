const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { BotController } = require('../dist/bot.js')
const { readConfig } = require('../dist/config.js')
const { ChatCommands } = require('../dist/chat-commands.js')
const { PlaceStore } = require('../dist/places.js')
const { Terrain } = require('../dist/terrain.js')
const { WorldError } = require('../dist/world.js')

const config = readConfig({ BEDROCK_HOST: 'localhost', BOT_NAME: 'Peter Bot' })
class Client extends EventEmitter {
  entityId = 10n
  sent = []
  queue (name, params) { this.sent.push([name, params]) }
  close () { this.emit('close') }
}

function setup (t) {
  let time = 1000
  const clients = []
  const bot = new BotController(config, () => { const client = new Client(); clients.push(client); return client }, () => {}, () => time)
  t.after(() => bot.stop())
  bot.enqueue('connect'); bot.step()
  const client = clients[0]
  client.emit('start_game', { player_position: { x: .5, y: 72.62, z: .5 }, dimension: 0 })
  client.emit('spawn')
  // Flat, walkable floor at y=70 within |x|,|z| < 10.
  bot.state.terrain = new Terrain((x, y, z) => Math.abs(x) < 10 && Math.abs(z) < 10 ? { boxes: y === 70 ? [[0, 0, 0, 1, 1, 1]] : [], support: y === 70 } : null)
  bot.state.planningTerrain = bot.state.terrain
  bot.state.chunks.set('0:0', { x: 0, z: 0, sections: new Map(), attempts: new Map(), requests: new Map() })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-bot-chat-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const places = new PlaceStore(root, 'server', 'world')
  const chat = new ChatCommands(bot, places, 64, config.username, () => time)
  const said = () => client.sent.filter(([name]) => name === 'text').map(([, packet]) => packet.message)
  const advance = ms => { time += ms; bot.step() }
  // Each command uses a fresh sender time slot so the cooldown does not interfere.
  const command = async (message, sender = 'Alex') => { time += 5000; await chat.handle(sender, message) }
  return { bot, client, places, chat, said, advance, command }
}

test('player chat lines reach the handler; own, system and translated lines do not; say sends an authored chat packet', t => {
  const { bot, client } = setup(t)
  const seen = []
  bot.onChat = (sender, message) => seen.push([sender, message])
  client.emit('text', { type: 'chat', source_name: 'Alex', message: 'hi' })
  client.emit('text', { type: 'whisper', source_name: 'Bea', message: 'psst' })
  client.emit('text', { type: 'chat', source_name: 'Peter Bot', message: 'echo' })
  // The server echoes the bot's own lines with a trailing reset code.
  client.emit('text', { type: 'chat', source_name: 'Peter Bot§r', message: 'echo' })
  client.emit('text', { type: 'chat', source_name: 'Cleo§r', message: 'yo' })
  client.emit('text', { type: 'system', message: 'Server restart' })
  client.emit('text', { type: 'translation', message: 'chat.type.text', parameters: ['Alex', 'x'] })
  assert.deepEqual(seen, [['Alex', 'hi'], ['Bea', 'psst'], ['Cleo', 'yo']])
  assert.equal(bot.say('Moin'), true)
  assert.deepEqual(client.sent.at(-1), ['text', { needs_translation: false, category: 'authored', type: 'chat', source_name: 'Peter Bot', message: 'Moin',
    xuid: '', platform_chat_id: '', has_filtered_message: false }])
})

test('the chat log keeps player lines, whispers, bot replies and connection marks, without formatting codes and capped at 100', t => {
  const { bot, client } = setup(t)
  const lines = () => bot.chatLog().lines.map(line => [line.kind, line.name, line.text])
  assert.deepEqual(lines(), [['event', '', 'Verbunden']])
  const revision = bot.chatRevision
  client.emit('text', { type: 'chat', source_name: '§aAlex', message: '§lhi' })
  client.emit('text', { type: 'whisper', source_name: 'Bea', message: 'psst' })
  client.emit('text', { type: 'chat', source_name: 'Peter Bot', message: 'echo' })
  client.emit('text', { type: 'system', message: 'Server restart' })
  bot.say('Moin')
  assert.equal(bot.chatRevision, revision + 3)
  assert.deepEqual(lines(), [['event', '', 'Verbunden'], ['chat', 'Alex', 'hi'], ['whisper', 'Bea', 'psst'], ['bot', 'Peter Bot', 'Moin']])
  for (let i = 0; i < 120; i++) client.emit('text', { type: 'chat', source_name: 'Alex', message: 'line ' + i })
  bot.enqueue('disconnect'); bot.step()
  assert.equal(bot.chatLog().lines.length, 100)
  assert.deepEqual(lines().slice(0, 1), [['chat', 'Alex', 'line 21']])
  assert.deepEqual(lines().slice(-2), [['chat', 'Alex', 'line 119'], ['event', '', 'Verbindung getrennt']])
  // Copies, so callers cannot change the log.
  bot.chatLog().lines[0].text = 'changed'
  assert.equal(bot.chatLog().lines[0].text, 'line 21')
})

test('the bot name prefix is case-insensitive, allows @ and a separator, and must stand alone', async t => {
  const { said, command } = setup(t)
  await command('@peter bot, Hallo')
  await command('PETER  BOT: hey')
  await command('Peter Botty hallo')
  await command('ich sag Peter Bot hallo')
  await command('Peter Bot tanz')
  await command('Peter Bot')
  assert.deepEqual(said(), ['Hallo Alex!', 'Hallo Alex!', 'Befehle: hallo, go <Wegpunkt>, come, find <Block>, inventory, give <Item> [Anzahl], put <Item>|all [Anzahl], get <Item> [Anzahl], farming on|once|off [Wegpunkt], stop', 'Befehle: hallo, go <Wegpunkt>, come, find <Block>, inventory, give <Item> [Anzahl], put <Item>|all [Anzahl], get <Item> [Anzahl], farming on|once|off [Wegpunkt], stop'])
})

test('a player gets one command per 2 s; other players are not throttled', async t => {
  const { chat, said, advance } = setup(t)
  await chat.handle('Alex', 'Peter Bot hi')
  await chat.handle('Alex', 'Peter Bot hi')
  await chat.handle('Bea', 'Peter Bot hi')
  advance(2000)
  await chat.handle('Alex', 'Peter Bot hi')
  assert.deepEqual(said(), ['Hallo Alex!', 'Hallo Bea!', 'Hallo Alex!'])
})

test('go resolves waypoints exactly, then by unique prefix, and checks the reach', async t => {
  const { bot, places, said, command } = setup(t)
  await places.add({ name: 'Haus', icon: 'home', x: 3, z: 0, dimension: 0 })
  await places.add({ name: 'Hausboot', icon: 'home', x: 5, z: 0, dimension: 0 })
  await places.add({ name: 'Mine Nord', icon: 'mine', x: 0, z: -4, dimension: 0 })
  await places.add({ name: 'Ferne', icon: 'star', x: 500, z: 0, dimension: 0 })
  await places.add({ name: 'Nether', icon: 'portal', x: 1, z: 1, dimension: 1 })
  await command('Peter Bot go')
  await command('Peter Bot go Ha')
  await command('Peter Bot go nether')
  await command('Peter Bot go ferne')
  await command('Peter Bot go mine   nord')
  assert.deepEqual(said(), ['Wohin? go <Wegpunkt>', 'Mehrdeutig: Haus, Hausboot', 'Wegpunkt "nether" kenne ich nicht.', 'Ferne ist zu weit weg (500 Blöcke).', 'Unterwegs zu Mine Nord (5 Blöcke).'])
  await command('Peter Bot go haus')
  assert.equal(said().at(-1), 'Unterwegs zu Haus (3 Blöcke).')
})

test('a chat navigation via come reports replacement, stop and failure; web navigations stay silent', async t => {
  const { bot, said, advance, command } = setup(t)
  await command('Peter Bot come')
  assert.equal(said().at(-1), 'Ich sehe dich nicht, Alex.')
  bot.state.players.set('7', { name: 'Alex', position: { x: 6.5, y: 72.62, z: .5 }, uniqueId: '7', uuid: 'u' })
  await command('Peter Bot come')
  assert.equal(said().at(-1), 'Unterwegs zu Alex (4 Blöcke).')
  advance(50)
  assert.deepEqual(bot.state.navigation.target, { x: 4, z: 0 })
  assert.deepEqual(bot.navigationOrigin, { player: 'Alex', label: 'Alex' })
  // The web UI replaces the chat target: the chat run ends as aborted, the web run itself stays silent.
  // Chunk 0:0 is the only loaded column, so the target must have non-negative X/Z.
  bot.enqueue({ type: 'navigate', x: 2, z: 5 }); advance(50)
  assert.equal(said().at(-1), 'Weg zu Alex abgebrochen.')
  const count = said().length
  await command('Peter Bot stop')
  advance(50)
  assert.equal(bot.state.navigation.status, 'stopped')
  assert.deepEqual(said().slice(count), ['Angehalten.'])
  await command('Peter Bot stop')
  assert.equal(said().at(-1), 'Ich laufe gerade nicht.')
  // A chat run stopped by chat reports only through its end message.
  await command('Peter Bot come')
  advance(50)
  const before = said().length
  await command('Peter Bot stop')
  advance(50)
  assert.deepEqual(said().slice(before), ['Weg zu Alex abgebrochen.'])
  // A target outside the walkable floor fails and is reported.
  bot.state.players.get('7').position = { x: 30.5, y: 72.62, z: .5 }
  await command('Peter Bot come')
  advance(50)
  for (let i = 0; i < 400 && ['planning', 'moving'].includes(bot.state.navigation.status); i++) advance(50)
  assert.match(said().at(-1), /^Weg zu Alex fehlgeschlagen: /)
})

test('a chat navigation reports arrival', async t => {
  const { bot, places, said, advance, command } = setup(t)
  await places.add({ name: 'Haus', icon: 'home', x: 3, z: 0, dimension: 0 })
  await command('Peter Bot go Haus')
  for (let i = 0; i < 400 && bot.state.navigation.status !== 'arrived'; i++) advance(50)
  assert.equal(bot.state.navigation.status, 'arrived')
  assert.equal(said().at(-1), 'Angekommen bei Haus.')
})

test('find searches from the asking player when visible, else from the bot, and explains failures', async t => {
  const { bot, said, command } = setup(t)
  const origins = []
  let next = () => ({ blockId: 'minecraft:diamond_ore', hits: [{ x: 1, y: 12, z: 3, distance: 9.6 }], outcome: 'found' })
  bot.state.searchBlocks = async (id, limit, origin) => { origins.push([id, limit, origin]); return next() }
  await command('Peter Bot find Diamond_Ore')
  bot.state.players.set('7', { name: 'Alex', position: { x: 4, y: 64, z: 4 }, uniqueId: '7', uuid: 'u' })
  await command('Peter Bot find minecraft:diamond_ore')
  assert.deepEqual(origins, [['diamond_ore', 1, { x: .5, y: 72.62, z: .5 }], ['minecraft:diamond_ore', 1, { x: 4, y: 64, z: 4 }]])
  next = () => ({ blockId: 'minecraft:gold_ore', hits: [], outcome: 'unknown' })
  await command('Peter Bot find gold_ore')
  next = () => ({ blockId: 'minecraft:gold_ore', hits: [], outcome: 'not_found' })
  await command('Peter Bot find gold_ore')
  next = () => { throw new WorldError('A search is already running', 429) }
  await command('Peter Bot find gold_ore')
  next = () => { throw new WorldError('Unknown block ID: minecraft:goldd', 400) }
  await command('Peter Bot find goldd')
  await command('Peter Bot find')
  assert.deepEqual(said(), [
    'Nächstes diamond_ore: 1 12 3 (10 Blöcke von mir).',
    'Nächstes diamond_ore: 1 12 3 (10 Blöcke von dir).',
    'Kein gold_ore gefunden; die Umgebung ist noch nicht vollständig geladen.',
    'Kein gold_ore im geladenen Bereich.',
    'Suche läuft schon, versuch es gleich nochmal.',
    'Den Block goldd kenne ich nicht.',
    'Was soll ich suchen? find <Block>'
  ])
})

test('CHAT_COMMANDS defaults to on and accepts only on or off', () => {
  assert.equal(readConfig({ BEDROCK_HOST: 'localhost' }).chatCommands, true)
  assert.equal(readConfig({ BEDROCK_HOST: 'localhost', CHAT_COMMANDS: 'off' }).chatCommands, false)
  assert.throws(() => readConfig({ BEDROCK_HOST: 'localhost', CHAT_COMMANDS: 'yes' }), /CHAT_COMMANDS/)
})

const stack = (network_id, count, stack_id) => ({ network_id, count, metadata: 0, has_stack_id: true, stack_id, block_runtime_id: 0, extra: { has_nbt: false, can_place_on: [], can_destroy: [] } })
const registry = [['dirt', 3], ['torch', 50], ['oak_log', 17], ['oak_planks', 5], ['stone', 1], ['cobblestone', 4], ['sand', 12], ['gravel', 13], ['glass', 20], ['apple', 260]]
  .map(([name, runtime_id]) => ({ name: 'minecraft:' + name, runtime_id, component_based: false, version: 0, nbt: null }))
const settle = () => new Promise(resolve => setImmediate(resolve))
const lastRequest = client => client.sent.filter(([name]) => name === 'item_stack_request').at(-1)?.[1].requests[0]
const confirm = (client, request, slots) => client.emit('item_stack_response', { responses: [{ status: 'ok', request_id: request.request_id,
  containers: slots.map(([container_id, slot, count, item_stack_id]) => ({ slot_type: { container_id }, slots: [{ slot, hotbar_slot: slot, count, item_stack_id, custom_name: '', filtered_custom_name: '', durability_correction: 0 }] })) }] })

test('inventory packets fill the item totals; drops send one request per item, apply the response and fail on rejection, timeout and disconnect', async t => {
  const { bot, client, advance } = setup(t)
  const inventory = bot.state.inventory
  assert.equal(inventory.known, false)
  client.emit('item_registry', { itemstates: registry })
  const content = Array(36).fill({ network_id: 0, count: 0 })
  content[0] = stack(3, 64, 7); content[12] = stack(3, 5, 8); content[3] = stack(50, 3, 9)
  client.emit('inventory_content', { window_id: 'inventory', input: content })
  // Armour and other windows are not part of the inventory.
  client.emit('inventory_content', { window_id: 'armor', input: [stack(50, 1, 1)] })
  assert.equal(inventory.known, true)
  assert.deepEqual(inventory.items(), [{ name: 'minecraft:dirt', count: 69 }, { name: 'minecraft:torch', count: 3 }])
  // An item missing from the registry keeps its network ID.
  client.emit('inventory_slot', { window_id: 'inventory', slot: 4, item: stack(99, 2, 10) })
  assert.deepEqual(inventory.items().at(-1), { name: '#99', count: 2 })
  client.emit('inventory_slot', { window_id: 'inventory', slot: 4, item: { network_id: 0, count: 0 } })
  // A pickup: the server sends a transaction with the slot's new item; the picked-up entity's action is ignored.
  client.emit('inventory_transaction', { transaction: { legacy: { legacy_request_id: 0 }, transaction_type: 'normal', actions: [
    { source_type: 'container', window_id: 0, slot: 3, old_item: stack(50, 3, 9), new_item: stack(50, 4, 12) },
    { source_type: 'world_interaction', flags: 0, slot: 1, old_item: stack(50, 1, 0), new_item: { network_id: 0, count: 0 } }
  ] } })
  assert.deepEqual(inventory.items().at(-1), { name: 'minecraft:torch', count: 4 })
  client.emit('inventory_transaction', { transaction: { transaction_type: 'normal', actions: [
    { source_type: 'container', window_id: 0, slot: 3, old_item: stack(50, 4, 12), new_item: stack(50, 3, 13) }
  ] } })
  const revision = inventory.revision
  const done = bot.dropItems('minecraft:dirt', 66, { x: 3.5, y: 72.62, z: .5 })
  advance(50)
  const [look, sent] = client.sent.filter(([name]) => name === 'player_auth_input' || name === 'item_stack_request').slice(-2)
  // The bot faces the receiver (east, yaw -90) before the drop.
  assert.equal(look[0], 'player_auth_input')
  assert.equal(Math.round(look[1].yaw), -90)
  assert.deepEqual(look[1].move_vector, { x: 0, z: 0 })
  assert.equal(sent[0], 'item_stack_request')
  const request = sent[1].requests[0]
  assert.ok(request.request_id < 0)
  assert.deepEqual(request.actions.map(action => [action.type_id, action.count, action.source.slot_type.container_id, action.source.slot, action.source.stack_id, action.randomly]),
    [['drop', 64, 'hotbar', 0, 7, false], ['drop', 2, 'inventory', 12, 8, false]])
  confirm(client, request, [['hotbar', 0, 0, 0], ['inventory', 12, 3, 11]])
  assert.equal(await done, 66)
  assert.ok(inventory.revision > revision)
  assert.deepEqual(inventory.items(), [{ name: 'minecraft:dirt', count: 3 }, { name: 'minecraft:torch', count: 3 }])
  const rejected = bot.dropItems('minecraft:torch', 1, { x: 0, y: 72.62, z: 5 })
  advance(50)
  client.emit('item_stack_response', { responses: [{ status: 'error', request_id: lastRequest(client).request_id }] })
  await assert.rejects(rejected, /abgelehnt/)
  assert.deepEqual(inventory.items().at(-1), { name: 'minecraft:torch', count: 3 }, 'A rejected drop changes nothing')
  const unanswered = bot.dropItems('minecraft:torch', 1, { x: 0, y: 72.62, z: 5 })
  advance(50); advance(3000)
  await assert.rejects(unanswered, /nicht geantwortet/)
  const lost = bot.dropItems('minecraft:torch', 1, { x: 0, y: 72.62, z: 5 })
  bot.enqueue('disconnect'); bot.step()
  await assert.rejects(lost, /getrennt/)
  assert.equal(inventory.known, false)
  assert.deepEqual(inventory.items(), [])
  await assert.rejects(bot.dropItems('minecraft:torch', 1, { x: 0, y: 72.62, z: 5 }), /nicht verbunden/)
})

test('inventory lists item totals; give walks up, throws towards the sender and reports partial amounts and runaways', async t => {
  const { bot, client, said, advance, command } = setup(t)
  await command('Peter Bot inventory')
  assert.equal(said().at(-1), 'Mein Inventar ist noch unbekannt.')
  client.emit('item_registry', { itemstates: registry })
  client.emit('inventory_content', { window_id: 'inventory', input: [] })
  await command('Peter Bot inv')
  assert.equal(said().at(-1), 'Mein Inventar ist leer.')
  client.emit('inventory_content', { window_id: 'inventory', input: [stack(3, 12, 1), stack(50, 3, 2), stack(17, 10, 3), stack(5, 9, 4), stack(1, 8, 5),
    stack(4, 7, 6), stack(12, 6, 7), stack(13, 5, 8), stack(20, 4, 9), stack(260, 2, 10)] })
  await command('Peter Bot INV')
  assert.equal(said().at(-1), 'Inventar: dirt ×12, oak_log ×10, oak_planks ×9, stone ×8, cobblestone ×7, sand ×6, gravel ×5, glass ×4 … +2 weitere')
  await command('Peter Bot give')
  await command('Peter Bot give diamond')
  await command('Peter Bot give oak')
  await command('Peter Bot give dirt 0')
  await command('Peter Bot give minecraft:dirt')
  assert.deepEqual(said().slice(-5), ['Was soll ich geben? give <Item> [Anzahl]', 'Ich habe kein diamond.', 'Mehrdeutig: oak_log, oak_planks',
    'Die Anzahl muss zwischen 1 und 2304 liegen.', 'Ich sehe dich nicht, Alex.'])
  // A sender within reach gets the items at once, all of them without a count.
  bot.state.players.set('7', { name: 'Alex', position: { x: 1.5, y: 72.62, z: .5 }, uniqueId: '7', uuid: 'u' })
  await command('Peter Bot give Dirt')
  advance(50)
  let request = lastRequest(client)
  assert.deepEqual(request.actions.map(action => [action.count, action.source.slot]), [[12, 0]])
  confirm(client, request, [['hotbar', 0, 0, 0]])
  await settle()
  assert.equal(said().at(-1), 'Hier, 12 dirt.')
  // A sender further away is approached first; asking for more than the bot has drops what there is.
  bot.state.players.get('7').position = { x: 6.5, y: 72.62, z: .5 }
  await command('Peter Bot give torch 5')
  assert.equal(said().at(-1), 'Unterwegs zu Alex (4 Blöcke).')
  for (let i = 0; i < 400 && bot.state.navigation.status !== 'arrived'; i++) advance(50)
  assert.equal(bot.state.navigation.status, 'arrived')
  advance(50)
  request = lastRequest(client)
  assert.deepEqual(request.actions.map(action => [action.count, action.source.slot]), [[3, 1]])
  confirm(client, request, [['hotbar', 1, 0, 0]])
  await settle()
  assert.equal(said().at(-1), 'Ich habe nur 3 torch, hier sind sie.')
  assert.ok(!said().includes('Angekommen bei Alex.'), 'A give run ends with the hand-over, not an arrival line')
  // A sender who walks away keeps nothing.
  bot.state.players.get('7').position = { x: 9.5, y: 72.62, z: .5 }
  await command('Peter Bot give glass 2')
  bot.state.players.get('7').position = { x: -8.5, y: 72.62, z: .5 }
  const requests = client.sent.filter(([name]) => name === 'item_stack_request').length
  advance(50)
  assert.ok(['planning', 'moving'].includes(bot.state.navigation.status))
  for (let i = 0; i < 400 && bot.state.navigation.status !== 'arrived'; i++) advance(50)
  advance(50)
  assert.equal(said().at(-1), 'Du bist weggelaufen, Alex. Ich behalte die Sachen.')
  assert.equal(client.sent.filter(([name]) => name === 'item_stack_request').length, requests)
})

// put/get: a fake server opens chests on click, applies place requests to its own copy of the slots and checks the stack IDs.
const { nextTransfer } = require('../dist/inventory.js')
const slotItem = (id, count, stackId) => ({ id, count, stack: stackId })
const packetItem = slot => slot ? stack(slot.id, slot.count, slot.stack) : { network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0 }
const chestAt = (x, z, size, items = {}, extra = {}) => ({ x, y: 71, z, slots: Array.from({ length: size }, (_, i) => items[i] ?? null), ...extra })

function chestSetup (t, chests, ownItems) {
  const env = setup(t)
  const { bot, client } = env
  client.emit('item_registry', { itemstates: registry })
  const own = Array.from({ length: 36 }, (_, i) => ownItems[i] ?? null)
  client.emit('inventory_content', { window_id: 'inventory', input: own.map(packetItem) })
  let searched = null
  bot.state.searchBlocks = async (ids, limit, origin) => {
    searched = { ids, limit, origin }
    return { hits: chests.map(({ x, y, z }) => ({ x, y, z, distance: Math.hypot(x - origin.x, y - origin.y, z - origin.z) })), outcome: 'found' }
  }
  bot.state.blockRuntimeIdAt = () => 77
  const clicks = []; const requests = []
  let seen = 0; let open = null; let nextStack = 1000
  const respond = request => {
    const action = request.actions[0]
    requests.push(action)
    assert.equal(action.type_id, 'place')
    const side = container => container === 'container' ? open.slots : own
    const from = side(action.source.slot_type.container_id); const to = side(action.destination.slot_type.container_id)
    const source = from[action.source.slot]; const target = to[action.destination.slot]
    assert.ok(source && source.stack === action.source.stack_id && action.count <= source.count, 'Source slot and stack ID match the server')
    assert.equal(target?.stack ?? 0, action.destination.stack_id, 'Destination stack ID matches the server')
    assert.ok(!target || target.id === source.id, 'Only the same item stacks')
    source.count -= action.count
    if (!source.count) from[action.source.slot] = null
    if (target) target.count += action.count
    else to[action.destination.slot] = slotItem(source.id, action.count, nextStack++)
    const entry = (container, slot, list) => ({ slot_type: { container_id: container }, slots: [{ slot, hotbar_slot: slot, count: list[slot]?.count ?? 0, item_stack_id: list[slot]?.stack, custom_name: '', filtered_custom_name: '', durability_correction: 0 }] })
    client.emit('item_stack_response', { responses: [{ status: 'ok', request_id: request.request_id, containers: [
      entry(action.source.slot_type.container_id, action.source.slot, from), entry(action.destination.slot_type.container_id, action.destination.slot, to)] }] })
  }
  const tick = async () => {
    env.advance(50)
    while (seen < client.sent.length) {
      const [name, params] = client.sent[seen++]
      if (name === 'inventory_transaction' && params.transaction.transaction_data?.action_type === 'click_block') {
        const p = params.transaction.transaction_data.block_position
        clicks.push({ ...p, next: client.sent[seen]?.[0] })
        const chest = chests.find(c => c.x === p.x && c.y === p.y && c.z === p.z)
        if (!chest || chest.locked) continue
        open = chest
        client.emit('container_open', { window_id: 2, window_type: 'container', coordinates: p, runtime_entity_id: -1n })
        client.emit('inventory_content', { window_id: 2, input: chest.slots.map(packetItem) })
        client.emit('inventory_content', { window_id: 'inventory', input: own.map(packetItem) })
      } else if (name === 'item_stack_request') respond(params.requests[0])
      else if (name === 'container_close') { open = null; client.emit('container_close', { window_id: 2, window_type: 'none', server: false }) }
    }
    await settle()
  }
  const ticks = async (count, until = () => false) => { for (let i = 0; i < count && !until(); i++) await tick() }
  const last = () => env.said().at(-1) ?? ''
  return { ...env, own, clicks, requests, ticks, last, searched: () => searched, closes: () => client.sent.filter(([name]) => name === 'container_close').length }
}

test('nextTransfer fills partial stacks up to the item stack size before empty slots and names both containers', () => {
  const own = [{ name: 'minecraft:ender_pearl', count: 10, stackId: 4, raw: null }]
  const chest = [null, { name: 'minecraft:ender_pearl', count: 12, stackId: 9, raw: null }]
  assert.deepEqual(nextTransfer(own, () => 'hotbar', chest, () => 'container', 'minecraft:ender_pearl', Infinity),
    { move: { name: 'minecraft:ender_pearl', count: 4, from: { container: 'hotbar', slot: 0, stackId: 4 }, to: { container: 'container', slot: 1, stackId: 9 } } })
  assert.deepEqual(nextTransfer(own, () => 'hotbar', [{ name: 'minecraft:dirt', count: 1, stackId: 1, raw: null }], () => 'container', null, 5), { stop: 'target_full' })
  assert.deepEqual(nextTransfer(own, () => 'hotbar', chest, () => 'container', 'minecraft:dirt', 5), { stop: 'source_empty' })
  assert.deepEqual(nextTransfer(own, () => 'hotbar', chest, () => 'container', null, 0), { stop: 'done' })
})

test('put clicks the nearest chest, sends an input tick after the click, fills partial stacks first and reports the total', async t => {
  const chest = chestAt(1, 0, 27, { 0: slotItem(3, 60, 50), 1: slotItem(50, 1, 51) })
  const { bot, said, last, command, clicks, requests, ticks, closes, searched } = chestSetup(t, [chest], { 0: slotItem(3, 64, 1), 1: slotItem(50, 3, 3), 9: slotItem(3, 10, 2) })
  await command('Peter Bot put')
  await command('Peter Bot put diamond')
  assert.deepEqual(said().slice(-2), ['Was soll ich ablegen? put <Item>|all [Anzahl]', 'Ich habe kein diamond.'])
  await command('Peter Bot put dirt')
  await ticks(40, () => !bot.chestBusy && last().includes('abgelegt'))
  assert.equal(clicks.length, 1)
  assert.equal(clicks[0].next, 'player_auth_input', 'The server handles the click only with a following input packet')
  assert.deepEqual(requests.map(action => [action.source.slot_type.container_id, action.source.slot, action.destination.slot_type.container_id, action.destination.slot, action.count]),
    [['hotbar', 0, 'container', 0, 4], ['hotbar', 0, 'container', 2, 60], ['inventory', 9, 'container', 2, 4], ['inventory', 9, 'container', 3, 6]])
  assert.equal(last(), '74 dirt in 1 Kiste abgelegt.')
  assert.equal(closes(), 1)
  assert.deepEqual(bot.state.inventory.items(), [{ name: 'minecraft:torch', count: 3 }])
  assert.deepEqual(chest.slots.slice(0, 4).map(slot => slot && slot.count), [64, 1, 64, 6])
  const ids = searched().ids
  assert.ok(ids.includes('chest') && ids.includes('trapped_chest') && ids.includes('waxed_oxidized_copper_chest') && !ids.includes('ender_chest') && !ids.includes('barrel'))
})

test('put moves on to the next chest when one is full and moves only what the bot has; put all empties the inventory', async t => {
  const full = chestAt(1, 0, 27, Object.fromEntries(Array.from({ length: 27 }, (_, i) => [i, slotItem(4, 64, 100 + i)])))
  const empty = chestAt(-1, 0, 27)
  const { bot, said, last, command, clicks, ticks } = chestSetup(t, [full, empty], { 0: slotItem(3, 5, 1), 3: slotItem(50, 2, 2) })
  await command('Peter Bot put dirt 10')
  await ticks(60, () => !bot.chestBusy && last().startsWith('Ich hatte'))
  assert.deepEqual(clicks.map(click => click.x), [1, -1])
  assert.ok(said().includes('Kiste voll, versuche die nächste.'))
  assert.equal(last(), 'Ich hatte nur 5 dirt, in 2 Kisten abgelegt.')
  await command('Peter Bot put all')
  await ticks(60, () => !bot.chestBusy && last().includes('Gegenstände'))
  assert.equal(last(), '2 Gegenstände in 2 Kisten abgelegt.')
  assert.deepEqual(bot.state.inventory.items(), [])
  assert.deepEqual(empty.slots.slice(0, 2).map(slot => slot && [slot.id, slot.count]), [[3, 5], [50, 2]])
})

test('get resolves the item by prefix in the chest, collects from the next chest and reports a full inventory or ambiguity', async t => {
  const first = chestAt(1, 0, 27, { 3: slotItem(4, 64, 60) })
  const second = chestAt(-1, 0, 27, { 0: slotItem(4, 64, 61), 1: slotItem(17, 2, 62), 2: slotItem(5, 2, 63) })
  const { bot, said, last, command, ticks, own } = chestSetup(t, [first, second], {})
  await command('Peter Bot get')
  assert.equal(last(), 'Was soll ich holen? get <Item> [Anzahl]')
  await command('Peter Bot get cobble 70')
  await ticks(60, () => !bot.chestBusy && last().includes('geholt'))
  assert.ok(said().includes('Hier nur 64 cobblestone, versuche die nächste.'))
  assert.equal(last(), '70 cobblestone aus 2 Kisten geholt.')
  assert.deepEqual(bot.state.inventory.items(), [{ name: 'minecraft:cobblestone', count: 70 }])
  assert.equal(second.slots[0].count, 58)
  await command('Peter Bot get oak')
  await ticks(60, () => !bot.chestBusy && last().startsWith('Mehrdeutig'))
  assert.equal(last(), 'Mehrdeutig: oak_log, oak_planks')
  // A full inventory ends the run.
  for (let i = 0; i < 36; i++) own[i] = slotItem(12, 64, 200 + i)
  bot.state.inventory.setContent(own.map(packetItem))
  await command('Peter Bot get oak_log')
  await ticks(60, () => !bot.chestBusy && last() === 'Nichts geholt.')
  assert.deepEqual(said().slice(-2), ['Mein Inventar ist voll.', 'Nichts geholt.'])
})

test('a chest that does not open is skipped; stop during the transfer closes the chest and reports the partial amount', async t => {
  const locked = chestAt(1, 0, 27, {}, { locked: true })
  const open = chestAt(-1, 0, 27)
  const { bot, last, command, clicks, requests, ticks, closes } = chestSetup(t, [locked, open], { 0: slotItem(3, 64, 1), 1: slotItem(3, 64, 2), 2: slotItem(3, 64, 3) })
  await command('Peter Bot put dirt')
  await ticks(80, () => requests.length > 0)
  assert.deepEqual(clicks.map(click => click.x), [1, -1], 'The locked chest is given up after 2 s')
  assert.equal(closes(), 0, 'A chest that never opened is not closed')
  await command('Peter Bot stop')
  await ticks(20, () => !bot.chestBusy && last().startsWith('Abgebrochen'))
  assert.equal(requests.length, 1)
  assert.equal(closes(), 1)
  assert.equal(last(), 'Abgebrochen. 64 dirt in 1 Kiste abgelegt.')
})

test('a double chest counts once; a chest out of reach is walked to without an arrival line', async t => {
  const big = chestAt(1, 0, 54, Object.fromEntries(Array.from({ length: 54 }, (_, i) => [i, slotItem(4, 64, 100 + i)])))
  const otherHalf = chestAt(1, 1, 54)
  const far = chestAt(6, 0, 27)
  const { bot, said, last, command, clicks, ticks } = chestSetup(t, [big, otherHalf, far], { 0: slotItem(3, 1, 1) })
  await command('Peter Bot put dirt')
  await ticks(600, () => !bot.chestBusy && last().includes('abgelegt'))
  assert.deepEqual(clicks.map(click => [click.x, click.z]), [[1, 0], [6, 0]], 'The other half of the double chest is not opened again')
  assert.equal(last(), '1 dirt in 2 Kisten abgelegt.')
  assert.ok(!said().some(line => line.startsWith('Angekommen')))
  assert.ok(Math.hypot(bot.state.position.x - 6.5, bot.state.position.z - .5) < 2, 'The bot stands next to the far chest')
})

test('farming on/once/off and status via chat; places as anchor, reach check, stop switches it off, other commands pause it', async t => {
  const { bot, places, said, command } = setup(t)
  await places.add({ name: 'Feld', icon: 'farm', x: 4, z: 2, dimension: 0 })
  await places.add({ name: 'Ferne', icon: 'star', x: 500, z: 0, dimension: 0 })
  await command('Peter Bot farming')
  assert.equal(said().at(-1), 'Farming ist aus.')
  await command('Peter Bot farming off')
  assert.equal(said().at(-1), 'Farming ist schon aus.')
  await command('Peter Bot farming maybe')
  assert.equal(said().at(-1), 'farming on [Wegpunkt], farming once [Wegpunkt], farming off oder farming')
  await command('Peter Bot farming on ferne')
  assert.equal(said().at(-1), 'Ferne ist zu weit weg (500 Blöcke).')
  await command('Peter Bot farming on unbekannt')
  assert.equal(said().at(-1), 'Wegpunkt "unbekannt" kenne ich nicht.')
  assert.equal(bot.farm.status().enabled, false)
  await command('Peter Bot farm on fe')
  assert.equal(said().at(-1), 'Mehrdeutig: Feld, Ferne')
  await command('Peter Bot farming on feld')
  assert.equal(said().at(-1), 'Farming an: Feld, Radius 24.')
  assert.deepEqual(bot.farm.status().anchor, { x: 4.5, z: 2.5, label: 'Feld' })
  await command('Peter Bot farming')
  assert.equal(said().at(-1), 'Farming an bei Feld (Radius 24): Startet.')
  // Moving commands pause farming for a minute; harmless ones do not.
  await command('Peter Bot inventory')
  assert.equal(bot.farm.status().pausedUntil, null)
  await command('Peter Bot come')
  assert.ok(bot.farm.status().pausedUntil > 0)
  assert.equal(bot.farm.status().activity, 'Pausiert (Chat-Befehl)')
  await command('Peter Bot stop')
  assert.equal(said().at(-1), 'Farming aus (Stopp).')
  assert.equal(bot.farm.status().enabled, false)
  await command('Peter Bot farming once', 'Bea')
  assert.equal(said().at(-1), 'Farming einmal: meiner Position, Radius 24.')
  assert.equal(bot.farm.status().once, true)
  await command('Peter Bot farming off', 'Bea')
  assert.equal(said().at(-1), 'Farming aus.')
})
