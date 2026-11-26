const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createRecorder, readOptions, observe } = require('../scripts/smoke-sleep.cjs')

const report = (scenario = 'near') => ({ scenario, player: 'Sleeper', targetTracked: false, targetSleepingObserved: false, levelEventsObserved: 0, events: [] })
const player = { username: 'Sleeper', runtime_id: 42n, position: { x: 1, y: 64, z: 2 }, metadata: [] }
const flags = sleeping => ({ runtime_entity_id: 42n, metadata: [{ key: 'flags_extended', type: 'long', value: { _value: sleeping ? 4096n : 0n, sleeping: false, wants_to_wake: sleeping } }], properties: { ints: [], floats: [] }, tick: 1n })

test('all add_player names reach console and report while target matching remains exact', () => {
  const result = report()
  const lines = []
  const record = createRecorder(result, line => lines.push(JSON.parse(line)))
  const names = ['Other', 'sleeper', 'Sleeper ', 'Sleeper']
  names.forEach((username, index) => {
    record('add_player', { ...player, username, runtime_id: BigInt(index + 1), metadata: flags(true).metadata })
    assert.equal(result.targetTracked, username === 'Sleeper')
    assert.equal(result.targetSleepingObserved, username === 'Sleeper')
  })
  const entries = result.events.filter(event => event.packet === 'add_player' && event.position)
  assert.deepEqual(entries.map(event => event.player), names)
  assert.deepEqual(entries.map(event => event.runtimeId), ['1', '2', '3', '4'])
  assert.ok(entries.every(event => event.position === player.position))
  assert.deepEqual(lines.filter(event => event.position), entries)
})

test('sleep recorder reads actual decoded protocol flags and records enter/leave without duplicate updates', () => {
  const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer')
  const serializer = createSerializer('1.26.60')
  const parser = createDeserializer('1.26.60')
  const result = report()
  const record = createRecorder(result, () => {})
  record('add_player', player)
  for (const sleeping of [false, true, true, false]) {
    const decoded = parser.parsePacketBuffer(serializer.createPacketBuffer({ name: 'set_entity_data', params: flags(sleeping) })).data
    assert.equal(decoded.params.metadata[0].value.sleeping, false, 'Installed schema mislabels the actual sleep bit')
    assert.equal(decoded.params.metadata[0].value.wants_to_wake, sleeping)
    record(decoded.name, decoded.params)
  }
  assert.equal(result.targetSleepingObserved, true)
  assert.deepEqual(result.events.filter(e => e.packet === 'sleep_state').map(e => e.sleeping), [false, true, false])
  assert.deepEqual(result.sleepTransitions, { entered: 1, left: 1 })
  assert.equal(result.events[1].runtimeId, '42')
  assert.ok(result.events.every(e => !Number.isNaN(Date.parse(e.at))))
})

test('sleep detection replays the captured live sequence despite incorrect named flags', () => {
  const fixture = require('./fixtures/bedrock-sleep-metadata.json')
  const result = report()
  const record = createRecorder(result, () => {})
  for (const frame of fixture.frames) {
    record(frame.packet, frame.packet === 'add_player'
      ? { ...player, metadata: frame.metadata }
      : { runtime_entity_id: 42n, metadata: frame.metadata, tick: frame.tick })
  }
  assert.equal(result.targetSleepingObserved, true)
  assert.equal(result.targetSleepState, 'awake')
  assert.deepEqual(result.sleepTransitions, { entered: 3, left: 4 })
  assert.deepEqual(result.events.filter(e => e.packet === 'sleep_state').map(e => e.transition), [
    'initial', 'left_bed', 'entered_bed', 'left_bed', 'entered_bed', 'left_bed', 'entered_bed', 'left_bed'
  ])
  assert.equal(result.events.find(e => e.packet === 'sleep_state').evidence.wantsToWake, false)
})

test('player sleep bit works independently while body size, wake request and mislabelled flags cannot confirm sleep', () => {
  const result = report()
  const record = createRecorder(result, () => {})
  record('add_player', player)
  record('set_entity_data', { runtime_entity_id: 42n, metadata: [
    { key: 'boundingbox_width', value: .2 }, { key: 'boundingbox_height', value: .2 },
    { key: 'flags_extended', value: { _value: '10240', sleeping: true, wants_to_wake: false } }
  ] })
  assert.equal(result.targetSleepingObserved, false, 'Bits 11 (shield damage) and 13 (wake request) are not bit 12 (sleep)')
  for (const value of [4, 6, 6, 4]) record('set_entity_data', { runtime_entity_id: 42n, metadata: [{ key: 'player_flags', value }] })
  assert.equal(result.targetSleepingObserved, true)
  assert.equal(result.targetSleepState, 'awake')
  assert.deepEqual(result.sleepTransitions, { entered: 1, left: 1 })
})

