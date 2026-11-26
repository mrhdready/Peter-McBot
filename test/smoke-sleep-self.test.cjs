const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createSelfSleeper, assessSelfSleep } = require('../scripts/smoke-sleep-self.cjs')
const { WorldState } = require('../dist/state.js')
const { Navigator } = require('../dist/navigation.js')
const { observe } = require('../scripts/smoke-sleep.cjs')

function setup (t) {
  const registry = require('prismarine-registry')('bedrock_1.26.60')
  const state = new WorldState(4, '1.26.60')
  state.status = 'spawned'; state.dimension = 'overworld'; state.position = { x: .5, y: 65.62, z: .5 }
  state.inventory.known = true
  const Block = require('prismarine-block')(registry)
  const range = registry.blocksByName.bed
  const bed = Array.from({ length: range.maxStateId - range.minStateId + 1 }, (_, i) => range.minStateId + i)
    .find(id => { const p = Block.fromStateId(id, 0).getProperties(); return p.head_piece_bit === 1 && p.occupied_bit === 0 })
  state.stateAt = () => bed
  state.runtimeIds.set(bed, 777)
  state.searchBlocks = async () => ({ hits: [{ x: 1, y: 64, z: 0 }], coverage: { complete: true } })
  const sent = []
  const client = new EventEmitter()
  client.entityId = 9n
  client.queue = (name, params) => sent.push({ name, params })
  const bot = { state, navigator: new Navigator(state) }
  const report = { player: 'Sleeper', selfSleepState: 'awake', events: [] }
  const finished = []
  let time = 10000
  const runner = createSelfSleeper(bot, client, report, (...args) => finished.push(args), () => {}, () => time)
  t.after(() => runner.stop())
  return { bot, state, client, report, sent, runner, finished, advance (ms) { time += ms } }
}

test('self mode clicks a known free bed with an empty hand and flushes a stationary input packet', async t => {
  const s = setup(t)
  await s.runner.step()
  assert.deepEqual(s.sent.map(p => p.name), ['mob_equipment', 'inventory_transaction', 'player_auth_input'])
  const click = s.sent[1].params.transaction.transaction_data
  assert.deepEqual(click.block_position, { x: 1, y: 64, z: 0 })
  assert.equal(click.held_item.network_id, 0)
  assert.equal(click.block_runtime_id, 777)
  assert.deepEqual(s.sent[2].params.move_vector, { x: 0, z: 0 })
  const serializer = require('bedrock-protocol/src/transforms/serializer').createSerializer('1.26.60')
  for (const packet of s.sent) assert.ok(serializer.createPacketBuffer(packet).length > 0)
  await s.runner.step()
  assert.equal(s.report.bedAttempts, 1, 'No click spam between retries')
  s.advance(5000)
  await s.runner.step()
  assert.equal(s.report.bedAttempts, 2, 'Server remains authoritative about when sleep is permitted')
})

test('self mode waits in bed without further clicks and finishes after partner, time jump and wake', async t => {
  const s = setup(t)
  await s.runner.step()
  s.report.selfSleepState = 'sleeping'; s.report.selfSleepingObserved = true
  await s.runner.step()
  assert.equal(s.report.selfSleepPhase, 'waiting_player')
  s.advance(10000)
  await s.runner.step()
  assert.equal(s.sent.length, 3)
  assert.equal(s.finished.length, 0)
  s.report.selfPartnerObserved = true; s.report.worldTimeJumpObserved = true; s.report.selfSleepState = 'awake'
  await s.runner.step()
  s.advance(9999)
  await s.runner.step()
  assert.equal(s.finished.length, 0, 'Keep recording for the full ten seconds after wake')
  s.advance(1)
  await s.runner.step()
  assert.equal(s.finished[0][0], 'observed')
  assert.equal(s.report.postWakeCompleted, true)
  assert.deepEqual(s.report.assessments, {
    sleepCycle: { result: 'passed' }, partner: { result: 'observed', range: 'near' },
    nightSkip: { result: 'time_jump_observed', announcement: 'not_observed', timeJump: 'observed' }
  })
})

