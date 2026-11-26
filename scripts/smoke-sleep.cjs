// Explicit live observation: passive by default; SMOKE_SLEEP_MODE=self also clicks a nearby bed.
const fs = require('node:fs')

const json = value => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? String(item) : item)

function createRecorder (report, write = console.log) {
  const players = new Map()
  const uniqueIds = new Map()
  const previous = new Map()
  const sleepStates = new Map()
  report.targetSleepState = 'unknown'
  report.sleepTransitions = { entered: 0, left: 0 }
  report.sleepNoticesObserved = 0
  report.selfSleepState = 'unknown'
  report.selfSleepingObserved = false
  report.selfSleepTransitions = { entered: 0, left: 0 }
  const clockNames = new Map()
  const lastTimes = new Map()
  report.worldClocks = Object.create(null)
  function record (packet, fields) {
    const event = { at: new Date().toISOString(), packet, ...fields }
    report.events.push(event)
    write(json(event))
  }
  function sampleTime (key, time, paused, source, clockId, clockName) {
    if (!Number.isInteger(time)) return
    const at = Date.now()
    const previous = lastTimes.get(key)
    if (previous && report.selfSleepingObserved && time >= 0 && previous.time >= 0) {
      const advance = ((time - previous.time) % 24000 + 24000) % 24000
      if (advance > Math.max(200, (at - previous.at) / 50 + 100)) {
        report.worldTimeJumpObserved = true
        record('world_time_jump', { source, clockId, clockName, before: previous.time, after: time, advance, paused })
      }
    }
    lastTimes.set(key, { time, at })
  }
  function clockSample (id, time, paused) {
    const clockId = String(id)
    const name = clockNames.get(clockId) ?? null
    report.worldClocks[clockId] = { name, time, paused }
    // Other clocks (including the End) are not evidence for an Overworld night skip.
    if (name === 'minecraft:overworld') sampleTime('clock:' + clockId, time, paused, 'sync_world_clocks', clockId, name)
  }
  function metadata (packet, id, entries = [], tick) {
    const self = report.selfRuntimeId !== undefined && String(id) === report.selfRuntimeId
    const player = self ? report.selfName : players.get(String(id))
    if (!player || (!self && player !== report.player)) return
    const stateField = self ? 'selfSleepState' : 'targetSleepState'
    record(packet, {
      runtimeId: String(id), player, metadata: JSON.parse(json(entries)),
      ...(tick !== undefined ? { tick: String(tick) } : {})
    })
    const evidence = {}
    for (const entry of entries) {
      if (entry.key === 'player_flags' && Number.isInteger(entry.value)) {
        evidence.playerFlags = entry.value
        evidence.playerSleeping = (entry.value & 2) !== 0
      } else if (entry.key === 'flags_extended' && entry.value?._value !== undefined) {
        // minecraft-data 3.119.0 omits LAYING_DOWN (global bit 64) from this word; named flags are shifted.
        // https://github.com/pmmp/BedrockProtocol/blob/master/src/types/entity/EntityMetadataFlags.php
        const raw = BigInt(entry.value._value)
        evidence.extendedFlags = String(raw)
        evidence.actorSleeping = (raw & (1n << 12n)) !== 0n
        evidence.wantsToWake = (raw & (1n << 13n)) !== 0n
      }
    }
    const sleeping = evidence.playerSleeping ?? evidence.actorSleeping
    if (evidence.playerSleeping !== undefined && evidence.actorSleeping !== undefined && evidence.playerSleeping !== evidence.actorSleeping) {
      report[stateField] = 'unknown'
      sleepStates.delete(String(id))
      record('sleep_conflict', { fromPacket: packet, runtimeId: String(id), player, evidence })
    } else if (sleeping !== undefined && sleepStates.get(String(id)) !== sleeping) {
      const initial = !sleepStates.has(String(id))
      sleepStates.set(String(id), sleeping)
      report[stateField] = sleeping ? 'sleeping' : 'awake'
      if (sleeping) report[self ? 'selfSleepingObserved' : 'targetSleepingObserved'] = true
      if (!self && sleeping && report.selfSleepState === 'sleeping') report.selfPartnerObserved = true
      if (!initial) report[self ? 'selfSleepTransitions' : 'sleepTransitions'][sleeping ? 'entered' : 'left']++
      record('sleep_state', {
        fromPacket: packet, runtimeId: String(id), player, sleeping,
        transition: initial ? 'initial' : sleeping ? 'entered_bed' : 'left_bed', evidence,
        ...(tick !== undefined ? { tick: String(tick) } : {})
      })
    }
    for (const entry of entries) {
      let fields
      if (['player_bed_position', 'bed_enter_position'].includes(entry.key)) {
        fields = { [entry.key]: entry.value }
      } else continue
      const key = `${id}:${entry.key}`
      const value = json(fields)
      if (previous.get(key) === value) continue
      previous.set(key, value)
      record(packet, { runtimeId: String(id), player, ...fields })
    }
  }
  return (packet, data) => {
    if (packet === 'start_game') {
      if (data.runtime_entity_id !== undefined) report.selfRuntimeId = String(data.runtime_entity_id)
      report.position = data.player_position
      report.dimension = data.dimension
      record(packet, { position: data.player_position, dimension: data.dimension })
    } else if (packet === 'set_time' && report.mode === 'self' && Number.isInteger(data.time)) {
      record(packet, { time: data.time })
      sampleTime('legacy', data.time, false, 'set_time')
    } else if (packet === 'sync_world_clocks') {
      record(packet, JSON.parse(json(data)))
      if (data.payload_type === 'initialize_registry') {
        clockNames.clear()
        report.worldClocks = Object.create(null)
        for (const key of lastTimes.keys()) if (key.startsWith('clock:')) lastTimes.delete(key)
        for (const clock of data.clocks || []) {
          clockNames.set(String(clock.id), clock.name)
          clockSample(clock.id, clock.time, clock.paused)
        }
      } else if (data.payload_type === 'sync_state') {
        for (const clock of data.sync_states || []) clockSample(clock.clock_id, clock.time, clock.paused)
      }
    } else if (packet === 'add_player') {
      players.set(String(data.runtime_id), data.username)
      if (data.unique_id !== undefined) uniqueIds.set(String(data.unique_id), String(data.runtime_id))
      for (const key of previous.keys()) if (key.startsWith(`${data.runtime_id}:`)) previous.delete(key)
      sleepStates.delete(String(data.runtime_id))
      record(packet, { player: data.username, runtimeId: String(data.runtime_id), position: data.position })
      if (data.username === report.player) {
        report.targetTracked = true
        report.targetSleepState = 'unknown'
      }
      metadata(packet, data.runtime_id, data.metadata)
    } else if (packet === 'remove_entity') {
      const id = uniqueIds.get(String(data.entity_id_self))
      if (id !== undefined) {
        if (players.get(id) === report.player) {
          report.targetSleepState = 'unknown'
          record(packet, { player: report.player, runtimeId: id })
        }
        sleepStates.delete(id)
        players.delete(id)
        uniqueIds.delete(String(data.entity_id_self))
      }
    } else if (packet === 'set_entity_data') {
      metadata(packet, data.runtime_entity_id, data.metadata, data.tick)
    } else if (packet === 'level_event') {
      const sleepEvent = ['players_sleeping', 'sleeping_players', 9800, 9801].includes(data.event)
      if (sleepEvent) report.levelEventsObserved++
      // Preserve the server value without assuming it is a global sleeper count.
      if (sleepEvent || report.mode === 'self') record(packet, { event: data.event, data: data.data, position: data.position })
    } else if (packet === 'player_action' && ['start_sleeping', 'stop_sleeping', 5, 6].includes(data.action)) {
      record(packet, { action: data.action, runtimeId: String(data.runtime_entity_id), player: players.get(String(data.runtime_entity_id)), position: data.position })
    } else if (packet === 'text' || packet === 'set_title') {
      if (packet === 'text' && (!['raw', 'translation', 'popup', 'jukebox_popup', 'tip', 'system', 'json', 'json_announcement'].includes(data.type) || data.source_name)) return
      const message = packet === 'text' ? data.message : data.text
      const parameters = data.parameters || []
      record('server_message', { fromPacket: packet, type: data.type, message, parameters, needsTranslation: data.needs_translation })
      if (packet === 'text' && data.type === 'translation' && data.needs_translation === true && message === 'multiplayer.playersSkippingNight') {
        report.nightSkipAnnouncementObserved = true
        record('night_skip_announcement', { source: message })
      }
      if (!/sleep|bed|schlaf|bett|skip.*night/i.test(json([message, parameters]))) return
      report.sleepNoticesObserved++
      // Mojang's chat.type.sleeping: player name, then the number of ADDITIONAL sleepers needed.
      // https://github.com/Mojang/bedrock-samples/blob/main/resource_pack/texts/en_US.lang
      if (packet === 'text' && data.type === 'translation' && data.needs_translation === true && message === 'chat.type.sleeping' &&
        parameters.length === 2 && typeof parameters[0] === 'string' && typeof parameters[1] === 'string' && /^\d+$/.test(parameters[1]) && Number.isSafeInteger(Number(parameters[1]))) {
        report.remainingPlayers = { count: Number(parameters[1]), sleeper: parameters[0], at: new Date().toISOString(), source: message }
        record('remaining_players', report.remainingPlayers)
        if (parameters[0] === report.player && report.selfSleepState === 'sleeping') report.selfPartnerObserved = true
      }
      // A server notice may be visible only to the sleeper; it never proves the target player's state.
      record('sleep_notice', { fromPacket: packet, type: data.type, message, parameters, needsTranslation: data.needs_translation })
    }
  }
}