test('conflicting flags remain diagnostic and do not confirm target sleep', () => {
  const result = report()
  const record = createRecorder(result, () => {})
  record('add_player', player)
  record('set_entity_data', { ...flags(true), metadata: [...flags(true).metadata, { key: 'player_flags', value: 0 }] })
  assert.equal(result.targetSleepingObserved, false)
  assert.equal(result.targetSleepState, 'unknown')
  assert.equal(result.events.at(-1).packet, 'sleep_conflict')
})

test('full target metadata preserves initial values, repeated packets and all enter/leave changes', () => {
  const result = report()
  const lines = []
  const record = createRecorder(result, line => lines.push(JSON.parse(line)))
  const initial = [{ key: 'flags', type: 'long', value: { resting: false, sneaking: false } }]
  record('add_player', { ...player, metadata: initial })
  const changes = [
    { key: 'flags', type: 'long', value: { resting: true, sneaking: false } },
    { key: 'unknown_future_field', type: 'long', value: 9007199254740993n },
    { key: 'player_bed_position', type: 'vec3i', value: { x: -107, y: 64, z: -184 } }
  ]
  for (const tick of [100n, 101n]) record('set_entity_data', { runtime_entity_id: 42n, metadata: changes, tick })
  record('set_entity_data', { runtime_entity_id: 42n, metadata: initial, tick: 102n })
  record('set_entity_data', { runtime_entity_id: 999n, metadata: changes, tick: 103n })
  const packets = result.events.filter(event => event.metadata)
  assert.equal(packets.length, 4)
  assert.deepEqual(packets[0].metadata, initial)
  assert.deepEqual(packets[1].metadata, [changes[0], { ...changes[1], value: '9007199254740993' }, changes[2]])
  assert.deepEqual(packets[2].metadata, packets[1].metadata)
  assert.deepEqual(packets[3].metadata, initial)
  assert.deepEqual(packets.slice(1).map(event => event.tick), ['100', '101', '102'])
  assert.deepEqual(lines.filter(event => event.metadata), packets)
  assert.equal(result.targetSleepingObserved, false)
  assert.doesNotThrow(() => JSON.stringify(result))
})

test('bed coordinates, actions, unknown entities and other players do not confirm target sleep', () => {
  const result = report()
  const record = createRecorder(result, () => {})
  record('set_entity_data', flags(true))
  record('add_player', { ...player, username: 'Other' })
  record('set_entity_data', flags(true))
  record('add_player', player)
  record('set_entity_data', { runtime_entity_id: 42n, metadata: [{ key: 'player_bed_position', value: { x: 0, y: 64, z: 0 } }] })
  record('player_action', { runtime_entity_id: 42n, action: 'start_sleeping' })
  assert.equal(result.targetSleepingObserved, false)
  assert.equal(result.levelEventsObserved, 0)
  assert.equal(result.events.filter(e => 'sleeping' in e).length, 0)
})

test('sleep level events retain raw server data without interpreting it as a sleeper count', () => {
  const result = report('far')
  const record = createRecorder(result, () => {})
  record('level_event', { event: 'sound_click', data: 1 })
  for (const event of ['players_sleeping', 'sleeping_players', 9800, 9801]) record('level_event', { event, data: -7 })
  assert.equal(result.levelEventsObserved, 4)
  assert.equal(result.targetSleepingObserved, false)
  assert.deepEqual(result.events.map(e => e.data), [-7, -7, -7, -7])
})

test('metadata after entity removal cannot confirm a stale target identity', () => {
  const result = report()
  const record = createRecorder(result, () => {})
  record('add_player', { ...player, unique_id: 100n })
  record('remove_entity', { entity_id_self: 100n })
  record('set_entity_data', flags(true))
  assert.equal(result.targetSleepingObserved, false)
  assert.equal(result.events.at(-1).packet, 'remove_entity')
})

function client (t) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const instance = new EventEmitter()
  instance.entityId = 9n
  instance.sent = []
  instance.queue = (name, params) => instance.sent.push({ name, params })
  instance.close = () => { instance.closed = true; instance.emit('close') }
  return instance
}

test('observation has a bounded spawn timeout and closes the client', async t => {
  const instance = client(t)
  const pending = observe(instance, report(), 10, () => {})
  t.mock.timers.tick(30000)
  assert.equal((await pending).result, 'failed')
  assert.equal(instance.closed, true)
  assert.deepEqual(instance.sent, [])
})

