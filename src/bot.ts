import { EventEmitter } from 'node:events'
import type { Config } from './config.js'
import { WorldState, type Position } from './state.js'
import { Navigator, DEBUG_YAW } from './navigation.js'
import { RoutePlanner, type PreviewRoute, type Target } from './pathfinder.js'
import { WorldError } from './world.js'
import type { ContainerWindow, Inventory, TransferStep } from './inventory.js'
import { Collector } from './collector.js'
import { Farmer } from './farming.js'
import { WorldConditions } from './world-conditions.js'
import { AutoSleeper } from './sleep.js'
import { applyMetadata, byteAngle, type Entity } from './entities.js'

export interface BotClient extends EventEmitter {
  queue(name: string, params: unknown): void
  close(): void
  viewDistance?: number
  entityId?: unknown
}
/** Who asked for a navigation via chat; navigations from the web UI have none. */
export type NavigationOrigin = { player: string; label: string; give?: number; chest?: number; farm?: number; collect?: number }
export type Command = 'connect' | 'disconnect' | 'stop_navigation' | { type: 'navigate'; x: number; z: number; y?: number; origin?: NavigationOrigin }
export type NavigationEnd = (origin: NavigationOrigin | null, status: string, message: string | null) => void
export type ClientFactory = (config: Config) => BotClient
/** One line of the web UI's chat log; `event` lines mark connects and disconnects. */
export type ChatLine = { at: number; kind: 'chat' | 'whisper' | 'bot' | 'event'; name: string; text: string }
const CHAT_LOG_SIZE = 100
const isPosition = (position: Position | undefined): position is Position =>
  Boolean(position) && [position!.x, position!.y, position!.z].every(Number.isFinite)
const finite = (value?: number) => Number.isFinite(value) ? value! : 0
/** Updates the angles a packet carries; missing ones keep their value. */
function turn (entity: Entity, yaw?: number, headYaw?: number, pitch?: number) {
  if (Number.isFinite(yaw)) entity.yaw = yaw!
  if (Number.isFinite(headYaw)) entity.headYaw = headYaw!
  if (Number.isFinite(pitch)) entity.pitch = pitch!
}
const isInventoryWindow = (id: string | number | undefined) => id === 'inventory' || id === 0
type DropJob = { name: string; count: number; toward: Position; resolve: (dropped: number) => void; reject: (error: Error) => void }
/** Why a chest visit ended: the transfer is complete, the source ran out, the target is full, or something interrupted it. */
export type ChestStop = 'done' | 'source_empty' | 'target_full' | 'not_opened' | 'rejected' | 'timeout' | 'closed' | 'cancelled'
export type ChestResult = { opened: boolean; size: number; moved: number; stop: ChestStop }
/** Decides the next move while the chest is open; called again after every confirmed move. */
export type ChestPlanner = (inventory: Inventory, window: ContainerWindow, moved: number) => TransferStep
type ChestJob = {
  chest: Position; next: ChestPlanner; phase: 'click' | 'opening' | 'content' | 'move' | 'waiting' | 'closing' | 'closed'
  since: number; windowId: number | string | null; windowType: unknown; size: number; moved: number; stop: ChestStop | null; cancelled: boolean
  resolve: (result: ChestResult) => void; reject: (error: Error) => void
}
// The server answers a chest click within this time once an input tick followed; content and close answers come at once.
const CHEST_OPEN_MS = 2000
const CHEST_CONTENT_MS = 1000
const CHEST_CLOSE_MS = 1000
// On open the server resends the bot's inventory with new stack IDs right after the chest content; wait for it before the first move.
const CHEST_SETTLE_MS = 100
const chestLog = (message: string) => console.log('[chest] ' + message)

export class BotController {
  readonly state: WorldState
  /** The farming mode; it lives with the bot so the web UI can switch it without chat commands. */
  readonly farm: Farmer
  readonly collector: Collector
  readonly conditions = new WorldConditions()
  readonly sleep: AutoSleeper
  private suspendedRun: { target: Target; origin: NavigationOrigin | null; session: number } | null = null
  private deferredChest: Array<{ run: () => void; reject: (error: Error) => void }> = []
  private navigator: Navigator
  private commands: Command[] = []
  private client: BotClient | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private wanted = false
  private attempts = 0
  private retryAt = 0
  private connectDeadline = 0
  private stopped = false
  private publishAt = 0
  private previewJob: { step: () => void; cancel: () => void } | null = null
  private runActive = false
  private runOrigin: NavigationOrigin | null = null
  private chatLines: ChatLine[] = []
  private chatLogRevision = 0
  private drops: DropJob[] = []
  private chestJob: ChestJob | null = null
  /** Called for every chat or whisper line from another player. */
  onChat: (sender: string, message: string) => void = () => {}
  /** Called once when a navigation run ends: arrived, failed, stopped, replaced or lost with the connection. */
  onNavigationEnd: NavigationEnd = () => {}

  get username () { return this.config.username }

