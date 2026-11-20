import { EventEmitter } from 'node:events'
import type { Config } from './config.js'
import { WorldState, type Position } from './state.js'
import { Navigator } from './navigation.js'
import { RoutePlanner, type PreviewRoute, type Target } from './pathfinder.js'
import { WorldError } from './world.js'

export interface BotClient extends EventEmitter {
  queue(name: string, params: unknown): void
  close(): void
  viewDistance?: number
  entityId?: unknown
}
/** Who asked for a navigation via chat; navigations from the web UI have none. */
export type NavigationOrigin = { player: string; label: string; give?: number }
export type Command = 'connect' | 'disconnect' | 'stop_navigation' | { type: 'navigate'; x: number; z: number; origin?: NavigationOrigin }
export type NavigationEnd = (origin: NavigationOrigin | null, status: string, message: string | null) => void
export type ClientFactory = (config: Config) => BotClient
/** One line of the web UI's chat log; `event` lines mark connects and disconnects. */
export type ChatLine = { at: number; kind: 'chat' | 'whisper' | 'bot' | 'event'; name: string; text: string }
const CHAT_LOG_SIZE = 100
const isPosition = (position: Position | undefined): position is Position =>
  Boolean(position) && [position!.x, position!.y, position!.z].every(Number.isFinite)
const isInventoryWindow = (id: string | number | undefined) => id === 'inventory' || id === 0
type DropJob = { name: string; count: number; toward: Position; resolve: (dropped: number) => void; reject: (error: Error) => void }

export class BotController {
  readonly state: WorldState
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
  /** Called for every chat or whisper line from another player. */
  onChat: (sender: string, message: string) => void = () => {}
  /** Called once when a navigation run ends: arrived, failed, stopped, replaced or lost with the connection. */
  onNavigationEnd: NavigationEnd = () => {}

  constructor (
    private config: Config,
    private createClient: ClientFactory,
    private publish: () => void = () => {},
    private now: () => number = Date.now
  ) {
    this.state = new WorldState(config.radius, config.version); this.state.openDoors = config.openDoors !== false
    this.navigator = new Navigator(this.state)
  }

  enqueue (command: Command) {
    if (this.stopped) return false
    if (typeof command === 'object' && (!command || command.type !== 'navigate' || ![command.x, command.z].every(n => Number.isInteger(n) && Math.abs(n) <= 30000000) ||
      (command.origin !== undefined && (typeof command.origin?.player !== 'string' || typeof command.origin.label !== 'string')))) return false
    if (command === 'stop_navigation') {
      this.commands = this.commands.filter(command => typeof command === 'string' && command !== 'stop_navigation')
      this.commands.unshift(command)
      return true
    }
    if (this.commands.length >= 32) return false
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
        this.previewJob?.cancel()
        // A new target replaces the running one; report that run as stopped first.
        if (this.runActive) { this.runActive = false; this.onNavigationEnd(this.runOrigin, 'stopped', 'Neues Ziel gesetzt.') }
        this.navigator.start({ x: command.x, z: command.z }, this.now())
        this.runActive = true; this.runOrigin = command.origin ? { ...command.origin } : null
        this.settleNavigation()
      } else if (command === 'stop_navigation') {
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
        this.state.requestSubchunks(send, this.now()); this.navigator.step(send, this.now())
        // The bot turns towards the receiver first; the server throws dropped items in the facing direction.
        for (const job of this.drops.splice(0)) {
          this.navigator.face(send, job.toward)
          this.state.inventory.drop(send, job.name, job.count, this.now()).then(job.resolve, job.reject)
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
      client.on('start_game', (packet: { entity_id?: bigint | string; player_position: Position; dimension: number | string; block_network_ids_are_hashes?: boolean; current_tick?: bigint }) => {
        if (!active()) return
        if (packet.entity_id !== undefined) selfUniqueId = String(packet.entity_id)
        if (typeof packet.block_network_ids_are_hashes === 'boolean') this.state.beginWorld(packet.dimension, packet.block_network_ids_are_hashes)
        if (typeof packet.current_tick === 'bigint') this.navigator.synchroniseTick(packet.current_tick)
        this.updatePosition(packet.player_position)
        this.state.dimension = packet.dimension
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
      client.on('move_player', (packet: { runtime_id: bigint | string; position: Position; mode?: string | number }) => {
        if (!active()) return
        if (String(packet.runtime_id) === String(client.entityId)) {
          this.updatePosition(packet.position)
          if (packet.mode === 'teleport' || packet.mode === 'reset' || packet.mode === 1 || packet.mode === 2) this.navigator.acknowledgeTeleport()
        } else this.movePlayer(packet.runtime_id, packet.position)
      })
      client.on('add_player', (packet: { runtime_id: bigint | string; unique_id?: bigint | string; uuid?: string; username: string; position: Position }) => {
        const id = String(packet.runtime_id)
        if (active() && id !== String(client.entityId) && isPosition(packet.position)) {
          this.state.players.set(id, { name: String(packet.username ?? ''), position: { ...packet.position }, uniqueId: String(packet.unique_id ?? id), uuid: String(packet.uuid ?? '') })
        }
      })
      // Delta packets carry only the changed absolute coordinates.
      client.on('move_entity_delta', (packet: { runtime_entity_id: bigint | string; x?: number; y?: number; z?: number }) => {
        const player = active() ? this.state.players.get(String(packet.runtime_entity_id)) : undefined
        if (!player) return
        this.movePlayer(packet.runtime_entity_id, {
          x: Number.isFinite(packet.x) ? packet.x! : player.position.x,
          y: Number.isFinite(packet.y) ? packet.y! : player.position.y,
          z: Number.isFinite(packet.z) ? packet.z! : player.position.z
        })
      })
      // remove_entity carries the unique entity ID, which differs from the runtime ID on BDS.
      client.on('remove_entity', (packet: { entity_id_self: bigint | string }) => {
        if (!active()) return
        const uniqueId = String(packet.entity_id_self)
        for (const [id, player] of this.state.players) if (player.uniqueId === uniqueId) this.state.players.delete(id)
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
            this.state.roster.delete(uuid)
            for (const [id, player] of this.state.players) if (player.uuid === uuid) this.state.players.delete(id)
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
  private movePlayer (runtimeId: bigint | string, position: Position) {
    const player = this.state.players.get(String(runtimeId))
    if (player && isPosition(position)) player.position = { x: position.x, y: position.y, z: position.z }
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
    this.onNavigationEnd(this.runOrigin, this.state.navigation.status, this.state.navigation.message)
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
    this.previewJob?.cancel()
    if (this.state.status === 'spawned') this.logChat('event', '', 'Verbindung getrennt')
    const old = this.client
    this.client = null
    for (const job of this.drops.splice(0)) job.reject(new Error('Verbindung getrennt.'))
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
}
