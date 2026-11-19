// A short-lived login probe: never moves, chats, changes blocks or respawns.
const { createClient } = require('bedrock-protocol')
const host = process.env.BEDROCK_HOST
if (!host) throw new Error('Set BEDROCK_HOST before probing a server')
let client
async function main () {
const transport = process.env.BEDROCK_TRANSPORT || 'nethernet'
client = createClient({
  host,
  port: Number(process.env.BEDROCK_PORT || 19132),
  username: process.env.BOT_NAME || 'MCBotProbe',
  version: process.env.BEDROCK_VERSION || '1.26.60',
  transport,
  offline: true,
  skinData: { SelfSignedId: require('bedrock-protocol/src/datatypes/util').uuidFrom(process.env.BOT_NAME || 'MCBotProbe') },
  raknetBackend: 'jsp-raknet',
  nethernet: transport === 'nethernet' ? { signalling: 'http', webrtcBackend: 'werift', serverKeyPath: process.env.PROBE_SERVER_KEY_PATH || './data/server-key.sha256', iceHost: process.env.BEDROCK_ICE_HOST || undefined } : undefined,
  pingTimeout: 5000,
  connectTimeout: 5000,
  conLog: console.log
})
client.viewDistance = 4
let spawned = false
let chunks = 0
const packets = {}
client.on('packet', packet => {
  const name = packet.data.name
  packets[name] = (packets[name] || 0) + 1
})
let requested = false
let captured = false
let hashed = false
let origin
const holdSeconds = Number(process.env.PROBE_SECONDS || 10)
if (!Number.isInteger(holdSeconds) || holdSeconds < 1 || holdSeconds > 7200) throw new Error('PROBE_SECONDS must be 1..7200')
const deadline = setTimeout(() => finish(1, 'Spawn deadline exceeded (30 s)'), 30000)
let hold
let finishing = false
function finish (code, message) {
  if (finishing) return
  finishing = true
  clearTimeout(deadline)
  clearTimeout(hold)
  console.log(JSON.stringify({ spawned, chunks, message, packets }))
  client.close()
  // Transport libraries may retain sockets after close; the bounded probe must exit.
  setTimeout(() => process.exit(code), 1000)
}
client.on('start_game', p => {
  hashed = p.block_network_ids_are_hashes
  origin = { x: Math.floor(p.player_position.x / 16), y: 0, z: Math.floor(p.player_position.z / 16) }
  console.log('start_game', JSON.stringify({ position: p.player_position, worldSpawn: p.spawn_position, dimension: p.dimension, hashed }))
})
let observedId
client.on('add_player', p => {
  if (p.username === process.env.OBSERVE_PLAYER) {
    observedId = String(p.runtime_id)
    console.log('observed_player', JSON.stringify({ username: p.username, runtimeId: observedId, position: p.position }))
  }
})
client.on('move_player', p => {
  if (observedId && String(p.runtime_id) === observedId) console.log('observed_position', JSON.stringify(p.position))
})
client.on('move_entity_delta', p => {
  if (observedId && String(p.runtime_entity_id) === observedId) console.log('observed_delta', JSON.stringify(p, (_, v) => typeof v === 'bigint' ? String(v) : v))
})
client.on('spawn', () => {
  spawned = true
  clearTimeout(deadline)
  hold = setTimeout(() => finish(0, `Spawn observed; held ${holdSeconds} s`), holdSeconds * 1000)
})
client.on('move_player', p => { if (String(p.runtime_id) === String(client.entityId)) console.log('confirmed_position', JSON.stringify(p.position)) })
let initialSpawnPending = true
client.on('respawn', p => {
  console.log('respawn_state', JSON.stringify(p, (_, value) => typeof value === 'bigint' ? String(value) : value))
  if (initialSpawnPending && p.state === 1) {
    initialSpawnPending = false
    client.queue('respawn', { position: p.position, state: 2, runtime_entity_id: client.entityId })
  }
})
client.on('move_entity_delta', p => { if (String(p.runtime_entity_id) === String(client.entityId)) console.log('own_delta', JSON.stringify(p, (_, value) => typeof value === 'bigint' ? String(value) : value)) })
client.on('correct_player_move_prediction', p => console.log('movement_correction', JSON.stringify(p, (_, value) => typeof value === 'bigint' ? String(value) : value)))
let lastPublisher
client.on('network_chunk_publisher_update', p => {
  const value = JSON.stringify(p.coordinates)
  if (value !== lastPublisher) console.log('chunk_publisher', value)
  lastPublisher = value
})
let lastPosition
client.on('server_post_move', p => {
  const value = JSON.stringify(p.position)
  if (value !== lastPosition) console.log('server_position', value)
  lastPosition = value
})
client.on('level_chunk', p => {
  chunks++
  if (process.env.CAPTURE_CHUNKS === '1' && !requested && origin && p.x === origin.x && p.z === origin.z) {
    requested = true
    console.log('chunk_layout', JSON.stringify({ x: p.x, z: p.z, subchunks: p.sub_chunk_count, cache: p.cache_enabled, bytes: p.payload.length }))
    client.queue('subchunk_request', { dimension: p.dimension, origin, requests: Array.from({ length: 8 }, (_, y) => ({ x: 0, y, z: 0 })) })
  }
})
client.on('subchunk', p => {
  console.log('subchunk_results', JSON.stringify(p.entries.map(e => ({ y: p.origin.y + e.dy, result: e.result, bytes: e.payload?.length }))))
  if (process.env.CAPTURE_CHUNKS !== '1' || captured) return
  const entry = p.entries.find(e => e.result === 'success' && e.payload?.length > 10)
  if (!entry) return
  captured = true
  const fs = require('node:fs')
  fs.mkdirSync('test/fixtures', { recursive: true })
  fs.writeFileSync('test/fixtures/bedrock-1.26.65-subchunk.json', JSON.stringify({
    serverVersion: '1.26.65', protocol: 2225, dataVersion: '1.26.60', hashed,
    y: p.origin.y + entry.dy, cacheEnabled: p.cache_enabled, payload: entry.payload.toString('base64')
  }, null, 2) + '\n')
  console.log('saved_subchunk_fixture')
})
client.on('kick', p => finish(1, `Kick: ${JSON.stringify(p)}`))
client.on('error', e => finish(1, e.stack || e.message))
client.on('close', () => finish(1, 'Closed before successful probe'))
}
main().catch(error => {
  console.error(error.stack || error.message)
  client?.close()
  setTimeout(() => process.exit(1), 1000)
})