  constructor (
    private config: Config,
    private createClient: ClientFactory,
    private publish: () => void = () => {},
    private now: () => number = Date.now
  ) {
    this.state = new WorldState(config.radius, config.version); this.state.openDoors = config.openDoors !== false
    this.navigator = new Navigator(this.state)
    // Getters, because tests replace state and navigator after construction.
    const bot = this
    this.farm = new Farmer({
      get state () { return bot.state }, get navigator () { return bot.navigator }, reach: config.radius * 16,
      now: () => this.now(),
      enqueue: command => this.enqueue(command),
      activate: () => { this.sleep?.manualWork(); this.collector.off('Farming gestartet') },
      entityId: () => this.client?.entityId,
      useChest: (chest, next) => this.useChest(chest, next),
      cancelChest: () => this.cancelChest(),
      stopNavigation: () => {
        if (!this.runActive || this.runOrigin?.farm === undefined) return
        this.navigator.stop()
        this.settleNavigation()
      },
      publish: () => { this.publishAt = 0 }
    })
    this.collector = new Collector({
      get state () { return bot.state }, get navigator () { return bot.navigator }, reach: config.radius * 16,
      now: () => this.now(), enqueue: command => this.enqueue(command),
      activate: () => { this.sleep?.manualWork(); this.farm.off('Collector gestartet'); this.cancelChest() },
      stopNavigation: () => {
        this.commands = this.commands.filter(command => typeof command !== 'object' || command.origin?.collect === undefined)
        if (!this.runActive || this.runOrigin?.collect === undefined) return
        this.navigator.stop(); this.settleNavigation()
      },
      publish: () => { this.publishAt = 0 }
    })
    this.sleep = new AutoSleeper({
      get state () { return bot.state }, get navigator () { return bot.navigator }, conditions: this.conditions,
      now: () => this.now(), send: (name, params) => this.client?.queue(name, params), entityId: () => this.client?.entityId,
      pause: () => {
        this.previewJob?.cancel()
        this.suspendedRun = this.runActive && this.state.navigation.target ? { target: { ...this.state.navigation.target }, origin: this.runOrigin, session: this.state.worldSession } : null
        this.runActive = false
        this.navigator.stop()
        this.farm.suspendForSleep(true); this.collector.suspendForSleep(true)
      },
      resume: discard => {
        this.farm.suspendForSleep(false); this.collector.suspendForSleep(false)
        const run = this.suspendedRun; this.suspendedRun = null
        if (discard || !run || this.state.status !== 'spawned' || run.session !== this.state.worldSession) return
        if (run.origin?.farm !== undefined && !this.farm.acceptsNavigation(run.origin.farm)) return
        if (run.origin?.collect !== undefined && !this.collector.acceptsNavigation(run.origin.collect)) return
        this.navigator.start({ ...run.target, ...(run.origin?.farm !== undefined && run.target.y !== undefined ? { exactY: true } : {}) }, this.now())
        this.runActive = true; this.runOrigin = run.origin
      },
      busy: () => this.chestBusy || this.farm.inventoryBusy
    })
  }

  enqueue (command: Command) {
    if (this.stopped) return false
    if (typeof command === 'object' && (!command || command.type !== 'navigate' || ![command.x, command.z].every(n => Number.isInteger(n) && Math.abs(n) <= 30000000) ||
      (command.y !== undefined && (!Number.isFinite(command.y) || Math.abs(command.y) > 30000000)) ||
      (command.origin !== undefined && (typeof command.origin?.player !== 'string' || typeof command.origin.label !== 'string')))) return false
    if (command === 'stop_navigation') {
      this.commands = this.commands.filter(command => typeof command === 'string' && command !== 'stop_navigation')
      this.commands.unshift(command)
      return true
    }
    if (this.commands.length >= 32) return false
    if (typeof command === 'object' && command.origin?.farm === undefined && command.origin?.collect === undefined) this.sleep.manualWork()
    this.commands.push(command)
    return true
  }

  start () {
    if (this.stopped || this.timer) return
    this.timer = setInterval(() => this.step(), 50)
  }