function readOptions (env) {
  const { readConfig } = require('../dist/config.js')
  const config = readConfig(env)
  const mode = env.SMOKE_SLEEP_MODE || 'observe'
  if (!['observe', 'self'].includes(mode)) throw new Error('SMOKE_SLEEP_MODE must be observe or self')
  const seconds = Number(env.SMOKE_SECONDS || (mode === 'self' ? 1500 : 180))
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 7200) throw new Error('SMOKE_SECONDS must be 1..7200')
  const scenario = env.SMOKE_SLEEP_SCENARIO || (mode === 'self' ? 'near' : undefined)
  if (!['near', 'far', ...(mode === 'self' ? ['solo'] : [])].includes(scenario)) throw new Error('Set SMOKE_SLEEP_SCENARIO to near or far (or solo in self mode)')
  const player = scenario === 'solo' ? null : env.OBSERVE_PLAYER
  if (scenario !== 'solo' && (!player?.trim() || player === config.username)) throw new Error('Set OBSERVE_PLAYER to another player (exact in-game name)')
  return { config, seconds, scenario, player, mode }
}

function observe (client, report, seconds, write = console.log, bot) {
  return new Promise(resolve => {
    let finished = false
    let hold
    let activeTimer
    let selfSleeper
    let initialSpawnPending = true
    const record = createRecorder(report, write)
    report.packetCounts = Object.create(null)
    const countPacket = packet => {
      const name = packet.data?.name
      if (!finished && typeof name === 'string') report.packetCounts[name] = (report.packetCounts[name] || 0) + 1
    }
    client.on('packet', countPacket)
    const deadline = setTimeout(() => finish('failed', 'No spawn within 30 s'), 30000)
    function finish (result, reason) {
      if (finished) return
      finished = true
      clearTimeout(deadline)
      clearTimeout(hold)
      clearInterval(activeTimer)
      selfSleeper?.stop()
      client.removeListener('packet', countPacket)
      process.removeListener('SIGINT', interrupted)
      process.removeListener('SIGTERM', interrupted)
      report.result = result
      report.reason = reason
      report.finishedAt = new Date().toISOString()
      if (report.mode === 'self') report.assessments = require('./smoke-sleep-self.cjs').assessSelfSleep(report)
      try { if (bot) bot.stop(); else client.close() }
      catch (error) { report.result = 'failed'; report.reason = error.message }
      resolve(report)
    }
    function interrupted () { finish('interrupted', 'Observation interrupted; test incomplete') }
    process.once('SIGINT', interrupted)
    process.once('SIGTERM', interrupted)
    for (const name of ['start_game', 'add_player', 'remove_entity', 'set_entity_data', 'level_event', 'player_action', 'text', 'set_title', 'set_time', 'sync_world_clocks']) {
      client.on(name, data => { if (!finished) record(name, data) })
    }
    client.once('spawn', () => {
      if (finished) return
      clearTimeout(deadline)
      report.spawnedAt = new Date().toISOString()
      initialSpawnPending = false
      write(bot
        ? report.scenario === 'solo'
          ? `READY: Solo self-sleep test; no partner expected. Timeout ${seconds} s.`
          : `READY: Self-sleep test; ${report.player} must remain awake until WAITING. Timeout ${seconds} s.`
        : `READY: ${report.scenario}; ${report.player} should now enter a bed, leave it, then enter again. Observing for ${seconds} s.`)
      const timeout = () => {
        if (bot && report.postWakeUntil > Date.now()) {
          hold = setTimeout(timeout, report.postWakeUntil - Date.now() + 250)
          return
        }
        if (bot) {
          finish('inconclusive', 'Self-sleep deadline reached; inspect bed attempts, own metadata and remaining-player notices')
        } else if (report.scenario === 'far' && report.targetTracked) {
          finish('inconclusive', 'Target was entity-tracked; repeat with the player outside tracking range before login')
        } else if (report.targetSleepingObserved || report.levelEventsObserved > 0) {
          finish('observed', 'Sleep metadata or level events received; sleeping does not require a night skip, level-event attribution remains unverified')
        } else {
          finish('no_signal', 'No confirmed target sleep flag or sleep level event received; this does not prove protocol support is absent')
        }
      }
      hold = setTimeout(timeout, seconds * 1000)
    })
    // Bedrock may require this handshake before the initial spawn; never acknowledge a later death.
    client.on('respawn', data => {
      if (bot) {
        if (!finished && report.spawnedAt) finish('failed', 'Respawn/death during observation')
        return
      }
      if (!finished && initialSpawnPending && data.state === 1) {
        initialSpawnPending = false
        client.queue('respawn', { position: data.position, state: 2, runtime_entity_id: client.entityId })
      } else if (!finished && report.spawnedAt) finish('failed', 'Respawn/death during observation')
    })
    client.on('kick', () => finish('failed', 'Kicked by server'))
    client.on('error', error => finish('failed', error.message))
    client.on('close', () => finish('failed', 'Connection closed before observation completed'))
    if (bot) {
      selfSleeper = require('./smoke-sleep-self.cjs').createSelfSleeper(bot, client, report, finish, write)
      activeTimer = setInterval(() => { void selfSleeper.step().catch(error => finish('failed', error.message)) }, 250)
    }
  })
}

