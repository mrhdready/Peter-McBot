import { setImmediate as yieldLoop } from 'node:timers/promises'
import type { Navigator } from './navigation.js'
import { RoutePlanner, type Target } from './pathfinder.js'
import type { Position, WorldState } from './state.js'
import type { WorldConditions } from './world-conditions.js'
import { SleepSettings } from './sleep-settings.js'
import { EMPTY_ITEM, playerContainer } from './inventory.js'

type Send = (name: string, params: unknown) => void
type Host = {
  readonly state: WorldState; readonly navigator: Navigator; readonly conditions: WorldConditions
  now(): number; send: Send; entityId(): unknown
  pause(): void; resume(discard: boolean): void; busy(): boolean
}
type Phase = 'idle' | 'preparing' | 'searching' | 'moving' | 'opening' | 'freeing' | 'closing' | 'clicking' | 'sleeping' | 'waking'

/** One owner of navigation and inventory during sleep; all progress is driven by the bot heartbeat. */
export class AutoSleeper {
  private settings = new SleepSettings()
  private phase: Phase = 'idle'
  private blocked = false
  private retryAt = 0
  private deadline = 0
  private leaseUntil = 0
  private remoteLease = false
  private generation = 0
  private session = 0
  private abort: AbortController | null = null
  private bed: Position | null = null
  private inventoryWindow: { window_id: string | number; window_type: string | number } | null = null
  private phaseAt = 0
  private clickedAt = 0
  private freeingStarted = false
  private awaitingOpen = false
  private wakeRevision = 0
  private discard = false
  private message = 'Automatisches Schlafen ist aus.'
  private Block: any

  constructor (private host: Host) {}
  get active () { return this.phase !== 'idle' }
  get preparing () { return this.phase === 'preparing' }
  loadSettings (file: string) {
    this.settings = new SleepSettings(file)
    this.message = this.settings.value.enabled ? 'Wartet auf einen Schlafanlass.' : 'Automatisches Schlafen ist aus.'
  }
  status () { return { ...this.settings.value, phase: this.phase, blocked: this.blocked, retryAt: this.retryAt || null, bed: this.bed && { ...this.bed }, message: this.message } }

  configure (input: unknown) {
    const previous = this.settings.value
    this.settings.update(input)
    if (this.settings.value.enabled && !previous.enabled) { this.blocked = false; this.retryAt = 0 }
    if (!this.settings.value.enabled && this.active) this.cancel(false, 'Schlafautomatik ausgeschaltet.')
    if (!this.active) this.message = this.settings.value.enabled ? 'Wartet auf einen Schlafanlass.' : 'Automatisches Schlafen ist aus.'
  }

  manualWork () { this.blocked = false }
  stop () { this.blocked = true; this.host.conditions.clearRequests(); this.cancel(true, 'Schlafautomatik durch Stopp gesperrt.') }
  reset () {
    this.generation++; this.abort?.abort(); this.abort = null
    this.phase = 'idle'; this.bed = null; this.inventoryWindow = null; this.retryAt = 0; this.discard = false
    this.awaitingOpen = false
    this.message = this.blocked ? 'Schlafautomatik durch Stopp gesperrt.' : this.settings.value.enabled ? 'Wartet auf Verbindung.' : 'Automatisches Schlafen ist aus.'
  }

