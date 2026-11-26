// Active smoke mode: clicks a free bed in reach, then waits for another player and a server wake-up.
function assessSelfSleep (report) {
  return {
    sleepCycle: { result: report.bedAttempts > 0 && report.selfSleepingObserved && report.selfWaitObserved && report.selfSleepState === 'awake' ? 'passed' : 'not_completed' },
    partner: { result: report.scenario === 'solo' ? 'not_applicable' : report.selfPartnerObserved ? 'observed' : 'not_observed',
      range: report.scenario === 'solo' ? 'solo' : report.scenario === 'far' ? (report.targetTracked ? 'entity_tracked' : 'not_entity_tracked') : 'near' },
    nightSkip: {
      result: report.worldTimeJumpObserved ? 'time_jump_observed' : report.nightSkipAnnouncementObserved ? 'announced' : 'not_observed',
      announcement: report.nightSkipAnnouncementObserved ? 'observed' : 'not_observed',
      timeJump: report.worldTimeJumpObserved ? 'observed' : 'not_observed'
    }
  }
}

function createSelfSleeper (bot, client, report, finish, write = console.log, now = Date.now) {
  const { EMPTY_ITEM, playerContainer } = require('../dist/inventory.js')
  const Block = require('prismarine-block')('bedrock_' + bot.state.blockVersion)
  let stopped = false
  let busy = false
  let nextAttempt = 0
  let awakeAt = null
  let clicked = false
  let inventoryWindow = null
  let openingAt = null
  let closingAt = null
  const abort = new AbortController()
  report.selfSleepPhase = 'waiting_bed'
  report.bedAttempts = 0
  function log (phase, fields = {}) {
    const event = { at: new Date(now()).toISOString(), packet: 'self_sleep', phase, ...fields }
    report.events.push(event)
    write(JSON.stringify(event))
  }
  const send = (name, params) => client.queue(name, params)
  const opened = packet => {
    if (stopped || openingAt === null || !['inventory', -1].includes(packet.window_type)) return
    inventoryWindow = { window_id: packet.window_id, window_type: packet.window_type }
    openingAt = null
    nextAttempt = 0
    log('inventory_opened', inventoryWindow)
  }
  const closed = packet => {
    if (stopped || !inventoryWindow || packet.window_id !== inventoryWindow.window_id) return
    const expected = closingAt !== null
    inventoryWindow = null
    closingAt = null
    nextAttempt = 0
    log('inventory_closed', { expected })
    if (!expected) finish('failed', 'Server closed the inventory during the move')
  }
  client.on('container_open', opened)
  client.on('container_close', closed)
  async function step () {
    if (stopped || busy) return
    if (['dead', 'error', 'reconnecting'].includes(bot.state.status)) return finish('failed', 'Bot connection/death interrupted self-sleep test')
    if (bot.state.status !== 'spawned' || !bot.state.position) return
    if (![0, 'overworld'].includes(bot.state.dimension)) return finish('failed', 'Self-sleep test is restricted to the Overworld')
    if (openingAt !== null) {
      if (now() - openingAt >= 3000) finish('failed', 'Server did not open the inventory within 3 seconds')
      return
    }
    if (closingAt !== null) {
      if (now() - closingAt >= 3000) finish('failed', 'Server did not confirm inventory closing within 3 seconds')
      return
    }
    if (report.selfSleepState === 'sleeping') {
      if (!clicked) return finish('inconclusive', 'Bot was already sleeping before this test clicked a bed')
      if (report.selfSleepPhase !== 'waiting_player') {
        report.selfSleepPhase = 'waiting_player'
        report.selfWaitObserved = true
        log('waiting_player', { remainingPlayers: report.remainingPlayers?.count ?? null })
        write(report.scenario === 'solo'
          ? 'WAITING: Bot is sleeping. Solo test; waiting for server wake-up.'
          : `WAITING: Bot is sleeping. ${report.player} should now enter another bed.`)
      }
      return
    }
    if (report.selfSleepPhase === 'waiting_player' || awakeAt !== null || (clicked && report.selfSleepingObserved && report.selfSleepState === 'awake')) {
      if (report.selfSleepState !== 'awake') return
      if (awakeAt === null) {
        awakeAt = now()
        report.selfSleepPhase = 'awake'
        report.postWakeUntil = awakeAt + 10000
        report.postWakeCompleted = false
        log('awake')
      }
      // Time and wake packets can arrive in either order; allow both to settle.
      if (now() < report.postWakeUntil) return
      report.postWakeCompleted = true
      report.assessments = assessSelfSleep(report)
      const complete = report.assessments.sleepCycle.result === 'passed'
      return finish(complete ? 'observed' : 'inconclusive', complete
        ? 'Own sleep cycle passed; partner participation and night skip assessed separately'
        : 'Own sleep/wake metadata received, but the waiting phase was not observed')
    }
    if (report.selfSleepState === 'unknown' && report.selfSleepingObserved) return
    if (now() < nextAttempt || !bot.state.inventory.known) return
    nextAttempt = now() + 5000
    busy = true
    try {
      const p = { ...bot.state.position }
      const result = await bot.state.searchBlocks('bed', 100, p, abort.signal)
      if (stopped || report.selfSleepState === 'sleeping' || bot.state.status !== 'spawned') return
      if (![0, 'overworld'].includes(bot.state.dimension)) return finish('failed', 'Dimension changed during the bed search')
      const candidates = result.hits.map(hit => {
        const state = bot.state.stateAt(hit.x, hit.y, hit.z)
        const properties = state === null ? null : Block.fromStateId(state, 0).getProperties()
        return { x: hit.x, y: hit.y, z: hit.z, properties, distance: Math.hypot(hit.x + .5 - p.x, hit.y + .5 - p.y, hit.z + .5 - p.z) }
      }).filter(hit => hit.distance <= 4.5 && hit.properties?.head_piece_bit === 1 && hit.properties.occupied_bit === 0).sort((a, b) => a.distance - b.distance)
      report.bedCandidates = candidates
      if (!candidates.length) {
        log('waiting_bed', { coverageComplete: result.coverage.complete })
        return
      }
      const bed = candidates[0]
      const inventory = bot.state.inventory
      const slots = inventory.slotList()
      const slot = slots.slice(0, 9).findIndex(item => item === null)
      if (slot >= 0 && inventoryWindow) {
        closingAt = now()
        report.selfSleepPhase = 'closing_inventory'
        send('container_close', { ...inventoryWindow, server: false })
        return
      }
      if (slot < 0) {
        const to = slots.findIndex((item, index) => index >= 9 && item === null)
        if (to < 0) return finish('failed', 'Hotbar and main inventory are full; no free slot for an empty-hand bed click')
        if (!inventoryWindow) {
          report.selfSleepPhase = 'opening_inventory'
          openingAt = now()
          log('opening_inventory')
          send('interact', { action_id: 'open_inventory', target_entity_id: client.entityId, has_position: false })
          bot.navigator.lookAt(send, { x: bed.x + .5, y: bed.y + .5625, z: bed.z + .5 })
          return
        }
        const source = slots[0]
        report.selfSleepPhase = 'freeing_hotbar'
        log('freeing_hotbar', { from: 0, to, item: source.name, count: source.count })
        const pending = inventory.place(send, {
          name: source.name, count: source.count,
          from: { container: playerContainer(0), slot: 0, stackId: source.stackId },
          to: { container: playerContainer(to), slot: to, stackId: 0 }
        }, now())
        bot.navigator.lookAt(send, { x: bed.x + .5, y: bed.y + .5625, z: bed.z + .5 })
        const response = await pending
        if (stopped) return
        log('inventory_move_response', { status: response.status, from: 0, to })
        if ((response.status !== 'ok' && response.status !== 0) || inventory.slotList()[0] !== null) {
          return finish('failed', `Server did not confirm an empty hotbar slot after moving the stack (status ${response.status})`)
        }
        if (!inventoryWindow) return finish('failed', 'Inventory closed before the stack move was completed')
        log('hotbar_freed', { slot: 0, movedTo: to })
        report.selfSleepPhase = 'closing_inventory'
        closingAt = now()
        send('container_close', { ...inventoryWindow, server: false })
        // Recheck dimension, position and bed occupancy on the next step after the asynchronous move.
        return
      }
      const runtimeId = bot.state.runtimeIds.get(bot.state.stateAt(bed.x, bed.y, bed.z))
      if (runtimeId === undefined) return
      report.bed = bed
      report.bedAttempts++
      report.selfSleepPhase = 'trying_bed'
      log('click_bed', { bed, slot, attempt: report.bedAttempts })
      clicked = true
      send('mob_equipment', { runtime_entity_id: client.entityId, item: EMPTY_ITEM, slot, selected_slot: slot, window_id: 'inventory' })
      bot.navigator.clickBlock(send, bed, runtimeId, EMPTY_ITEM, { face: 1, clickPos: { x: .5, y: .5625, z: .5 }, hotbarSlot: slot })
      // The server processes a click only with a following input packet.
      bot.navigator.lookAt(send, { x: bed.x + .5, y: bed.y + .5625, z: bed.z + .5 })
    } catch (error) {
      if (!stopped && error.message !== 'World data is not ready') finish('failed', error.message)
    } finally { busy = false }
  }
  return { step, stop () {
    stopped = true
    abort.abort()
    client.removeListener('container_open', opened)
    client.removeListener('container_close', closed)
  } }
}

module.exports = { createSelfSleeper, assessSelfSleep }