test('wake without observing the waiting phase stays incomplete and does not trigger another click', async t => {
  const s = setup(t)
  await s.runner.step()
  s.report.selfSleepingObserved = true; s.report.selfSleepState = 'awake'
  await s.runner.step()
  s.advance(10000)
  await s.runner.step()
  assert.equal(s.finished[0][0], 'inconclusive')
  assert.equal(s.sent.length, 3)
})

test('own sleep cycle passes independently of missing partner and time packets, including a tracked far target', async t => {
  const s = setup(t)
  s.report.scenario = 'far'; s.report.targetTracked = true
  await s.runner.step()
  s.report.selfSleepState = 'sleeping'; s.report.selfSleepingObserved = true
  await s.runner.step()
  s.report.selfSleepState = 'awake'
  await s.runner.step()
  s.advance(10000)
  await s.runner.step()
  assert.equal(s.finished[0][0], 'observed')
  assert.deepEqual(s.report.assessments, {
    sleepCycle: { result: 'passed' }, partner: { result: 'not_observed', range: 'entity_tracked' },
    nightSkip: { result: 'not_observed', announcement: 'not_observed', timeJump: 'not_observed' }
  })
  assert.equal(s.sent.length, 3)
})

test('partner and time evidence cannot manufacture a successful own sleep cycle', () => {
  const assessment = assessSelfSleep({ selfPartnerObserved: true, worldTimeJumpObserved: true })
  assert.equal(assessment.sleepCycle.result, 'not_completed')
  assert.equal(assessment.partner.result, 'observed')
  assert.equal(assessment.nightSkip.result, 'time_jump_observed')
})

test('solo sleep cycle passes with partner assessment not applicable and announcement separate from measured time', async t => {
  const s = setup(t)
  s.report.scenario = 'solo'; s.report.player = null
  await s.runner.step()
  s.report.selfSleepState = 'sleeping'; s.report.selfSleepingObserved = true
  await s.runner.step()
  s.report.nightSkipAnnouncementObserved = true
  s.report.selfSleepState = 'awake'
  await s.runner.step()
  s.advance(10000)
  await s.runner.step()
  assert.equal(s.finished[0][0], 'observed')
  assert.deepEqual(s.report.assessments, {
    sleepCycle: { result: 'passed' }, partner: { result: 'not_applicable', range: 'solo' },
    nightSkip: { result: 'announced', announcement: 'observed', timeJump: 'not_observed' }
  })
})

test('ten-second post-wake recording survives the original deadline and includes late server packets', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 10000 })
  const s = setup(t)
  s.runner.stop()
  s.client.close = () => s.client.emit('close')
  s.bot.stop = () => s.client.close()
  const result = { mode: 'self', scenario: 'near', selfName: 'Observer', player: 'Sleeper', events: [] }
  const pending = observe(s.client, result, 1, () => {}, s.bot)
  s.client.emit('start_game', { runtime_entity_id: 9n, player_position: s.state.position, dimension: 'overworld' })
  s.client.emit('spawn')
  const state = value => s.client.emit('set_entity_data', { runtime_entity_id: 9n, metadata: [{ key: 'player_flags', value }] })
  state(0)
  t.mock.timers.tick(250)
  await Promise.resolve()
  assert.equal(result.bedAttempts, 1)
  state(2)
  t.mock.timers.tick(250)
  assert.equal(result.selfWaitObserved, true)
  state(0)
  t.mock.timers.tick(250)
  assert.equal(result.postWakeUntil, 20750)
  t.mock.timers.tick(250)
  assert.equal(result.finishedAt, undefined, 'Original one-second deadline must allow the post-wake recording')
  t.mock.timers.tick(9749)
  s.client.emit('packet', { data: { name: 'late_server_packet' } })
  s.client.emit('text', { type: 'system', message: 'Late server update' })
  assert.equal(result.finishedAt, undefined)
  t.mock.timers.tick(1)
  await pending
  assert.equal(result.result, 'observed')
  assert.equal(result.postWakeCompleted, true)
  assert.equal(result.packetCounts.late_server_packet, 1)
  assert.equal(result.events.some(e => e.packet === 'server_message' && e.message === 'Late server update'), true)
  assert.equal(result.assessments.partner.result, 'not_observed')
  assert.equal(result.assessments.nightSkip.result, 'not_observed')
})