  private allowed () {
    return [0, 'overworld'].includes(this.host.state.dimension!) && this.host.conditions.sleepAllowed(this.host.now())
  }
  private requested () { return !this.settings.value.onlyWithPlayers || this.host.conditions.hasPartner(this.host.now()) }
  private live (generation: number) { return generation === this.generation && this.session === this.host.state.worldSession && this.active && !this.abort?.signal.aborted }
  private finish (message: string, failed: boolean) {
    this.generation++; this.abort?.abort(); this.abort = null
    if (this.inventoryWindow) this.host.send('container_close', { ...this.inventoryWindow, server: false })
    this.inventoryWindow = null; this.phase = 'idle'; this.message = message; this.bed = null
    this.retryAt = this.host.now() + 60000
    if (failed) this.host.conditions.clearRequests()
    this.host.navigator.stop()
    this.host.resume(this.discard)
    this.discard = false
  }
  private cancel (discard: boolean, message: string) {
    this.discard ||= discard
    this.message = message
    if (!this.active) return
    this.generation++; this.abort?.abort()
    if (this.host.conditions.selfSleeping === true || this.phase === 'sleeping' || this.phase === 'waking' || (this.phase === 'clicking' && this.clickedAt !== 0)) {
      this.phase = 'waking'; this.phaseAt = this.host.now()
      this.wakeRevision = this.host.conditions.selfRevision
      const p = this.bed ?? this.host.state.position ?? { x: 0, y: 0, z: 0 }
      const position = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }
      this.host.send('player_action', { runtime_entity_id: this.host.entityId(), action: 'stop_sleeping', position, result_position: position, face: 1 })
    } else this.finish(message, false)
  }

  opened (packet: { window_id: string | number; window_type: string | number }) {
    if (!['inventory', -1].includes(packet.window_type as string)) return
    if (!this.awaitingOpen) return
    this.awaitingOpen = false
    if (this.phase !== 'opening') { this.host.send('container_close', { window_id: packet.window_id, window_type: packet.window_type, server: false }); return }
    this.inventoryWindow = { window_id: packet.window_id, window_type: packet.window_type }
    this.phase = 'freeing'; this.phaseAt = this.host.now()
    this.freeingStarted = false
  }
  closed (id: string | number) {
    if (!this.inventoryWindow || this.inventoryWindow.window_id !== id) return
    this.inventoryWindow = null
    if (this.phase === 'closing') { this.phase = 'clicking'; this.clickedAt = 0 }
    else if (this.active) this.finish('Inventar wurde unerwartet geschlossen.', true)
  }

  private bedState (p: Position) {
    const state = this.host.state.stateIdAt(p)
    if (state === null || this.host.state.blockNameAt(p.x, p.y, p.z) !== 'minecraft:bed') return null
    this.Block ??= require('prismarine-block')('bedrock_' + this.host.state.blockVersion)
    return this.Block.fromStateId(state, 0).getProperties() as { occupied_bit: number; head_piece_bit: number }
  }
  private distance (eye: Position, bed: Position) { return Math.hypot(eye.x - bed.x - .5, eye.y - bed.y - .5625, eye.z - bed.z - .5) }

  private async findBed (generation: number) {
    try {
      const state = this.host.state; const origin = { ...state.position! }
      const result = await state.searchBlocks('bed', 100, origin, this.abort!.signal)
      const beds = result.hits.filter(p => p.distance <= 32 && this.bedState(p)?.head_piece_bit === 1 && this.bedState(p)?.occupied_bit === 0)
      for (const bed of beds) {
        if (!this.live(generation)) return
        if (this.distance(origin, bed) <= 4.5 && state.canSeeBlock(origin, bed)) {
          this.bed = bed; this.phase = 'clicking'; this.clickedAt = 0; return
        }
        const spots: Array<Target & { y: number; distance: number }> = []
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          for (const y of [bed.y, bed.y - 1, bed.y + 1]) {
            const eye = { x: bed.x + dx + .5, y: y + 1.62, z: bed.z + dz + .5 }
            if (state.canStandAt(eye.x, eye.z, y) && state.canSeeBlock(eye, bed)) spots.push({ x: bed.x + dx, z: bed.z + dz, y, exactY: true, distance: Math.hypot(eye.x - origin.x, eye.z - origin.z) })
          }
        }
        spots.sort((a, b) => a.distance - b.distance)
        for (const spot of spots) {
          try {
            const planner = new RoutePlanner(state, origin, spot)
            while (this.live(generation) && this.host.now() < this.deadline) {
              const path = planner.step()
              if (path) {
                if (!this.live(generation)) return
                this.bed = bed; this.phase = 'moving'; this.message = 'Läuft zum Bett.'
                this.host.navigator.start(spot, this.host.now()); return
              }
              await yieldLoop()
            }
          } catch { /* Try the next known safe stand or bed. */ }
        }
      }
      if (this.live(generation)) this.finish('Kein freies, erreichbares Bett im Umkreis von 32 Blöcken.', true)
    } catch (error) {
      if (this.live(generation)) this.finish('Bettsuche fehlgeschlagen: ' + (error instanceof Error ? error.message : String(error)), true)
    }
  }

  private async freeHand () {
    const generation = this.generation
    const inventory = this.host.state.inventory
    const slots = inventory.slotList()
    const from = slots.slice(0, 9).findIndex(slot => slot !== null)
    const to = slots.findIndex((slot, index) => index >= 9 && slot === null)
    try {
      if (slots.slice(0, 9).every(Boolean)) {
        if (to < 0) { this.finish('Inventar voll: kein Platz für eine freie Hand.', true); return }
        const item = slots[from]!
        const response = await inventory.place(this.host.send, { name: item.name, count: item.count,
          from: { container: playerContainer(from), slot: from, stackId: item.stackId },
          to: { container: playerContainer(to), slot: to, stackId: 0 } }, this.host.now())
        if (!this.live(generation)) return
        if ((response.status !== 'ok' && response.status !== 0) || inventory.slotList()[from] !== null) {
          this.finish(`Umlagern für den Bettklick abgelehnt (Status ${response.status}).`, true); return
        }
      }
      if (!this.live(generation) || !this.inventoryWindow) return
      this.phase = 'closing'; this.phaseAt = this.host.now()
      this.host.send('container_close', { ...this.inventoryWindow, server: false })
    } catch (error) {
      if (this.live(generation)) this.finish('Umlagern fehlgeschlagen: ' + (error instanceof Error ? error.message : String(error)), true)
    }
  }

  step () {
    const now = this.host.now(); const state = this.host.state; const p = state.position
    if (state.status !== 'spawned' || !p) return
    if (this.active && this.session !== state.worldSession) {
      this.discard = true; this.finish('Welt geändert; alter Bettanlauf verworfen.', true); return
    }
    if (this.phase === 'idle') {
      if (!this.settings.value.enabled || this.blocked || now < this.retryAt || !this.allowed() || !this.requested()) return
      this.abort = new AbortController(); this.generation++; this.deadline = now + 60000
      this.session = state.worldSession
      this.leaseUntil = this.deadline; this.remoteLease = this.settings.value.onlyWithPlayers
      this.phase = 'preparing'; this.message = 'Pausiert Aufgaben für den Bettanlauf.'
      this.host.pause()
    }
    if (this.phase === 'waking') {
      if (this.host.conditions.selfSleeping === false && (this.host.conditions.selfRevision > this.wakeRevision || now - this.phaseAt >= 3000)) this.finish(this.message, false)
      else if (now - this.phaseAt > 5000) this.message = 'Wartet auf serverseitige Bestätigung des Aufwachens.'
      return
    }
    if (this.host.conditions.selfSleeping === true) {
      this.phase = 'sleeping'; this.message = 'Schläft; wartet auf den Server.'; return
    }
    if (this.phase === 'sleeping') {
      if (this.host.conditions.selfSleeping === false) this.finish('Aufgewacht; Aufgaben werden fortgesetzt.', false)
      return
    }
    if (!this.allowed() || (this.settings.value.onlyWithPlayers && (!this.requested() || (this.remoteLease && now >= this.leaseUntil)))) {
      this.cancel(false, 'Schlafanlass entfallen; Aufgaben werden fortgesetzt.'); return
    }
    if (now >= this.deadline) { this.finish('Bettanlauf nach 60 Sekunden abgebrochen.', true); return }
    if (this.phase === 'preparing') {
      this.host.navigator.step(this.host.send, now)
      if (this.host.navigator.settlingMotion || this.host.busy() || !state.inventory.known || !state.blockIds().length) return
      this.phase = 'searching'; this.message = 'Sucht ein bekanntes Bett.'
      void this.findBed(this.generation)
    } else if (this.phase === 'moving') {
      this.host.navigator.step(this.host.send, now)
      if (state.navigation.status === 'arrived') { this.phase = 'clicking'; this.clickedAt = 0 }
      else if (!['moving', 'planning'].includes(state.navigation.status)) this.finish('Bett nicht erreichbar: ' + (state.navigation.message ?? ''), true)
    } else if (this.bed && ['opening', 'freeing', 'closing'].includes(this.phase)) {
      this.host.navigator.lookAt(this.host.send, { x: this.bed.x + .5, y: this.bed.y + .5625, z: this.bed.z + .5 })
      // The server refreshes inventory stack IDs immediately after opening the window.
      if (this.phase === 'freeing' && !this.freeingStarted && now - this.phaseAt >= 100) {
        this.freeingStarted = true; void this.freeHand()
      }
      if (now - this.phaseAt > 3000) this.finish('Inventaraktion für den Bettklick nicht bestätigt.', true)
    } else if (this.phase === 'clicking' && this.bed) {
      if (this.clickedAt) {
        if (now - this.clickedAt > 3000) this.finish('Der Server hat Schlafen nicht bestätigt (Bett belegt, blockiert oder Schlafen nicht erlaubt).', true)
        else this.host.navigator.lookAt(this.host.send, { x: this.bed.x + .5, y: this.bed.y + .5625, z: this.bed.z + .5 })
        return
      }
      if (this.bedState(this.bed)?.occupied_bit !== 0 || this.distance(p, this.bed) > 4.5 || !state.canSeeBlock(p, this.bed)) {
        this.finish('Bett ist belegt oder nicht mehr in Klickreichweite.', true); return
      }
      const slot = state.inventory.slotList().slice(0, 9).findIndex(item => item === null)
      if (slot < 0) {
        this.phase = 'opening'; this.phaseAt = now
        this.awaitingOpen = true
        this.host.send('interact', { action_id: 'open_inventory', target_entity_id: this.host.entityId(), has_position: false })
        return
      }
      const runtime = state.blockRuntimeIdAt(this.bed.x, this.bed.y, this.bed.z)
      if (runtime === null) { this.finish('Bettzustand ist unbekannt.', true); return }
      this.host.send('mob_equipment', { runtime_entity_id: this.host.entityId(), item: EMPTY_ITEM, slot, selected_slot: slot, window_id: 'inventory' })
      this.host.navigator.clickBlock(this.host.send, this.bed, runtime, EMPTY_ITEM, { face: 1, clickPos: { x: .5, y: .5625, z: .5 }, hotbarSlot: slot })
      this.host.navigator.lookAt(this.host.send, { x: this.bed.x + .5, y: this.bed.y + .5625, z: this.bed.z + .5 })
      this.clickedAt = now; this.message = 'Wartet auf die Schlafbestätigung.'
    }
  }
}
