// Explicit live test: logs in as its own bot instance (stop the regular bot first, it uses the same name),
// records the inventory the server reports and drops exactly one item: SMOKE_GIVE ("dirt" or "minecraft:dirt"),
// or the first item found when unset. The drop goes 2 blocks south of the bot; the raw item_stack_response lands in the report.
// With SMOKE_WATCH=<seconds> it drops nothing and instead records the packets that arrive while a player throws items to the bot.
const fs = require('node:fs')
const { createClient } = require('bedrock-protocol')
const { readConfig } = require('../dist/config.js')
const { BotController } = require('../dist/bot.js')

const config = readConfig()
const wanted = process.env.SMOKE_GIVE?.trim().toLowerCase().replace(/^minecraft:/, '') || null
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const report = { checkedAt: new Date().toISOString(), result: 'failed', host: config.host, wanted, packets: { item_registry: null, inventory_content: [], inventory_slot: [], item_stack_response: [] } }
const plain = value => JSON.parse(JSON.stringify(value, (key, item) => typeof item === 'bigint' ? item.toString() : item))
const watchSeconds = Number(process.env.SMOKE_WATCH || 0)
if (!Number.isInteger(watchSeconds) || watchSeconds < 0 || watchSeconds > 300) throw new Error('SMOKE_WATCH must be 0..300 seconds')
let watching = 0
let bot

async function until (predicate, ms, label) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (['dead', 'error'].includes(bot.state.status)) throw new Error('Bot ' + bot.state.status + ': ' + bot.state.lastError)
    if (predicate()) return
    await wait(50)
  }
  throw new Error('Timed out waiting for ' + label)
}

async function main () {
  bot = new BotController(config, options => {
    const client = createClient({
      host: options.host, port: options.port, version: options.version, username: options.username, transport: options.transport,
      offline: true, raknetBackend: 'jsp-raknet', skinData: { SelfSignedId: require('bedrock-protocol/src/datatypes/util').uuidFrom(options.username) },
      connectTimeout: 9000, pingTimeout: 5000, conLog: console.log,
      ...(options.transport === 'nethernet' ? { nethernet: { webrtcBackend: 'werift', signalling: 'http', serverKeyPath: './data/server-key.sha256', iceHost: options.iceHost } } : {})
    })
    // Raw packets for the report; the registry is summarised because it lists every item of the game.
    client.on('item_registry', packet => { report.packets.item_registry = { entries: packet.itemstates?.length ?? null, sample: plain(packet.itemstates?.slice(0, 3) ?? null) } })
    client.on('inventory_content', packet => report.packets.inventory_content.push(plain({ window_id: packet.window_id, container: packet.container,
      items: (packet.input ?? []).map((item, slot) => ({ slot, ...item })).filter(item => item.network_id) })))
    client.on('inventory_slot', packet => report.packets.inventory_slot.push(plain(packet)))
    client.on('item_stack_response', packet => report.packets.item_stack_response.push(plain(packet)))
    // SMOKE_WATCH: every packet name with its count, and the full content of item-related ones, to find how pickups arrive.
    client.on('packet', packet => {
      if (!watching) return
      const name = packet.data.name
      report.watch.counts[name] = (report.watch.counts[name] || 0) + 1
      if (/item|inventory|slot|equipment|take|container/.test(name) && report.watch.packets.length < 200) report.watch.packets.push({ at: Date.now() - watching, name, params: plain(packet.data.params) })
    })
    return client
  })
  bot.start()
  bot.enqueue('connect')
  await until(() => bot.state.status === 'spawned' && bot.state.position, 30000, 'spawn')
  await until(() => bot.state.inventory.known, 10000, 'inventory_content')
  report.position = { ...bot.state.position }
  report.before = bot.state.inventory.items()
  console.log('inventory', JSON.stringify(report.before))
  if (watchSeconds) {
    report.watch = { seconds: watchSeconds, counts: {}, packets: [] }
    console.log(`Watching packets for ${watchSeconds} s; throw an item to the bot now.`)
    watching = Date.now()
    await wait(watchSeconds * 1000)
    watching = 0
    report.after = bot.state.inventory.items()
    report.result = 'watched'
    return
  }
  const item = report.before.find(entry => !wanted || entry.name.replace(/^minecraft:/, '') === wanted)
  if (!item) {
    report.result = wanted ? 'item-missing' : 'inventory-empty'
    return
  }
  report.dropped = { name: item.name }
  const p = bot.state.position
  report.dropped.confirmed = await bot.dropItems(item.name, 1, { x: p.x, y: p.y, z: p.z + 2 })
  await wait(1000)
  report.after = bot.state.inventory.items()
  const before = item.count; const after = report.after.find(entry => entry.name === item.name)?.count ?? 0
  if (after !== before - 1) throw new Error(`Expected ${before - 1} ${item.name} after the drop, inventory shows ${after}`)
  report.result = 'passed'
}

main().catch(error => { report.error = error.stack || error.message; console.error(report.error); process.exitCode = 1 }).finally(() => {
  bot?.stop()
  fs.mkdirSync('data', { recursive: true })
  fs.writeFileSync('data/inventory-smoke-result.json', JSON.stringify(report, null, 2) + '\n')
  console.log('Report: data/inventory-smoke-result.json, result ' + report.result)
  setTimeout(() => process.exit(), 500).unref()
})
