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
  assert.deepEqual(said(), ['Hallo Alex!', 'Hallo Alex!', 'Befehle: hallo, go <Wegpunkt>, come, find <Block>, inventory, give <Item> [Anzahl], stop', 'Befehle: hallo, go <Wegpunkt>, come, find <Block>, inventory, give <Item> [Anzahl], stop'])
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