test('observation reports no signal rather than passing on bed coordinates alone', async t => {
  const instance = client(t)
  const pending = observe(instance, report(), 10, () => {})
  instance.emit('spawn')
  instance.emit('add_player', player)
  instance.emit('set_entity_data', { runtime_entity_id: 42n, metadata: [{ key: 'bed_enter_position', value: { x: 1, y: 64, z: 2 } }] })
  t.mock.timers.tick(10000)
  assert.equal((await pending).result, 'no_signal')
  assert.deepEqual(instance.sent, [])
})

test('far observation requires the target to remain outside entity tracking', async t => {
  const instance = client(t)
  const pending = observe(instance, report('far'), 10, () => {})
  instance.emit('spawn')
  instance.emit('add_player', player)
  instance.emit('set_entity_data', flags(true))
  t.mock.timers.tick(10000)
  assert.equal((await pending).result, 'inconclusive')
})

test('far observation reports level-event evidence without sending gameplay actions', async t => {
  const instance = client(t)
  const pending = observe(instance, report('far'), 10, () => {})
  instance.emit('spawn')
  instance.emit('level_event', { event: 'players_sleeping', data: 1 })
  t.mock.timers.tick(10000)
  assert.equal((await pending).result, 'observed')
  assert.deepEqual(instance.sent, [])
})

test('waiting-for-players notices do not prevent sleep detection or imply a night skip', async t => {
  const instance = client(t)
  const result = report()
  const pending = observe(instance, result, 10, () => {})
  instance.emit('spawn')
  instance.emit('add_player', player)
  instance.emit('set_entity_data', flags(false))
  instance.emit('set_entity_data', flags(true))
  instance.emit('text', { type: 'translation', message: 'multiplayerSleep.playersSleeping', parameters: ['1', '2'], needs_translation: true })
  instance.emit('set_title', { type: 'action_bar_message', text: 'Alle Spieler müssen schlafen, um die Nacht zu überspringen.' })
  assert.equal(result.targetSleepState, 'sleeping')
  instance.emit('set_entity_data', flags(false))
  t.mock.timers.tick(10000)
  assert.equal((await pending).result, 'observed')
  assert.equal(result.targetSleepState, 'awake')
  assert.deepEqual(result.sleepTransitions, { entered: 1, left: 1 })
  assert.equal(result.sleepNoticesObserved, 2)
  assert.deepEqual(instance.sent, [])
})

test('server notices alone cannot confirm target sleep and ordinary chat is excluded', async t => {
  const instance = client(t)
  const result = report('far')
  const pending = observe(instance, result, 10, () => {})
  instance.emit('spawn')
  instance.emit('text', { type: 'chat', source_name: 'Other', message: 'sleep' })
  instance.emit('text', { type: 'whisper', source_name: 'Other', message: 'sleep' })
  instance.emit('text', { type: 'system', message: 'Alle Spieler müssen schlafen.' })
  t.mock.timers.tick(10000)
  assert.equal((await pending).result, 'no_signal')
  assert.equal(result.targetSleepingObserved, false)
  assert.equal(result.sleepNoticesObserved, 1)
  assert.deepEqual(result.events.map(e => e.packet), ['server_message', 'sleep_notice'])
})

test('server diagnostics capture non-sleep text, titles and all self-mode level events without recording chat', () => {
  const result = { ...report(), mode: 'self' }
  const record = createRecorder(result, () => {})
  record('text', { type: 'translation', needs_translation: true, message: 'multiplayer.playersSkippingNight', parameters: [] })
  record('text', { type: 'system', message: 'Ein neuer Morgen beginnt.' })
  record('set_title', { type: 'action_bar_message', text: 'Neuer Morgen' })
  record('text', { type: 'chat', source_name: 'Other', message: 'Hello' })
  record('text', { type: 'whisper', source_name: 'Other', message: 'Private' })
  record('level_event', { event: 'sound_click', data: 5, position: { x: 1, y: 64, z: 2 } })
  assert.equal(result.events.filter(e => e.packet === 'server_message').length, 3)
  assert.equal(result.events.filter(e => e.packet === 'level_event').length, 1)
  assert.equal(result.events.some(e => e.message === 'Private' || e.message === 'Hello'), false)
  assert.equal(result.levelEventsObserved, 0)
  assert.equal(result.worldTimeJumpObserved, undefined, 'A message about skipping night is not a world-time measurement')
})

