const { test } = require('node:test')
const assert = require('node:assert/strict')
const { WorldConditions, sleepingFlag } = require('../dist/world-conditions.js')
const { estimateLight } = require('../dist/light.js')

test('Overworld clocks interpolate, pause and reset without using another dimension clock', () => {
  const world = new WorldConditions()
  world.clocks({ payload_type: 'sync_state', sync_states: [{ clock_id: 1n, time: 14000, paused: false }] }, 1000)
  assert.equal(world.time(1000), null)
  world.clocks({ payload_type: 'initialize_registry', clocks: [
    { id: 1n, name: 'minecraft:overworld', time: 6000, paused: false },
    { id: 2n, name: 'minecraft:the_end', time: 14000, paused: false }
  ] }, 1000)
  assert.equal(world.snapshot(1000).clock, '12:00')
  assert.equal(world.time(2000), 6020)
  world.clocks({ payload_type: 'sync_state', sync_states: [{ clock_id: 1n, time: 18000, paused: true }] }, 2000)
  assert.equal(world.snapshot(90000).clock, '00:00')
  world.legacyTime(0, 90000)
  assert.equal(world.time(90000), 18000)
  world.reset()
  assert.equal(world.time(90000), null)
  world.legacyTime(-6000, 0)
  assert.equal(world.snapshot(90000).clock, '12:00')
})

test('sleep metadata uses corrected bits, rejects conflicting evidence and preserves unrelated updates', () => {
  assert.equal(sleepingFlag([{ key: 'flags_extended', value: { _value: '35184405647872', sleeping: false, wants_to_wake: true } }]), true)
  assert.equal(sleepingFlag([{ key: 'player_flags', value: 0 }, { key: 'flags_extended', value: { _value: 4096n } }]), null)
  const world = new WorldConditions()
  world.player('2', 'Player', [{ key: 'player_flags', value: 2 }])
  world.metadata('2', '1', [{ key: 'health', value: 20 }])
  assert.equal(world.hasPartner(0), true)
  world.metadata('2', '1', [{ key: 'player_flags', value: 0 }])
  assert.equal(world.hasPartner(0), false)
  world.metadata('1', '1', [{ key: 'player_flags', value: 2 }])
  assert.equal(world.selfSleeping, true)
})

test('structured remote sleep notices expire and local waking overrides their lease', () => {
  const world = new WorldConditions()
  const notice = { type: 'translation', needs_translation: true, message: 'chat.type.sleeping', parameters: ['Player', '1'] }
  world.notice({ ...notice, type: 'chat' }, 'Bot', 0)
  assert.equal(world.hasPartner(0), false)
  world.notice(notice, 'Bot', 0)
  assert.equal(world.hasPartner(59999), true)
  assert.equal(world.hasPartner(60000), false)
  world.notice(notice, 'Bot', 60000)
  world.player('2', 'Player', [{ key: 'player_flags', value: 2 }])
  world.metadata('2', '1', [{ key: 'player_flags', value: 0 }])
  assert.equal(world.hasPartner(60000), false)
  world.notice({ ...notice, parameters: ['Bot', '1'] }, 'Bot', 60000)
  assert.equal(world.hasPartner(60000), false)
})

test('night and thunderstorm trigger sleep while ordinary rain does not', () => {
  const world = new WorldConditions()
  world.legacyTime(6000, 0)
  world.weather('start_rain')
  assert.equal(world.sleepAllowed(0), false)
  world.weather('start_thunder')
  assert.equal(world.sleepAllowed(0), true)
  world.weather('stop_thunder')
  world.legacyTime(14000, 0)
  assert.equal(world.sleepAllowed(0), true)
  world.legacyTime(0, 0)
  assert.equal(world.sleepAllowed(0), false)
})

test('estimated local light accounts for sources, opaque obstacles and missing blocks', () => {
  const air = { emission: 0, filter: 0 }
  const stone = { emission: 0, filter: 15 }
  const p = { x: 0, y: 1, z: 0 }
  assert.equal(estimateLight(p, 15, 0, 3, () => air), 15)
  assert.equal(estimateLight(p, 0, 0, 3, (x, y, z) => x === 2 && y === 1 && z === 0 ? { emission: 14, filter: 0 } : air), 12)
  assert.equal(estimateLight(p, 15, 0, 3, (x, y, z) => x === 0 && y === 1 && z === 0 ? air : stone), 0)
  assert.equal(estimateLight(p, 15, 0, 3, () => null), null)
  assert.equal(estimateLight(p, 0, 0, 3, (x, y, z) => x === 1 && y === 1 && z === 0 ? null : air), null)
  assert.equal(estimateLight(p, 0, 0, 3, (x, y, z) => x === 0 && y === 1 && z === 0 ? { emission: 15, filter: 0 } : null), 15)
})