  step () {
    if (this.stopped) return
    this.state.flushSurfaceChanges()
    this.state.tick++
    for (const command of this.commands.splice(0)) {
      if (typeof command === 'object') {
        if (this.sleep.active) { this.commands.push(command); continue }
        if (command.origin?.collect !== undefined && !this.collector.acceptsNavigation(command.origin.collect)) continue
        if (command.origin?.farm !== undefined && !this.farm.acceptsNavigation(command.origin.farm)) continue
        this.previewJob?.cancel()
        // A target from the web UI ends farming; the farmer's own targets keep it running.
        if (!command.origin) { this.farm.off('UI-Navigation'); this.collector.off('UI-Navigation') }
        this.cancelChest()
        // A new target replaces the running one; report that run as stopped first.
        if (this.runActive) { this.runActive = false; this.endRun(this.runOrigin, 'stopped', 'Neues Ziel gesetzt.') }
        this.navigator.start({ x: command.x, z: command.z, ...(command.y !== undefined ? { y: command.y, ...(command.origin?.farm !== undefined ? { exactY: true } : {}) } : {}) }, this.now())
        this.runActive = true; this.runOrigin = command.origin ? { ...command.origin } : null
        this.settleNavigation()
      } else if (command === 'stop_navigation') {
        this.farm.off('Stopp')
        this.collector.off('Stopp')
        this.cancelChest()
        this.suspendedRun = null
        this.sleep.stop()
        for (const job of this.drops.splice(0)) job.reject(new Error('Gestoppt.'))
        for (const job of this.deferredChest.splice(0)) job.reject(new Error('Gestoppt.'))
        this.navigator.stop()
        this.settleNavigation()
      } else if (command === 'disconnect') {
        this.wanted = false
        this.closeClient()
        this.state.status = 'disconnected'
      } else if (!this.wanted) {
        this.wanted = true
        this.attempts = 0
        this.retryAt = 0
        this.state.lastError = null
      }
    }
    if (this.client && this.state.status === 'connecting' && this.now() >= this.connectDeadline) {
      this.failed('Login/spawn timeout (30 s)')
    }
    if (this.wanted && !this.client && this.now() >= this.retryAt) this.connect()
    if (this.client && this.state.status === 'spawned') {
      const send = (name: string, params: unknown) => this.client?.queue(name, params)
      try {
        this.state.requestSubchunks(send, this.now())
        this.sleep.step()
        if (!this.sleep.active) {
          if (!this.chestBusy) this.deferredChest.shift()?.run()
          this.navigator.step(send, this.now())
          // The bot turns towards the receiver first; the server throws dropped items in the facing direction.
          for (const job of this.drops.splice(0)) {
            this.navigator.face(send, job.toward)
            this.state.inventory.drop(send, job.name, job.count, this.now()).then(job.resolve, job.reject)
          }
          this.stepChest(send)
          this.farm.step(send)
          this.collector.step(send)
        } else if (this.sleep.preparing) {
          // Finish an already sent chest transfer before changing position; no new jobs start here.
          this.stepChest(send); this.farm.step(send)
        }
        this.state.inventory.expire(this.now())
      }
      catch (error) { this.failed(error instanceof Error ? error.message : String(error)) }
      this.settleNavigation()
    }
    if (this.now() >= this.publishAt) {
      this.publishAt = this.now() + 1000
      this.publish()
    }
    this.previewJob?.step()
  }

  previewRoute (target: Target, signal?: AbortSignal): Promise<PreviewRoute> {
    this.previewJob?.cancel()
    if (this.stopped || this.state.status !== 'spawned' || !this.state.position) return Promise.reject(new WorldError('Bot must be spawned before preview', 409))
    if (['planning', 'moving'].includes(this.state.navigation.status)) return Promise.reject(new WorldError('Stop navigation before previewing another target', 409))
    if (signal?.aborted) return Promise.reject(new WorldError('Preview cancelled', 499))
    const origin = { ...this.state.position }; const session = this.state.worldSession
    let planner: RoutePlanner
    try { planner = new RoutePlanner(this.state, origin, target) }
    catch (error) { return Promise.reject(new WorldError(error instanceof Error ? error.message : String(error), 409)) }
    const deadline = this.now() + 15000
    return new Promise((resolve, reject) => {
      const finish = (error?: WorldError, result?: PreviewRoute) => {
        signal?.removeEventListener('abort', job.cancel)
        if (this.previewJob === job) this.previewJob = null
        if (error) reject(error); else resolve(result!)
      }
      const job = {
        cancel: () => finish(new WorldError('Preview cancelled; repeat selection', 409)),
        step: () => {
          const p = this.state.position
          if (this.state.status !== 'spawned' || session !== this.state.worldSession || !p || Math.hypot(p.x-origin.x, p.y-origin.y, p.z-origin.z) > .001) return job.cancel()
          if (this.now() >= deadline) return finish(new WorldError('Preview timed out (15 s)', 409))
          try {
            const path = planner.step()
            if (path?.some(p => !this.state.canStandAt(p.x, p.z, p.y))) throw new Error('World changed; repeat selection')
            if (path) finish(undefined, {target:{...target}, origin, path, session, revision:this.state.worldRevision})
          } catch (error) { finish(new WorldError(error instanceof Error ? error.message : String(error), 409)) }
        }
      }
      this.previewJob = job
      signal?.addEventListener('abort', job.cancel, {once:true})
    })
  }