test('self mode never clicks a bed outside the Overworld or outside interaction reach', async t => {
  const s = setup(t)
  s.state.dimension = 'nether'
  await s.runner.step()
  assert.equal(s.finished[0][0], 'failed')
  assert.equal(s.sent.length, 0)
  s.state.dimension = 'overworld'
  s.state.searchBlocks = async () => ({ hits: [{ x: 20, y: 64, z: 0 }], coverage: { complete: true } })
  await s.runner.step()
  assert.equal(s.sent.length, 0)
})

test('self mode rejects occupied beds and aborts a pending search on shutdown', async t => {
  const s = setup(t)
  const registry = require('prismarine-registry')('bedrock_1.26.60')
  const Block = require('prismarine-block')(registry)
  const bed = registry.blocksByName.bed
  const occupied = Array.from({ length: bed.maxStateId - bed.minStateId + 1 }, (_, i) => bed.minStateId + i)
    .find(id => { const p = Block.fromStateId(id, 0).getProperties(); return p.head_piece_bit === 1 && p.occupied_bit === 1 })
  s.state.stateAt = () => occupied
  await s.runner.step()
  assert.equal(s.sent.length, 0)
  let done
  let signal
  s.state.searchBlocks = (name, limit, p, abort) => { signal = abort; return new Promise(resolve => { done = resolve }) }
  s.advance(5000)
  const pending = s.runner.step()
  s.runner.stop()
  assert.equal(signal.aborted, true)
  done({ hits: [], coverage: { complete: true } })
  await pending
  assert.equal(s.sent.length, 0)
})

function fillHotbar (s, full = false) {
  s.state.inventory.setRegistry([{ name: 'minecraft:dirt', runtime_id: 3 }])
  const slots = Array(36).fill(null)
  for (let i = 0; i < (full ? 36 : 9); i++) slots[i] = {
    network_id: 3, count: 12, has_stack_id: true, stack_id: 100 + i, metadata: 0,
    extra: { has_nbt: true, nbt: { type: 'compound', name: '', value: { custom: { type: 'string', value: 'keep me' } } }, can_place_on: [], can_destroy: [] }
  }
  s.state.inventory.setContent(slots)
  return slots
}

function confirmMove (s, status = 'ok') {
  const request = s.sent.find(packet => packet.name === 'item_stack_request').params.requests[0]
  s.state.inventory.response([{ request_id: request.request_id, status, containers: [
    { slot_type: { container_id: 'hotbar' }, slots: [{ slot: 0, count: 0, item_stack_id: 0 }] },
    { slot_type: { container_id: 'hotbar_and_inventory' }, slots: [{ slot: 9, count: 12, item_stack_id: 200 }] }
  ] }])
  return request
}

async function openInventory (s) {
  await s.runner.step()
  assert.equal(s.sent[0].name, 'interact')
  assert.equal(s.sent[0].params.action_id, 'open_inventory')
  assert.equal(s.sent.some(packet => packet.name === 'item_stack_request'), false)
  s.client.emit('container_open', { window_id: 'inventory', window_type: 'inventory' })
}

