// Explicit live test: logs in as its own bot instance (stop the regular bot first, it uses the same name), stands still and
// records the entity packets of everything except players and items for SMOKE_WATCH seconds (default 60): add_entity,
// move_entity_delta, move_entity, set_entity_motion, set_entity_data, remove_entity and set_entity_link.
// SMOKE_ENTITY=<type> ("horse" or "minecraft:horse") limits the report to one type.
// For the P1 degree question it also records the rotation fields of players' move_entity_delta next to their move_player yaw.
// Walk around the animals, ride one or name one while it runs.
const fs = require('node:fs')
const { createClient } = require('bedrock-protocol')
const { readConfig } = require('../dist/config.js')
const { BotController } = require('../dist/bot.js')

const config = readConfig()
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const plain = value => JSON.parse(JSON.stringify(value, (key, item) => typeof item === 'bigint' ? item.toString() : item))
const shortType = type => String(type ?? '').replace(/^minecraft:/, '')
const wanted = shortType(process.env.SMOKE_ENTITY?.trim().toLowerCase()) || null
const watchSeconds = Number(process.env.SMOKE_WATCH || 60)
if (!Number.isInteger(watchSeconds) || watchSeconds < 1 || watchSeconds > 600) throw new Error('SMOKE_WATCH must be 1..600 seconds')
const MAX_MOVES = 20
const MAX_DATA = 100
const MAX_PLAYER_SAMPLES = 40

const report = { checkedAt: new Date().toISOString(), result: 'failed', host: config.host, wanted, seconds: watchSeconds, counts: {}, entities: {}, links: [], unknownIds: {}, players: {}, summary: {} }
const byUnique = new Map() // unique ID -> runtime ID of recorded entities
const players = new Map() // runtime ID -> name
let started = 0
let bot

const at = () => started ? Date.now() - started : 0

function range (stats, field, value) {
  if (!Number.isFinite(value)) return
  const entry = stats[field] ??= { min: value, max: value, count: 0 }
  entry.min = Math.min(entry.min, value); entry.max = Math.max(entry.max, value); entry.count++
}

function entityFor (id, name) {
  const entity = report.entities[id]
  if (entity) return entity
  if (!players.has(id)) report.unknownIds[name] = (report.unknownIds[name] || 0) + 1
  return null
}

function onPacket (name, params) {
  report.counts[name] = (report.counts[name] || 0) + 1
  if (name === 'add_player') {
    players.set(String(params.runtime_id), String(params.username ?? ''))
    return
  }
  if (name === 'move_player') {
    const id = String(params.runtime_id)
    const player = report.players[id]
    if (player && player.movePlayer.length < MAX_PLAYER_SAMPLES) player.movePlayer.push({ at: at(), yaw: params.yaw, pitch: params.pitch, head_yaw: params.head_yaw })
    return
  }
  if (name === 'add_entity') {
    const type = shortType(params.entity_type)
    if (wanted && type !== wanted) return
    const id = String(params.runtime_id)
    report.entities[id] = { type, uniqueId: String(params.unique_id), addedAt: at(), add: plain(params), moves: [], motion: 0, data: [], rotation: {}, removedAt: null }
    byUnique.set(String(params.unique_id), id)
    return
  }
  if (name === 'move_entity_delta' || name === 'move_entity' || name === 'set_entity_motion') {
    const id = String(params.runtime_entity_id)
    if (players.has(id) && name === 'move_entity_delta') {
      const player = report.players[id] ??= { name: players.get(id), delta: {}, deltaSamples: [], movePlayer: [] }
      for (const field of ['rot_x', 'rot_y', 'rot_z']) range(player.delta, field, params[field])
      if (player.deltaSamples.length < MAX_PLAYER_SAMPLES && (params.rot_x !== undefined || params.rot_y !== undefined)) player.deltaSamples.push({ at: at(), rot_x: params.rot_x, rot_y: params.rot_y, rot_z: params.rot_z })
      return
    }
    const entity = entityFor(id, name)
    if (!entity) return
    if (name === 'set_entity_motion') entity.motion++
    if (name === 'move_entity_delta') for (const field of ['rot_x', 'rot_y', 'rot_z']) range(entity.rotation, field, params[field])
    if (name === 'move_entity') for (const [field, value] of Object.entries(params.rotation ?? {})) range(entity.rotation, 'move_entity.' + field, value)
    if (entity.moves.length < MAX_MOVES) entity.moves.push({ at: at(), name, params: plain(params) })
    return
  }
  if (name === 'set_entity_data') {
    const entity = entityFor(String(params.runtime_entity_id), name)
    if (entity && entity.data.length < MAX_DATA) entity.data.push({ at: at(), params: plain(params) })
    return
  }
  if (name === 'remove_entity') {
    const id = byUnique.get(String(params.entity_id_self))
    if (id) report.entities[id].removedAt = at()
    return
  }
  if (name === 'set_entity_link') report.links.push({ at: at(), params: plain(params) })
}

function summarise () {
  for (const entity of Object.values(report.entities)) {
    const summary = report.summary[entity.type] ??= { entities: 0, removed: 0, moves: 0, motion: 0, data: 0, metadataKeys: [], rotation: {} }
    summary.entities++
    if (entity.removedAt !== null) summary.removed++
    summary.moves += entity.moves.length
    summary.motion += entity.motion
    summary.data += entity.data.length
    const keys = new Set(summary.metadataKeys)
    for (const item of [...(entity.add.metadata ?? []), ...entity.data.flatMap(entry => entry.params.metadata ?? [])]) keys.add(String(item.key))
    summary.metadataKeys = [...keys].sort()
    for (const [field, stats] of Object.entries(entity.rotation)) {
      const target = summary.rotation[field] ??= { min: stats.min, max: stats.max, count: 0 }
      target.min = Math.min(target.min, stats.min); target.max = Math.max(target.max, stats.max); target.count += stats.count
    }
  }
}

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
    // Recorded from the first packet on: entities near the spawn arrive before the bot counts as spawned.
    client.on('packet', packet => {
      const name = packet.data.name
      if (started === -1) return
      if (/entity|^add_player$|^move_player$/.test(name)) onPacket(name, packet.data.params)
    })
    return client
  })
  bot.start()
  bot.enqueue('connect')
  await until(() => bot.state.status === 'spawned' && bot.state.position, 30000, 'spawn')
  report.position = { ...bot.state.position }
  started = Date.now()
  console.log(`Recording entity packets for ${watchSeconds} s${wanted ? ' (only ' + wanted + ')' : ''}.`)
  await wait(watchSeconds * 1000)
  started = -1
  summarise()
  report.result = Object.keys(report.entities).length ? 'watched' : 'no-entities'
}

main().catch(error => { report.error = error.stack || error.message; console.error(report.error); process.exitCode = 1 }).finally(() => {
  bot?.stop()
  fs.mkdirSync('data', { recursive: true })
  fs.writeFileSync('data/entities-smoke-result.json', JSON.stringify(report, null, 2) + '\n')
  console.log('Report: data/entities-smoke-result.json, result ' + report.result + ', types ' + JSON.stringify(Object.fromEntries(Object.entries(report.summary).map(([type, s]) => [type, s.entities]))))
  setTimeout(() => process.exit(), 500).unref()
})