  private connect () {
    this.conditions.reset()
    this.state.resetWorld()
    this.state.status = 'connecting'
    this.connectDeadline = this.now() + 30000
    try {
      const client = this.createClient(this.config)
      this.client = client
      client.viewDistance = this.config.radius
      const active = () => this.client === client
      let initialSpawnPending = true
      let loadingFinished = false
      let selfUniqueId: string | null = null
      const finishLoading = () => {
        if (!loadingFinished && !initialSpawnPending && this.state.status === 'spawned') {
          loadingFinished = true
          client.queue('serverbound_loading_screen', { type: 1, loading_screen_id: undefined })
          client.queue('serverbound_loading_screen', { type: 2, loading_screen_id: undefined })
        }
      }
      client.on('error', (error: Error) => { if (active()) this.failed(error.message) })
      client.on('kick', (packet: { message?: string }) => { if (active()) this.failed(packet.message || 'Server kick') })
      client.on('close', () => { if (active()) this.failed('Connection closed') })
      client.on('start_game', (packet: { entity_id?: bigint | string; player_position: Position; rotation?: { x: number; z: number }; dimension: number | string; block_network_ids_are_hashes?: boolean; current_tick?: bigint }) => {
        if (!active()) return
        this.conditions.start(packet as { rain_level?: number; lightning_level?: number })
        if (packet.entity_id !== undefined) selfUniqueId = String(packet.entity_id)
        if (typeof packet.block_network_ids_are_hashes === 'boolean') this.state.beginWorld(packet.dimension, packet.block_network_ids_are_hashes)
        if (typeof packet.current_tick === 'bigint') this.navigator.synchroniseTick(packet.current_tick)
        this.updatePosition(packet.player_position)
        if (Number.isFinite(packet.rotation?.x)) this.state.pitch = packet.rotation!.x
        if (Number.isFinite(packet.rotation?.z)) this.state.yaw = packet.rotation!.z
        this.state.dimension = packet.dimension
      })
      client.on('set_time', packet => { if (active()) this.conditions.legacyTime(packet.time, this.now()) })
      client.on('sync_world_clocks', packet => { if (active()) this.conditions.clocks(packet, this.now()) })
      client.on('level_event', packet => { if (active()) this.conditions.weather(packet.event) })
      client.on('set_entity_data', packet => {
        if (!active() || !Array.isArray(packet.metadata)) return
        this.conditions.metadata(String(packet.runtime_entity_id), String(client.entityId), packet.metadata)
        const entity = this.state.entities.get(String(packet.runtime_entity_id))
        if (entity) applyMetadata(entity, packet.metadata)
      })
      client.on('text', packet => { if (active()) this.conditions.notice(packet, this.config.username, this.now()) })
      client.on('container_open', packet => {
        if (DEBUG_YAW) console.log(`[nav] yaw marker container_open ${packet.window_type}`)
        if (active()) this.sleep.opened(packet)
      })
      client.on('container_close', packet => {
        if (DEBUG_YAW) console.log('[nav] yaw marker container_close')
        if (active()) this.sleep.closed(packet.window_id)
      })
      client.on('add_player', packet => {
        if (active() && String(packet.runtime_id) !== String(client.entityId)) this.conditions.player(String(packet.runtime_id), packet.username, packet.metadata ?? [])
      })
      client.on('level_chunk', packet => { if (active()) this.state.receiveColumn(packet) })
      client.on('subchunk', packet => { if (active()) this.state.receiveSubchunks(packet) })
      client.on('update_block', packet => { if (active()) this.state.updateBlock(packet.position, packet.block_runtime_id, packet.layer) })
      client.on('update_subchunk_blocks', packet => {
        if (!active()) return
        for (const block of packet.blocks) this.state.updateBlock(block.position, block.runtime_id, 0)
        for (const block of packet.extra) this.state.updateBlock(block.position, block.runtime_id, 1)
      })
      client.on('spawn', () => {
        if (!active() || !this.wanted) return
        this.state.status = 'spawned'
        this.state.lastError = null
        this.attempts = 0
        client.queue('request_chunk_radius', { chunk_radius: this.config.radius, max_radius: this.config.radius })
        finishLoading()
        this.logChat('event', '', 'Verbunden')
        this.publish()
      })
      client.on('respawn', (packet: { state: number; position: Position }) => {
        // BDS uses respawn 0/1 during initial login too; state 1 supplies the final position.
        if (!active() || !initialSpawnPending || packet.state !== 1) return
        initialSpawnPending = false
        this.updatePosition(packet.position)
        this.navigator.acknowledgeTeleport()
        client.queue('respawn', { position: packet.position, state: 2, runtime_entity_id: client.entityId })
        finishLoading()
      })
      client.on('move_player', (packet: { runtime_id: bigint | string; position: Position; yaw?: number; pitch?: number; mode?: string | number }) => {
        if (!active()) return
        if (String(packet.runtime_id) === String(client.entityId)) {
          if (DEBUG_YAW) console.log(`[nav] yaw server move_player ${packet.yaw} pitch ${packet.pitch} mode ${packet.mode}`)
          this.updatePosition(packet.position)
          if (Number.isFinite(packet.yaw)) this.state.yaw = packet.yaw!
          if (Number.isFinite(packet.pitch)) this.state.pitch = packet.pitch!
          if (packet.mode === 'teleport' || packet.mode === 'reset' || packet.mode === 1 || packet.mode === 2) this.navigator.acknowledgeTeleport()
        } else this.movePlayer(packet.runtime_id, packet.position, packet.yaw, packet.pitch)
      })
      client.on('add_player', (packet: { runtime_id: bigint | string; unique_id?: bigint | string; uuid?: string; username: string; position: Position; yaw?: number; pitch?: number }) => {
        const id = String(packet.runtime_id)
        if (active() && id !== String(client.entityId) && isPosition(packet.position)) {
          this.state.players.set(id, { name: String(packet.username ?? ''), position: { ...packet.position }, uniqueId: String(packet.unique_id ?? id), uuid: String(packet.uuid ?? '') })
          this.movePlayer(id, packet.position, packet.yaw, packet.pitch)
        }
      })
      // Mobs, vehicles and other entities; players and dropped items have their own packets.
      client.on('add_entity', (packet: { unique_id: bigint | string; runtime_id: bigint | string; entity_type: string; position: Position; yaw?: number; head_yaw?: number;
        pitch?: number; attributes?: { name?: string }[]; metadata?: { key: string; value: unknown }[] }) => {
        if (!active() || !isPosition(packet.position)) return
        const entity: Entity = { uniqueId: String(packet.unique_id), type: String(packet.entity_type ?? '').replace(/^minecraft:/, ''), position: { ...packet.position },
          yaw: finite(packet.yaw), headYaw: finite(packet.head_yaw ?? packet.yaw), pitch: finite(packet.pitch),
          living: !!packet.attributes?.some(attribute => attribute.name === 'minecraft:health'), name: '', flags: new Set() }
        applyMetadata(entity, packet.metadata ?? [])
        this.state.entities.set(String(packet.runtime_id), entity)
      })
      // Delta packets carry only the changed absolute coordinates. Rotations are raw bytes (256 per turn):
      // rot_x is pitch, rot_y (body) yaw and rot_z head yaw.
      client.on('move_entity_delta', (packet: { runtime_entity_id: bigint | string; x?: number; y?: number; z?: number; rot_x?: number; rot_y?: number; rot_z?: number }) => {
        const id = String(packet.runtime_entity_id)
        const entity = active() ? this.state.players.get(id) ?? this.state.items.get(id) ?? this.state.entities.get(id) : undefined
        if (!entity) return
        const position = {
          x: Number.isFinite(packet.x) ? packet.x! : entity.position.x,
          y: Number.isFinite(packet.y) ? packet.y! : entity.position.y,
          z: Number.isFinite(packet.z) ? packet.z! : entity.position.z
        }
        const angle = (value?: number) => Number.isFinite(value) ? byteAngle(value!) : undefined
        if (this.state.players.has(id)) { this.movePlayer(packet.runtime_entity_id, position, angle(packet.rot_y), angle(packet.rot_x)); return }
        entity.position = position
        const mob = this.state.entities.get(id)
        if (mob) turn(mob, angle(packet.rot_y), angle(packet.rot_z), angle(packet.rot_x))
      })
      // Absolute moves carry byterot angles, which bedrock-protocol already converts to degrees.
      client.on('move_entity', (packet: { runtime_entity_id: bigint | string; position: Position; rotation?: { yaw?: number; pitch?: number; head_yaw?: number } }) => {
        if (!active() || !isPosition(packet.position)) return
        const id = String(packet.runtime_entity_id)
        const entity = this.state.players.get(id) ?? this.state.items.get(id) ?? this.state.entities.get(id)
        if (entity) entity.position = { ...packet.position }
        const mob = this.state.entities.get(id)
        if (mob) turn(mob, packet.rotation?.yaw, packet.rotation?.head_yaw, packet.rotation?.pitch)
      })
      // Dropped items (e.g. from harvesting) until someone picks them up or they despawn; the farmer walks onto them.
      client.on('add_item_entity', (packet: { runtime_entity_id: bigint | string; entity_id_self?: bigint | string; item?: { network_id?: number; count?: number }; position: Position }) => {
        if (!active() || !isPosition(packet.position)) return
        const id = String(packet.runtime_entity_id)
        this.state.items.set(id, { uniqueId: String(packet.entity_id_self ?? id), name: this.state.inventory.itemName(packet.item?.network_id ?? 0),
          count: packet.item?.count ?? 0, position: { ...packet.position } })
      })
      client.on('take_item_entity', (packet: { runtime_entity_id: bigint | string; target?: bigint | string | number }) => {
        if (!active()) return
        const id = String(packet.runtime_entity_id)
        const item = this.state.items.get(id)
        if (item && packet.target !== undefined && String(packet.target) === String(client.entityId)) this.collector.pickedUp(item)
        this.state.items.delete(id)
      })
      // remove_entity carries the unique entity ID, which differs from the runtime ID on BDS.
      client.on('remove_entity', (packet: { entity_id_self: bigint | string }) => {
        if (!active()) return
        const uniqueId = String(packet.entity_id_self)
        for (const [id, player] of this.state.players) if (player.uniqueId === uniqueId) { this.conditions.remove(id); this.state.players.delete(id) }
        for (const [id, item] of this.state.items) if (item.uniqueId === uniqueId) this.state.items.delete(id)
        for (const [id, entity] of this.state.entities) if (entity.uniqueId === uniqueId) this.state.entities.delete(id)
      })
      // player_list names every player on the server; each record carries its own add/remove type.
      // The bot itself is recognised by unique ID or name.
      client.on('player_list', (packet: { records?: { type?: string; uuid?: string; entity_unique_id?: bigint | string; username?: string }[] }) => {
        if (!active() || !Array.isArray(packet.records)) return
        for (const record of packet.records) {
          if (!record.uuid) continue
          const uuid = String(record.uuid)
          if (record.type === 'add') {
            if (String(record.entity_unique_id) === selfUniqueId || record.username === this.config.username) continue
            this.state.roster.set(uuid, String(record.username ?? ''))
          } else if (record.type === 'remove') {
            const name = this.state.roster.get(uuid)
            if (name) this.conditions.offline(name)
            this.state.roster.delete(uuid)
            for (const [id, player] of this.state.players) if (player.uuid === uuid) { this.conditions.remove(id); this.state.players.delete(id) }
          }
        }
      })
      // Only player-authored lines; the bot's own echo, system and translated messages are ignored.
      client.on('text', (packet: { type?: string; source_name?: string; message?: string }) => {
        if (!active() || (packet.type !== 'chat' && packet.type !== 'whisper')) return
        // Servers append formatting codes such as §r to sender names, also to the echo of the bot's own lines.
        const sender = String(packet.source_name ?? '').replace(/§./g, '').trim()
        if (sender && sender !== this.config.username && typeof packet.message === 'string') {
          this.logChat(packet.type, sender, packet.message)
          this.onChat(sender, packet.message)
        }
      })
      // Item names arrive once per login; the inventory (window 0) arrives complete after spawning and slot by slot afterwards.
      client.on('item_registry', (packet: { itemstates?: unknown }) => { if (active()) this.state.inventory.setRegistry(packet.itemstates) })
      client.on('inventory_content', (packet: { window_id?: string | number; input?: unknown }) => {
        if (active() && isInventoryWindow(packet.window_id)) { this.state.inventory.setContent(packet.input); this.publishAt = 0 }
        // The opened chest's slots come with the window ID from container_open (54 for a double chest).
        const job = this.chestJob
        if (active() && job?.phase === 'content' && packet.window_id === job.windowId) {
          job.size = this.state.inventory.openWindow(job.windowId, job.windowType, packet.input).slots.length
          job.phase = 'move'; job.since = this.now()
        }
      })
      client.on('container_open', (packet: { window_id?: string | number; window_type?: unknown; coordinates?: Position }) => {
        if (active() && packet.window_id !== undefined) this.farm.inventoryOpened(packet.window_id, packet.window_type)
        const job = this.chestJob
        if (!active() || job?.phase !== 'opening' || packet.window_id === undefined) return
        chestLog(`Kiste bei (${job.chest.x}, ${job.chest.y}, ${job.chest.z}) offen: Fenster ${packet.window_id}, Typ ${String(packet.window_type)}.`)
        job.windowId = packet.window_id; job.windowType = packet.window_type
        job.phase = 'content'; job.since = this.now()
      })
      client.on('container_close', (packet: { window_id?: string | number }) => {
        if (active() && packet.window_id !== undefined) this.farm.inventoryClosed(packet.window_id)
        const job = this.chestJob
        if (!active() || !job || job.windowId === null || packet.window_id !== job.windowId) return
        // Our own close is confirmed; any other close comes from the server (e.g. the chest was broken).
        if (job.phase !== 'closing' && job.phase !== 'closed') { job.stop ??= 'closed'; chestLog('Der Server hat die Kiste geschlossen.') }
        this.finishChest(true)
      })
      client.on('inventory_slot', (packet: { window_id?: string | number; slot?: number; item?: unknown }) => {
        if (active() && isInventoryWindow(packet.window_id)) { this.state.inventory.setSlot(packet.slot, packet.item); this.publishAt = 0 }
      })
      // Pickups arrive as a server-sent inventory_transaction whose container action carries the slot's new item (verified live).
      client.on('inventory_transaction', (packet: { transaction?: { actions?: { source_type?: string; window_id?: string | number; slot?: number; new_item?: unknown }[] } }) => {
        if (!active()) return
        for (const action of packet.transaction?.actions ?? []) {
          if (action.source_type === 'container' && isInventoryWindow(action.window_id)) { this.state.inventory.setSlot(action.slot, action.new_item); this.publishAt = 0 }
        }
      })
      client.on('item_stack_response',(packet: { responses?: unknown }) => {
        if (active()) { this.state.inventory.response(packet.responses); this.publishAt = 0 }
      })
      client.on('server_post_move', (packet: { position: Position }) => {
        if (active()) this.updatePosition(packet.position)
      })
      client.on('correct_player_move_prediction', (packet: { position: Position; tick?: bigint; prediction_type?: string | number; delta?: Position; on_ground?: boolean }) => {
        if (active() && packet.prediction_type !== 'vehicle' && packet.prediction_type !== 1 && packet.position && [packet.position.x, packet.position.y, packet.position.z].every(Number.isFinite)) this.navigator.serverCorrection(packet.position, packet.tick, packet.delta, packet.on_ground)
      })
      client.on('change_dimension', () => {
        if (active()) this.halt('Dimension changed; reconnect manually', 'error')
      })
      client.on('set_health', (packet: { health: number }) => {
        if (active() && packet.health <= 0) this.halt('Bot died; intervene manually', 'dead')
      })
      client.on('entity_event', (packet: { runtime_entity_id: bigint | string; event_id: number | string }) => {
        if (active() && String(packet.runtime_entity_id) === String(client.entityId) && (packet.event_id === 3 || packet.event_id === 'death_animation')) this.halt('Bot died; intervene manually', 'dead')
      })
    } catch (error) {
      this.failed(error instanceof Error ? error.message : String(error))
    }
  }