test('full hotbar moves a whole stack to main inventory and waits for confirmation before clicking', async t => {
  const s = setup(t)
  const before = fillHotbar(s)
  await openInventory(s)
  const pending = s.runner.step()
  await Promise.resolve()
  assert.deepEqual(s.sent.map(p => p.name), ['interact', 'player_auth_input', 'item_stack_request', 'player_auth_input'])
  assert.equal(s.state.inventory.slotList()[0].count, 12, 'No optimistic inventory changes')
  assert.equal(s.state.inventory.slotList()[9], null)
  const request = confirmMove(s)
  assert.equal(request.actions[0].count, 12)
  assert.equal(request.actions[0].source.slot, 0)
  assert.equal(request.actions[0].destination.slot, 9)
  await pending
  assert.equal(s.state.inventory.slotList()[0], null)
  assert.deepEqual(s.state.inventory.packetItem(9), { ...before[0], stack_id: 200 })
  assert.equal(s.sent.some(p => p.name === 'inventory_transaction'), false)
  await s.runner.step()
  assert.equal(s.sent.at(-1).name, 'container_close')
  assert.equal(s.sent.some(p => p.name === 'inventory_transaction'), false, 'Wait for close confirmation before using the bed')
  s.client.emit('container_close', { window_id: 'inventory' })
  await s.runner.step()
  assert.equal(s.sent.find(p => p.name === 'inventory_transaction').params.transaction.transaction_data.hotbar_slot, 0)
  assert.equal(s.report.bedAttempts, 1)
  assert.equal(s.finished.length, 0)
  const serializer = require('bedrock-protocol/src/transforms/serializer').createSerializer('1.26.60')
  for (const packet of s.sent) assert.ok(serializer.createPacketBuffer(packet).length > 0)
})

test('full inventory aborts without dropping, moving or using held items', async t => {
  const s = setup(t)
  fillHotbar(s, true)
  await s.runner.step()
  assert.equal(s.finished[0][0], 'failed')
  assert.match(s.finished[0][1], /main inventory are full/)
  assert.deepEqual(s.sent, [])
})

test('rejected inventory move leaves the stack intact and prevents a bed click', async t => {
  const s = setup(t)
  fillHotbar(s)
  await openInventory(s)
  const pending = s.runner.step()
  await Promise.resolve()
  confirmMove(s, 50)
  await pending
  assert.equal(s.finished[0][0], 'failed')
  assert.match(s.finished[0][1], /status 50/)
  assert.equal(s.report.events.find(e => e.phase === 'inventory_move_response').status, 50)
  assert.equal(s.state.inventory.slotList()[0].count, 12)
  assert.equal(s.state.inventory.slotList()[9], null)
  assert.equal(s.sent.some(p => p.name === 'inventory_transaction'), false)
})

test('inventory timeout or cancellation cannot cause a later bed click', async t => {
  const s = setup(t)
  fillHotbar(s)
  await openInventory(s)
  const pending = s.runner.step()
  await Promise.resolve()
  s.state.inventory.expire(13001)
  await pending
  assert.equal(s.finished[0][0], 'failed')
  assert.equal(s.sent.some(p => p.name === 'inventory_transaction'), false)

  const cancelled = setup(t)
  fillHotbar(cancelled)
  await openInventory(cancelled)
  const moving = cancelled.runner.step()
  await Promise.resolve()
  cancelled.runner.stop()
  confirmMove(cancelled)
  await moving
  assert.equal(cancelled.sent.some(p => p.name === 'inventory_transaction'), false)
  assert.equal(cancelled.finished.length, 0)
})

test('opening requires the own inventory window, times out and removes listeners on cancellation', async t => {
  const s = setup(t)
  fillHotbar(s)
  await s.runner.step()
  s.client.emit('container_open', { window_id: 5, window_type: 'container' })
  await s.runner.step()
  assert.equal(s.sent.some(packet => packet.name === 'item_stack_request'), false)
  s.advance(3000)
  await s.runner.step()
  assert.equal(s.finished[0][0], 'failed')
  assert.match(s.finished[0][1], /did not open/)
  s.runner.stop()
  assert.equal(s.client.listenerCount('container_open'), 0)
  assert.equal(s.client.listenerCount('container_close'), 0)
})

test('closing timeout prevents any bed click after a successful inventory move', async t => {
  const s = setup(t)
  fillHotbar(s)
  await openInventory(s)
  const pending = s.runner.step()
  await Promise.resolve()
  confirmMove(s)
  await pending
  s.advance(3000)
  await s.runner.step()
  assert.equal(s.finished[0][0], 'failed')
  assert.match(s.finished[0][1], /inventory closing/)
  assert.equal(s.sent.some(packet => packet.name === 'inventory_transaction'), false)
})