test('packet names are counted from the raw stream once without retaining payloads', async t => {
  const instance = client(t)
  const result = report()
  const pending = observe(instance, result, 1, () => {})
  instance.emit('packet', { data: { name: 'text', params: { message: 'Private', source_name: 'Other' } } })
  instance.emit('text', { type: 'chat', message: 'Private', source_name: 'Other' })
  instance.emit('packet', { data: { name: 'set_time', params: { time: 100 } } })
  instance.emit('packet', { data: { name: 'set_time', params: { time: 200 } } })
  instance.emit('packet', { data: { name: 'unwatched_packet', params: { secret: 'not retained' } } })
  instance.emit('spawn')
  t.mock.timers.tick(1000)
  await pending
  assert.deepEqual({ ...result.packetCounts }, { text: 1, set_time: 2, unwatched_packet: 1 })
  assert.equal(result.events.length, 0)
  assert.equal(instance.listenerCount('packet'), 0)
})

test('structured server sleeping notices decode ADDITIONAL players as timestamped snapshots', () => {
  const result = report()
  const record = createRecorder(result, () => {})
  const notice = count => ({ type: 'translation', needs_translation: true, message: 'chat.type.sleeping', parameters: ['Sleeper', count] })
  record('text', notice('1'))
  assert.equal(result.remainingPlayers.count, 1)
  assert.equal(result.remainingPlayers.sleeper, 'Sleeper')
  record('text', notice('0'))
  assert.equal(result.remainingPlayers.count, 0)
  for (const count of ['-1', '1.5', '9007199254740993', '']) record('text', notice(count))
  record('text', { ...notice('3'), needs_translation: false })
  record('text', { ...notice('3'), type: 'chat' })
  assert.equal(result.remainingPlayers.count, 0, 'Malformed or authored notices cannot change the known snapshot')
  assert.equal(result.targetSleepingObserved, false, 'A count notice does not prove the current target state')
  assert.deepEqual(result.events.filter(e => e.packet === 'remaining_players').map(e => e.count), [1, 0])
})

test('self and target metadata stay separate while a time jump provides independent evidence', () => {
  const result = { ...report(), mode: 'self', selfName: 'Observer' }
  const record = createRecorder(result, () => {})
  record('start_game', { runtime_entity_id: 9n, player_position: { x: 0, y: 65.62, z: 0 }, dimension: 'overworld' })
  record('set_time', { time: 14000 })
  record('set_entity_data', { ...flags(false), runtime_entity_id: 9n })
  record('set_entity_data', { ...flags(true), runtime_entity_id: 9n })
  assert.equal(result.selfSleepState, 'sleeping')
  assert.equal(result.selfSleepingObserved, true)
  assert.equal(result.targetSleepingObserved, false)
  record('text', { type: 'translation', needs_translation: true, message: 'chat.type.sleeping', parameters: ['Sleeper', '0'] })
  assert.equal(result.selfPartnerObserved, true)
  record('set_time', { time: 14020 })
  assert.equal(result.worldTimeJumpObserved, undefined)
  record('set_time', { time: 24000 })
  record('set_entity_data', { ...flags(false), runtime_entity_id: 9n })
  assert.equal(result.selfSleepState, 'awake')
  assert.equal(result.worldTimeJumpObserved, true)
  assert.deepEqual(result.selfSleepTransitions, { entered: 1, left: 1 })
})

test('sync_world_clocks records wire-decoded registry and state packets and measures only the named Overworld clock', () => {
  const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer')
  const serializer = createSerializer('1.26.60')
  const parser = createDeserializer('1.26.60')
  const result = { ...report(), mode: 'self' }
  const record = createRecorder(result, () => {})
  const id = 9007199254740993n
  const receive = params => {
    const decoded = parser.parsePacketBuffer(serializer.createPacketBuffer({ name: 'sync_world_clocks', params })).data
    record(decoded.name, decoded.params)
  }
  receive({ payload_type: 'initialize_registry', clocks: [
    { id, name: 'minecraft:overworld', time: 14000, paused: false, time_markers: [] },
    { id: 2n, name: 'minecraft:the_end', time: 14000, paused: false, time_markers: [] }
  ] })
  result.selfSleepingObserved = true
  receive({ payload_type: 'sync_state', sync_states: [{ clock_id: 2n, time: 24000, paused: false }] })
  assert.equal(result.worldTimeJumpObserved, undefined)
  receive({ payload_type: 'sync_state', sync_states: [{ clock_id: id, time: 14020, paused: false }] })
  assert.equal(result.worldTimeJumpObserved, undefined)
  receive({ payload_type: 'sync_state', sync_states: [{ clock_id: id, time: 24000, paused: false }] })
  assert.equal(result.worldTimeJumpObserved, true)
  const jump = result.events.find(e => e.packet === 'world_time_jump')
  assert.equal(jump.source, 'sync_world_clocks')
  assert.equal(jump.clockId, '9007199254740993')
  assert.equal(jump.clockName, 'minecraft:overworld')
  assert.equal(jump.advance, 9980)
  assert.deepEqual(result.worldClocks[String(id)], { name: 'minecraft:overworld', time: 24000, paused: false })
  assert.equal(result.events.filter(e => e.packet === 'sync_world_clocks').length, 4)
  assert.doesNotThrow(() => JSON.stringify(result))
})