  // Only players announced by add_player are tracked, so other entities' movement is ignored.
  private movePlayer (runtimeId: bigint | string, position: Position, yaw?: number, pitch?: number) {
    const player = this.state.players.get(String(runtimeId))
    if (!player || !isPosition(position)) return
    player.position = { x: position.x, y: position.y, z: position.z }
    if (Number.isFinite(yaw)) player.yaw = yaw
    if (Number.isFinite(pitch)) player.pitch = pitch
  }

  private updatePosition (position: Position) {
    if (isPosition(position)) {
      this.state.position = { ...position }
      this.state.lastServerPosition = { ...position }
      this.state.positionSource = 'server'
      this.state.setCenter(position)
      if (['moving', 'planning'].includes(this.state.navigation.status)) this.navigator.serverCorrection(position)
    }
  }

  searchBlocks (blockId: string, limit = 50, signal?: AbortSignal) {
    return this.state.searchBlocks(blockId, limit, this.state.position, signal)
  }

  /** Sends a public chat line; returns false while not spawned. */
  say (message: string) {
    if (!this.client || this.state.status !== 'spawned') return false
    this.client.queue('text', {
      needs_translation: false, category: 'authored', type: 'chat', source_name: this.config.username, message,
      xuid: '', platform_chat_id: '', has_filtered_message: false
    })
    this.logChat('bot', this.config.username, message)
    return true
  }

