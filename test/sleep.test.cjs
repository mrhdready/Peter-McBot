const { test } = require('node:test')
const assert = require('node:assert/strict')
const { setImmediate: flush } = require('node:timers/promises')
const { AutoSleeper } = require('../dist/sleep.js')
const { WorldConditions } = require('../dist/world-conditions.js')
const { WorldState } = require('../dist/state.js')
const { SleepSettings } = require('../dist/sleep-settings.js')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function setup (t, onlyWithPlayers = false) {
  let now = 1000
  const state = new WorldState()
  state.status = 'spawned'; state.position = { x: .5, y: 65.62, z: .5 }; state.dimension = 'overworld'; state.inventory.known = true
  const registry = require('prismarine-registry')('bedrock_1.26.60')
  const Block = require('prismarine-block')(registry)
  const bed = registry.blocksByName.bed
  const id = Array.from({ length: bed.maxStateId - bed.minStateId + 1 }, (_, i) => bed.minStateId + i)
    .find(id => { const p = Block.fromStateId(id, 0).getProperties(); return p.head_piece_bit === 1 && p.occupied_bit === 0 })
  const point = { x: 1, y: 64, z: 0, distance: 2 }
  state.blockIds = () => ['minecraft:bed']
  state.searchBlocks = async () => ({ hits: [point] })
  state.stateIdAt = () => id; state.blockNameAt = () => 'minecraft:bed'; state.blockRuntimeIdAt = () => 777
  state.canSeeBlock = () => true
  const conditions = new WorldConditions()
  conditions.legacyTime(14000, now); conditions.selfSleeping = false
  const sent = []; const paused = []; const resumed = []
  const send = (name, params) => sent.push({ name, params })
  const navigator = { stop () {}, step () {}, start (target) { state.navigation.status = 'moving'; state.navigation.target = target },
    lookAt () {}, clickBlock (send, bed, runtime, held, options) { send('bed_click', { bed, runtime, held, options }) } }
  const host = { state, navigator, conditions, now: () => now, send, entityId: () => 1n, pause: () => paused.push(now), resume: discard => resumed.push(discard), busy: () => false }
  const sleep = new AutoSleeper(host)
  t.after(() => sleep.reset())
  sleep.configure({ enabled: true, onlyWithPlayers })
  return { sleep, state, conditions, sent, paused, resumed, host, point, advance (ms) { now += ms; sleep.step() } }
}

test('sleep pauses work, clicks a confirmed free bed and resumes only after server wake', async t => {
  const s = setup(t)
  s.sleep.step(); await flush(); s.sleep.step()
  assert.equal(s.paused.length, 1)
  assert.equal(s.sent.filter(p => p.name === 'bed_click').length, 1)
  s.conditions.selfSleeping = true; s.sleep.step()
  assert.equal(s.sleep.status().phase, 'sleeping')
  s.advance(10000)
  assert.equal(s.resumed.length, 0)
  s.conditions.metadata('1', '1', [{ key: 'player_flags', value: 0 }]); s.sleep.step()
  assert.deepEqual(s.resumed, [false])
  assert.equal(s.sleep.active, false)
})

test('only-with-players requires server evidence and remote messages cannot extend the 60-second approach', async t => {
  const s = setup(t, true)
  s.host.busy = () => true
  s.sleep.step()
  assert.equal(s.paused.length, 0)
  const notice = { type: 'translation', needs_translation: true, message: 'chat.type.sleeping', parameters: ['Player', '1'] }
  s.conditions.notice(notice, 'Bot', 1000); s.sleep.step()
  assert.equal(s.paused.length, 1)
  s.advance(59000)
  s.conditions.notice(notice, 'Bot', 60000)
  s.advance(1000)
  assert.equal(s.sleep.active, false)
  assert.deepEqual(s.resumed, [false])
})

test('no known usable bed resumes work and retries no sooner than 60 seconds', async t => {
  const s = setup(t)
  s.state.searchBlocks = async () => ({ hits: [] })
  s.sleep.step(); await flush()
  assert.equal(s.sleep.active, false)
  assert.match(s.sleep.status().message, /Kein freies/)
  s.advance(59999)
  assert.equal(s.paused.length, 1)
  s.advance(1); await flush()
  assert.equal(s.paused.length, 2)
})

test('stop wakes the bot, discards paused work and interlocks auto-sleep until manual work', async t => {
  const s = setup(t)
  s.sleep.step(); await flush(); s.sleep.step()
  s.conditions.selfSleeping = true; s.sleep.step()
  s.sleep.stop()
  assert.equal(s.sleep.status().blocked, true)
  assert.equal(s.sleep.status().phase, 'waking')
  assert.equal(s.sent.at(-1).params.action, 'stop_sleeping')
  const serializer = require('bedrock-protocol/src/transforms/serializer').createSerializer('1.26.60')
  assert.ok(serializer.createPacketBuffer(s.sent.at(-1)).length > 0)
  assert.equal(s.resumed.length, 0)
  s.conditions.metadata('1', '1', [{ key: 'player_flags', value: 0 }]); s.sleep.step()
  assert.deepEqual(s.resumed, [true])
  s.advance(60000); assert.equal(s.sleep.active, false)
  s.sleep.manualWork(); s.sleep.step(); await flush()
  assert.equal(s.paused.length, 2)
})