test('unknown clocks, pause toggles and registry resets do not create a false time jump', () => {
  const result = report()
  const record = createRecorder(result, () => {})
  result.selfSleepingObserved = true
  const state = (time, paused = false) => record('sync_world_clocks', { payload_type: 'sync_state', sync_states: [{ clock_id: 7n, time, paused }] })
  state(14000)
  state(24000)
  assert.equal(result.worldClocks['7'].name, null)
  assert.equal(result.worldTimeJumpObserved, undefined)
  const registry = time => record('sync_world_clocks', { payload_type: 'initialize_registry', clocks: [{ id: 7n, name: 'minecraft:overworld', time, paused: false, time_markers: [] }] })
  registry(14000)
  state(14000, true)
  state(14000, false)
  registry(24000)
  state(24020)
  assert.equal(result.worldTimeJumpObserved, undefined)
  record('sync_world_clocks', { payload_type: 'add_time_marker', add_clock_id: 7n, add_time_markers: [] })
  assert.equal(result.events.at(-1).payload_type, 'add_time_marker')
})

test('server announcement is distinct from time measurement, partner evidence and ordinary chat', () => {
  const result = { ...report(), mode: 'self' }
  const record = createRecorder(result, () => {})
  const message = 'multiplayer.playersSkippingNight'
  record('text', { type: 'chat', source_name: 'Other', message, needs_translation: true })
  record('text', { type: 'raw', message, needs_translation: false })
  assert.equal(result.nightSkipAnnouncementObserved, undefined)
  record('text', { type: 'translation', message, needs_translation: true, parameters: [] })
  assert.equal(result.nightSkipAnnouncementObserved, true)
  assert.equal(result.worldTimeJumpObserved, undefined)
  assert.equal(result.selfPartnerObserved, undefined)
  assert.equal(result.selfSleepingObserved, false)
  assert.equal(result.events.filter(e => e.packet === 'night_skip_announcement').length, 1)
})

test('only the initial respawn handshake is acknowledged; death aborts the observation', async t => {
  const instance = client(t)
  const pending = observe(instance, report(), 10, () => {})
  const position = { x: 0, y: 64, z: 0 }
  instance.emit('respawn', { state: 1, position })
  instance.emit('spawn')
  instance.emit('respawn', { state: 1, position })
  assert.equal((await pending).result, 'failed')
  assert.deepEqual(instance.sent, [{ name: 'respawn', params: { position, state: 2, runtime_entity_id: 9n } }])
})

test('sleep smoke validates duration, scenario and target before connecting', () => {
  const env = { BEDROCK_HOST: 'localhost', BOT_NAME: 'Observer', OBSERVE_PLAYER: 'Sleeper', SMOKE_SLEEP_SCENARIO: 'near' }
  assert.equal(readOptions(env).seconds, 180)
  assert.throws(() => readOptions({ ...env, SMOKE_SECONDS: '0' }), /SMOKE_SECONDS/)
  assert.throws(() => readOptions({ ...env, SMOKE_SLEEP_SCENARIO: 'unknown' }), /SMOKE_SLEEP_SCENARIO/)
  assert.throws(() => readOptions({ ...env, OBSERVE_PLAYER: 'Observer' }), /OBSERVE_PLAYER/)
  assert.equal(readOptions({ ...env, SMOKE_SLEEP_MODE: 'self' }).seconds, 1500)
  assert.throws(() => readOptions({ ...env, SMOKE_SLEEP_MODE: 'invalid' }), /SMOKE_SLEEP_MODE/)
  const solo = readOptions({ BEDROCK_HOST: 'localhost', SMOKE_SLEEP_MODE: 'self', SMOKE_SLEEP_SCENARIO: 'solo' })
  assert.equal(solo.player, null)
  assert.equal(solo.scenario, 'solo')
  assert.equal(readOptions({ ...env, SMOKE_SLEEP_MODE: 'self', SMOKE_SLEEP_SCENARIO: 'solo' }).player, null, 'Solo ignores a target left in the environment')
  assert.throws(() => readOptions({ ...env, SMOKE_SLEEP_SCENARIO: 'solo' }), /SMOKE_SLEEP_SCENARIO/)
})