  /** Drops up to `count` of an inventory item towards `toward` on the next tick; resolves with the amount the server confirmed. */
  dropItems (name: string, count: number, toward: Position): Promise<number> {
    if (this.stopped || !this.client || this.state.status !== 'spawned') return Promise.reject(new Error('Bot ist nicht verbunden.'))
    return new Promise((resolve, reject) => this.drops.push({ name, count, toward: { ...toward }, resolve, reject }))
  }

  /**
   * Opens the chest at `chest` (the bot must already stand within reach), moves items one stack portion at a time
   * as `next` decides, and closes it again. Resolves with what the server confirmed; rejects only on disconnect.
   */
  useChest (chest: Position, next: ChestPlanner): Promise<ChestResult> {
    if (this.stopped || !this.client || this.state.status !== 'spawned') return Promise.reject(new Error('Bot ist nicht verbunden.'))
    if (this.sleep.active) {
      if (this.deferredChest.length >= 32) return Promise.reject(new Error('Zu viele wartende Kistenaufträge.'))
      return new Promise((resolve, reject) => this.deferredChest.push({ run: () => { void this.useChest(chest, next).then(resolve, reject) }, reject }))
    }
    if (this.chestJob) return Promise.reject(new Error('Es ist schon eine Kiste offen.'))
    return new Promise((resolve, reject) => {
      this.chestJob = { chest: { ...chest }, next, phase: 'click', since: this.now(), windowId: null, windowType: null, size: 0, moved: 0, stop: null, cancelled: false, resolve, reject }
    })
  }

