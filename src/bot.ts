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
export type Command = 'connect' | 'disconnect' | 'stop_navigation' | { type: 'navigate'; x: number; z: number }
export type ClientFactory = (config: Config) => BotClient

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

  constructor (
    private config: Config,
    private createClient: ClientFactory,
    private publish: () => void = () => {},
    private now: () => number = Date.now
  ) { this.state = new WorldState(config.radius, config.version); this.navigator = new Navigator(this.state) }

  enqueue (command: Command) {
    if (this.stopped) return false
    if (typeof command === 'object' && (!command || command.type !== 'navigate' || ![command.x, command.z].every(n => Number.isInteger(n) && Math.abs(n) <= 30000000))) return false
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
        this.navigator.start(command, this.now())
      } else if (command === 'stop_navigation') {
        this.navigator.stop()
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
      try { this.state.requestSubchunks(send, this.now()); this.navigator.step(send, this.now()) }
      catch (error) { this.failed(error instanceof Error ? error.message : String(error)) }
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
      client.on('start_game', (packet: { player_position: Position; dimension: number | string; block_network_ids_are_hashes?: boolean; current_tick?: bigint }) => {
        if (!active()) return
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
        if (active() && String(packet.runtime_id) === String(client.entityId)) {
          this.updatePosition(packet.position)
          if (packet.mode === 'teleport' || packet.mode === 'reset' || packet.mode === 1 || packet.mode === 2) this.navigator.acknowledgeTeleport()
        }
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

  private updatePosition (position: Position) {
    if (position && [position.x, position.y, position.z].every(Number.isFinite)) {
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
    const old = this.client
    this.client = null
    this.navigator.reset()
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