test('disabling sleep wakes before resuming and stale search completion cannot move or click', async t => {
  const s = setup(t)
  let complete
  s.state.searchBlocks = () => new Promise(resolve => { complete = resolve })
  s.sleep.step()
  s.sleep.configure({ enabled: false, onlyWithPlayers: false })
  complete({ hits: [s.point] }); await flush(); s.sleep.step()
  assert.equal(s.sent.length, 0)
  assert.deepEqual(s.resumed, [false])
  assert.equal(s.sleep.active, false)
})

test('disabling an already sleeping bot waits for a fresh server wake before resuming', async t => {
  const s = setup(t)
  s.sleep.step(); await flush(); s.sleep.step()
  s.conditions.metadata('1', '1', [{ key: 'player_flags', value: 2 }]); s.sleep.step()
  s.sleep.configure({ enabled: false, onlyWithPlayers: false })
  assert.equal(s.sleep.status().phase, 'waking')
  s.sleep.step(); assert.equal(s.resumed.length, 0)
  s.conditions.metadata('1', '1', [{ key: 'player_flags', value: 0 }]); s.sleep.step()
  assert.deepEqual(s.resumed, [false])
})

test('full hotbar waits for opening, refreshed stack IDs, move confirmation and closing before a bed click', async t => {
  const s = setup(t)
  s.state.inventory.setRegistry([{ name: 'minecraft:dirt', runtime_id: 3 }])
  const content = Array.from({ length: 36 }, (_, i) => i < 9 ? { network_id: 3, count: 2, has_stack_id: true, stack_id: i + 10 } : { network_id: 0 })
  s.state.inventory.setContent(content)
  s.sleep.step(); await flush(); s.sleep.step()
  assert.equal(s.sent.at(-1).name, 'interact')
  assert.equal(s.sent.some(p => p.name === 'item_stack_request'), false)
  s.sleep.opened({ window_id: 2, window_type: 'inventory' })
  content[0].stack_id = 200
  s.state.inventory.setContent(content)
  s.advance(100)
  const request = s.sent.find(p => p.name === 'item_stack_request').params.requests[0]
  assert.equal(request.actions[0].source.stack_id, 200)
  s.state.inventory.response([{ request_id: request.request_id, status: 'ok', containers: [
    { slot_type: { container_id: 'hotbar' }, slots: [{ slot: 0, count: 0 }] },
    { slot_type: { container_id: 'hotbar_and_inventory' }, slots: [{ slot: 9, count: 2, item_stack_id: 201 }] }
  ] }])
  await flush()
  assert.equal(s.sent.at(-1).name, 'container_close')
  s.sleep.step()
  assert.equal(s.sent.some(p => p.name === 'bed_click'), false)
  s.sleep.closed(2); s.sleep.step()
  assert.equal(s.sent.at(-1).name, 'bed_click')
  assert.equal(s.state.inventory.slotList()[9].name, 'minecraft:dirt')
})

test('cancelled inventory opening closes a late acknowledgement without moving items', async t => {
  const s = setup(t)
  s.state.inventory.setContent(Array.from({ length: 36 }, (_, i) => i < 9 ? { network_id: 3, count: 2, has_stack_id: true, stack_id: i + 10 } : { network_id: 0 }))
  s.sleep.step(); await flush(); s.sleep.step()
  assert.equal(s.sleep.status().phase, 'opening')
  s.sleep.stop()
  s.sleep.opened({ window_id: 2, window_type: 'inventory' })
  assert.equal(s.sent.at(-1).name, 'container_close')
  assert.equal(s.sent.some(p => p.name === 'item_stack_request'), false)
  assert.equal(s.sent.some(p => p.name === 'bed_click'), false)
})

test('bed selection excludes unknown, occupied, out-of-radius and other-dimension beds', async t => {
  const s = setup(t)
  s.point.distance = 33
  s.sleep.step(); await flush()
  assert.equal(s.sent.length, 0)
  assert.equal(s.sleep.active, false)
  s.state.dimension = 'nether'; s.advance(60000)
  assert.equal(s.paused.length, 1)
})

test('sleep settings default off, persist atomically, and reject incomplete or extra fields', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sleep-settings-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'sleep.json')
  const settings = new SleepSettings(file)
  assert.deepEqual(settings.value, { enabled: false, onlyWithPlayers: false })
  settings.update({ enabled: true, onlyWithPlayers: true })
  assert.deepEqual(new SleepSettings(file).value, settings.value)
  assert.throws(() => settings.update({ enabled: 'true', onlyWithPlayers: false }), /boolean/)
  assert.throws(() => settings.update({ enabled: false }), /boolean/)
  assert.throws(() => settings.update({ enabled: false, onlyWithPlayers: false, extra: true }), /boolean/)
  assert.deepEqual(new SleepSettings(file).value, { enabled: true, onlyWithPlayers: true })
})