  /** True while a chest visit runs. */
  get chestBusy () { return this.chestJob !== null }

  /** Ends a chest visit early: a running request is still awaited, then the chest is closed. */
  cancelChest () {
    const job = this.chestJob
    if (!job || job.cancelled) return
    job.cancelled = true
    job.stop ??= 'cancelled'
    chestLog('Kistenzugriff abgebrochen.')
    if (job.phase === 'click' || job.phase === 'opening') this.finishChest(false)
    else if (job.phase === 'content' || job.phase === 'move') job.phase = 'closing'
  }

  // One tick of the chest visit: click, keep sending input until the server opens it, move, close.
  private stepChest (send: (name: string, params: unknown) => void) {
    const job = this.chestJob
    if (!job) return
    const now = this.now()
    const center = { x: job.chest.x + .5, z: job.chest.z + .5 }
    if (job.phase === 'click') {
      const runtimeId = this.state.blockRuntimeIdAt(job.chest.x, job.chest.y, job.chest.z)
      if (runtimeId === null) { job.stop = 'not_opened'; return this.finishChest(false) }
      chestLog(`Klicke Kiste bei (${job.chest.x}, ${job.chest.y}, ${job.chest.z}).`)
      this.navigator.clickBlock(send, job.chest, runtimeId, this.state.inventory.heldItem(0))
      // The server handles the click only together with the next input packet (verified live).
      this.navigator.face(send, center)
      job.phase = 'opening'; job.since = now
    } else if (job.phase === 'opening') {
      if (now - job.since > CHEST_OPEN_MS) { chestLog('Kiste hat sich nicht geöffnet.'); job.stop = 'not_opened'; return this.finishChest(false) }
      this.navigator.face(send, center)
    } else if (job.phase === 'content') {
      if (now - job.since > CHEST_CONTENT_MS) { job.stop = 'timeout'; job.phase = 'closing' }
    } else if (job.phase === 'move' && now - job.since >= CHEST_SETTLE_MS) {
      const window = this.state.inventory.window
      const decision = window ? job.next(this.state.inventory, window, job.moved) : { stop: 'timeout' as const }
      if ('stop' in decision) { job.stop = decision.stop; job.phase = 'closing' }
      else {
        job.phase = 'waiting'
        const move = decision.move
        this.state.inventory.place(send, move, now).then(response => {
          if (this.chestJob !== job) return
          if (response.status === 'ok' || response.status === 0) job.moved += move.count
          else job.stop = 'rejected'
          job.phase = job.stop === 'rejected' || job.cancelled ? 'closing' : 'move'
        }, () => {
          if (this.chestJob !== job) return
          job.stop ??= 'timeout'; job.phase = 'closing'
        })
      }
    }
    if (job.phase === 'closing') {
      send('container_close', { window_id: job.windowId, window_type: job.windowType, server: false })
      job.phase = 'closed'; job.since = now
    } else if (job.phase === 'closed' && now - job.since > CHEST_CLOSE_MS) this.finishChest(true)
  }