async function main () {
  const { config, seconds, scenario, player, mode } = readOptions(process.env)
  const { createClient } = require('bedrock-protocol')
  const report = {
    startedAt: new Date().toISOString(), scenario, player, seconds, mode, version: config.version,
    ...(mode === 'self' ? { selfName: config.username } : {}),
    result: 'failed', targetTracked: false, targetSleepingObserved: false, levelEventsObserved: 0, events: []
  }
  const output = `data/sleep-smoke-${mode === 'self' ? 'self-' : ''}${scenario}-${Date.now()}.json`
  fs.mkdirSync('data', { recursive: true })
  console.log(`Sleep observation: ${scenario}, ${player === null ? 'no partner expected' : 'target ' + player}. Report: ${output}`)
  let client
  let bot
  try {
    const makeClient = () => createClient({
      host: config.host, port: config.port, version: config.version, transport: config.transport,
      username: config.username, offline: true, raknetBackend: 'jsp-raknet',
      skinData: { SelfSignedId: require('bedrock-protocol/src/datatypes/util').uuidFrom(config.username) },
      nethernet: config.transport === 'nethernet'
        ? { signalling: 'http', webrtcBackend: 'werift', serverKeyPath: './data/server-key.sha256', iceHost: config.iceHost }
        : undefined,
      connectTimeout: 9000, pingTimeout: 5000, conLog: console.log
    })
    if (mode === 'self') {
      let observation
      const { BotController } = require('../dist/bot.js')
      bot = new BotController(config, () => {
        client = makeClient()
        observation = observe(client, report, seconds, console.log, bot)
        return client
      })
      bot.enqueue('connect')
      bot.step()
      if (!observation) throw new Error(bot.state.lastError || 'Could not start self-sleep observation')
      bot.start()
      await observation
    } else {
      client = makeClient()
      client.viewDistance = config.radius
      await observe(client, report, seconds)
    }
  } catch (error) {
    report.reason = error.message
    report.finishedAt = new Date().toISOString()
    if (bot) bot.stop(); else client?.close()
  } finally {
    if (mode === 'self') report.assessments = require('./smoke-sleep-self.cjs').assessSelfSleep(report)
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
  }
  console.log(json({ result: report.result, reason: report.reason, assessments: report.assessments, output }))
  // Transport libraries may retain sockets after close; keep this live probe bounded.
  setTimeout(() => process.exit(report.result === 'observed' ? 0 : report.result === 'failed' ? 1 : 2), 1000)
}

module.exports = { createRecorder, readOptions, observe }
if (require.main === module) main().catch(error => {
  console.error(error.message)
  setTimeout(() => process.exit(1), 1000)
})