  private finishChest (opened: boolean) {
    const job = this.chestJob
    if (!job) return
    this.chestJob = null
    this.state.inventory.window = null
    const result = { opened, size: job.size, moved: job.moved, stop: job.stop ?? 'done' }
    chestLog(`Kiste fertig: ${JSON.stringify(result)}.`)
    job.resolve(result)
  }

  /** Revision of the chat log; it changes with every new line. */
  get chatRevision () { return this.chatLogRevision }

  /** The last 100 chat lines, oldest first; kept in memory only. */
  chatLog () { return { revision: this.chatLogRevision, lines: this.chatLines.map(line => ({ ...line })) } }

  private logChat (kind: ChatLine['kind'], name: string, text: string) {
    // Minecraft formatting codes (§x) are dropped; the UI shows plain text.
    const plain = (value: string) => value.replace(/§./g, '')
    this.chatLines.push({ at: this.now(), kind, name: plain(name), text: plain(text) })
    if (this.chatLines.length > CHAT_LOG_SIZE) this.chatLines.shift()
    this.chatLogRevision++
    // The next tick publishes, so a burst of lines costs one broadcast.
    this.publishAt = 0
  }

  /** The chat origin of the running navigation, or null when none runs or it came from the web UI. */
  get navigationOrigin () { return this.runActive ? this.runOrigin : null }

  private settleNavigation () {
    if (!this.runActive || ['planning', 'moving'].includes(this.state.navigation.status)) return
    this.runActive = false
    this.endRun(this.runOrigin, this.state.navigation.status, this.state.navigation.message)
  }

  // The farmer's own runs go back to the farmer; all others to onNavigationEnd.
  private endRun (origin: NavigationOrigin | null, status: string, message: string | null) {
    if (origin?.collect !== undefined) this.collector.navigationEnded(origin.collect, status)
    else if (origin?.farm !== undefined) this.farm.navigationEnded(origin.farm, status)
    else this.onNavigationEnd(origin, status, message)
  }

  private failed (message: string) {
    this.closeClient()
    this.state.lastError = message
    this.attempts++
    if (!this.wanted || this.attempts >= 5) {
      this.wanted = false
      this.state.status = 'error'
    } else {
      this.state.status = 'reconnecting'
      this.retryAt = this.now() + Math.min(1000 * 2 ** (this.attempts - 1), 30000)
    }
    this.publish()
  }

  private halt (message: string, status: 'dead' | 'error') {
    this.wanted = false
    this.closeClient()
    this.state.status = status
    this.state.lastError = message
    this.publish()
  }

  private closeClient () {
    this.sleep.reset(); this.suspendedRun = null; this.conditions.reset()
    this.farm.suspendForSleep(false); this.collector.suspendForSleep(false)
    for (const job of this.deferredChest.splice(0)) job.reject(new Error('Verbindung getrennt.'))
    this.previewJob?.cancel()
    if (this.state.status === 'spawned') this.logChat('event', '', 'Verbindung getrennt')
    const old = this.client
    this.client = null
    for (const job of this.drops.splice(0)) job.reject(new Error('Verbindung getrennt.'))
    this.chestJob?.reject(new Error('Verbindung getrennt.'))
    this.chestJob = null
    this.farm.disconnected()
    this.collector.disconnected()
    this.navigator.reset()
    this.settleNavigation()
    this.state.resetWorld()
    old?.close()
  }

  stop () {
    this.stopped = true
    this.wanted = false
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.commands = []
    this.closeClient()
    this.state.status = 'disconnected'
  }

  environment () {
    const now = this.now(); const sky = this.conditions.skyLight(now)
    return { ...this.conditions.snapshot(now), light: this.state.status === 'spawned' && this.state.position && sky !== null ? this.state.estimatedLight(this.state.position, sky) : null }
  }
}
