/*
 * Farming mode: harvests ripe wheat, carrots, potatoes and beetroot (growth 7) around an anchor, collects the drops,
 * replants the harvested spots with the same crop and stores the surplus in the nearest chest.
 *
 * The round is an async loop that only the bot's 20-Hz tick advances: every wait is a promise that `step()`
 * resolves, so there are no timers of its own and tests can drive it with a controlled clock. A new token
 * per run cancels the running wait (off, pause, disconnect); the loop then ends quietly.
 *
 * Protocol recipe, verified live with scripts/smoke-farm.cjs (BDS 1.26.65, server-authoritative breaking):
 * - break: input tick with flag `block_action` and [start_break, predict_break], next tick [stop_break];
 * - pick up: walk onto the drop's column;
 * - plant: one input tick with [abort_break] first (else the server destroys the new crop at once), then
 *   mob_equipment with the seed's hotbar slot and a click_block on the farmland's top face.
 */
import type { ChestPlanner, ChestResult, Command } from './bot.js'
import type { Position, WorldState } from './state.js'
import type { Navigator } from './navigation.js'
import { FARM_CROPS, WorldError, type CropKind } from './world.js'
import { isDeepStrictEqual } from 'node:util'
import { CHEST_CONTAINER, nextTransfer, playerContainer, shortName, stackSize, type Move, type Inventory, type Slot, type StackResponse, type TransferStep } from './inventory.js'
import { CHEST_IDS, chestStandSpot } from './chat-commands.js'

import { FarmSettings, CROP_GROUP } from './farm-settings.js'
import { EYE_HEIGHT } from './pathfinder.js'

import { dropColumn, nearestDrop, PICKUP_MS } from './item-collection.js'

type Send = (name: string, params: unknown) => void
type Spot = Position & { kind: CropKind; direction?: number }
type Stand = { x: number; z: number; feetY: number }

/** Crop → the item that plants it. */
export const CROPS: Partial<Record<CropKind, string>> = { wheat: 'wheat_seeds', carrots: 'carrot', potatoes: 'potato', beetroot: 'beetroot_seeds', cocoa: 'cocoa_beans' }
/** Seeds and fruits the bot keeps for replanting; everything above goes into a chest. */
export const RESERVE: Record<string, number> = { wheat_seeds: 64, carrot: 16, potato: 16, beetroot_seeds: 64, cocoa_beans: 64 }
/** Harvest items that are stored: wheat, beetroot and poisonous potatoes always, the others above their reserve. */
export const DEPOSIT = ['wheat', 'poisonous_potato', 'wheat_seeds', 'carrot', 'potato', 'beetroot', 'beetroot_seeds', 'sugar_cane', 'melon_slice', 'melon_block', 'pumpkin', 'cocoa_beans', 'sweet_berries']
const CROP_LABELS: Record<CropKind, string> = { wheat: 'Weizen', carrots: 'Karotten', potatoes: 'Kartoffeln', beetroot: 'Rote Bete', melon_block: 'Melonen', pumpkin: 'Kürbisse', reeds: 'Zuckerrohr', cocoa: 'Kakao', sweet_berry_bush: 'Süßbeeren' }
export const FARM_RADIUS = 24
const SCAN_MS = 30000
export const PAUSE_MS = 60000
// Interaction reach from the eyes to a crop or chest centre, with some margin below the vanilla 6 blocks.
const REACH = 4.5
const PICKUP_WALKS = 4
const BREAK_MS = 1500
const PLANT_MS = 2000
// A new crop must still stand this long after it appeared (the server may destroy it in the same tick).
const PLANT_CONFIRM_MS = 500
// Surplus above this many items is stored after a round even while slots are free.
const DEPOSIT_THRESHOLD = 64
const MAX_CHESTS = 3
const log = (message: string) => console.log('[farm] ' + message)
const fixed = (n: number) => Math.round(n * 10) / 10

class Cancelled extends Error {}

/** What the farmer needs from the bot; `BotController` supplies it. */
export interface FarmHost {
  readonly state: WorldState
  /** Loaded radius in blocks. */
  readonly reach: number
  readonly navigator: Pick<Navigator, 'lookAt' | 'clickBlock'>
  activate? (): void
  now (): number
  enqueue (command: Command): boolean
  entityId (): unknown
  useChest (chest: Position, next: ChestPlanner): Promise<ChestResult>
  cancelChest (): void
  /** Stops the running navigation if the farmer started it, without switching farming off. */
  stopNavigation (): void
  /** Publishes a snapshot soon. */
  publish (): void
}

export type FarmAnchor = { x: number; z: number; y?: number; label: string }
export type FarmStatus = {
  enabled: boolean; once: boolean; anchor: FarmAnchor | null; radius: number; activity: string
  pausedUntil: number | null; lastSummary: string | null; groups: import('./farm-settings.js').FarmGroups
}
type Wait = { done: () => boolean; until: number; each?: (send: Send) => void; resolve: (ok: boolean) => void; reject: (error: Error) => void }
type Tally = { harvested: Record<CropKind, number>; planted: number; unplanted: number }

export class Farmer {
  private sleepPausedAt: number | null = null
  private pendingReplants = new Map<string, Spot>()

  suspendForSleep (pause: boolean) {
    if (pause && this.sleepPausedAt === null) {
      this.sleepPausedAt = this.host.now()
      for (const spot of this.pendingReplants.values()) {
        if (!this.unplanted.some(p => p.x === spot.x && p.y === spot.y && p.z === spot.z)) this.unplanted.push({ ...spot })
      }
      this.cancel()
    } else if (!pause && this.sleepPausedAt !== null) {
      this.sleepPausedAt = null; this.nextScanAt = 0; this.equipped = null
    }
  }

  get inventoryBusy () { return this.inventoryOpening || this.inventoryWindow !== null }
  /** Chat output: on/off, problems and one summary per round. Without chat commands it only goes to the log. */
  onReport: (text: string) => void = () => {}
  private enabled = false
  private once = false
  private anchor: FarmAnchor | null = null
  private token = 0
  private running = false
  private wait: Wait | null = null
  private pausedUntil = 0
  private nextScanAt = 0
  private activity = 'Aus'
  private lastSummary: string | null = null
  private haltNavigation = false
  private navToken = 0
  private navEnd: string | null = null
  private inventoryWindow: { windowId: string | number; windowType: unknown } | null = null
  private inventoryOpening = false
  private inventoryClosing = false
  private inventoryFailure: string | null = null
  private chestOpen = false
  // Spots harvested by the bot that still wait for a seed; memory only.
  private unplanted: Spot[] = []
  // Problems already reported since the last start, so each one is said once.
  private reported = new Set<string>()
  private equipped: { slot: number; stackId: number } | null = null

  private settings = new FarmSettings()
  private returnBlocked = false

  constructor (private host: FarmHost) {}

  loadSettings (file: string) { this.settings = new FarmSettings(file) }

  configure (groups: unknown) {
    this.settings.update(groups)
    this.host.publish()
  }

  private selected (kind: CropKind) { return this.settings.groups[CROP_GROUP[kind]] }


  get radius () { return Math.max(0, Math.min(FARM_RADIUS, this.host.reach - 16)) }

  /** Switches farming on around `anchor`; returns an error message or null. */
  start (anchor: FarmAnchor, once = false): string | null {
    const p = this.host.state.position
    if (this.host.state.status !== 'spawned' || !p) return 'Ich bin gerade nicht verbunden.'
    if (this.radius < 1) return 'Der geladene Bereich ist zu klein zum Farmen.'
    const distance = Math.round(Math.hypot(anchor.x - p.x, anchor.z - p.z))
    if (distance > this.host.reach) return `${anchor.label} ist zu weit weg (${distance} Blöcke).`
    this.cancel()
    this.host.activate?.()
    this.enabled = true; this.once = once; this.anchor = { ...anchor, ...(anchor.y === undefined && Math.floor(anchor.x) === Math.floor(p.x) && Math.floor(anchor.z) === Math.floor(p.z) ? { y: p.y - EYE_HEIGHT } : {}) }
    this.returnBlocked = false
    this.pausedUntil = 0; this.nextScanAt = 0; this.lastSummary = null
    this.unplanted = []; this.reported.clear()
    this.setActivity('Startet')
    log(`An${once ? ' (ein Durchgang)' : ''}: Anker ${anchor.label} (${fixed(anchor.x)}, ${fixed(anchor.z)}), Radius ${this.radius}.`)
    this.onReport(`Farming ${once ? 'einmal' : 'an'}: ${anchor.label}, Radius ${this.radius}.`)
    return null
  }

  /** Switches farming off; returns false when it was already off. */
  off (reason: string | null = null) {
    if (!this.enabled) return false
    this.enabled = false
    this.cancel()
    this.unplanted = []
    this.setActivity('Aus')
    log('Aus' + (reason ? ': ' + reason : '') + '.')
    this.onReport('Farming aus' + (reason ? ` (${reason})` : '') + '.')
    return true
  }

  /** A chat command interrupts farming; it resumes PAUSE_MS after the last one. */
  pause () {
    if (!this.enabled) return
    if (this.host.now() >= this.pausedUntil) log(`Pause für Chat-Befehl; weiter in ${PAUSE_MS / 1000} s.`)
    this.pausedUntil = this.host.now() + PAUSE_MS
    this.nextScanAt = 0
    this.cancel()
    this.host.publish()
  }

  /** The connection is gone: the running action ends, farming stays on and continues after the next spawn. */
  disconnected () {
    this.cancel()
    this.inventoryWindow = null
    this.inventoryOpening = false
    this.inventoryClosing = false
    this.nextScanAt = 0
    this.equipped = null
  }

  /** Called by the bot when a navigation the farmer started has ended. */
  navigationEnded (token: number, status: string) {
    if (token === this.navToken) this.navEnd = status
  }

  inventoryOpened (windowId: string | number, windowType: unknown) {
    if (!this.inventoryOpening || (windowType !== 'inventory' && windowType !== -1)) return
    this.inventoryWindow = { windowId, windowType }
    this.inventoryOpening = false
    if (this.sleepPausedAt !== null) this.inventoryClosing = true
  }

  inventoryClosed (windowId: string | number) {
    if (this.inventoryWindow?.windowId === windowId) this.inventoryWindow = null
  }

  acceptsNavigation (token: number) { return this.enabled && this.running && this.navToken === token }

  status (): FarmStatus {
    const now = this.host.now()
    const paused = this.enabled && now < this.pausedUntil
    let activity = this.activity
    if (!this.enabled) activity = 'Aus'
    else if (this.sleepPausedAt !== null) activity = 'Pausiert (Schlafen)'
    else if (paused) activity = 'Pausiert (Chat-Befehl)'
    else if (this.host.state.status !== 'spawned') activity = 'Wartet auf Verbindung'
    return { enabled: this.enabled, once: this.once, anchor: this.anchor && { ...this.anchor }, radius: this.radius, activity,
      pausedUntil: paused ? this.pausedUntil : null, lastSummary: this.lastSummary, groups: { ...this.settings.groups } }
  }

  /** One tick while the bot is spawned: starts a round when due and advances the running wait. */
  step (send: Send) {
    if (this.inventoryClosing && this.inventoryWindow) {
      const { windowId, windowType } = this.inventoryWindow
      this.inventoryWindow = null
      this.inventoryClosing = false
      send('container_close', { window_id: windowId, window_type: windowType, server: false })
    }
    if (this.sleepPausedAt !== null) return
    if (this.haltNavigation) { this.haltNavigation = false; this.host.stopNavigation() }
    if (!this.enabled) return
    const now = this.host.now()
    if (!this.running) {
      if (now < this.pausedUntil || now < this.nextScanAt || !this.host.state.inventory.known || !this.host.state.position) return
      this.running = true
      const token = this.token
      this.round().catch((error: unknown) => {
        if (error instanceof Cancelled || this.token !== token) return
        const message = error instanceof Error ? error.message : String(error)
        log('Fehler: ' + message)
        this.problem('error:' + message, 'Farming-Fehler: ' + message)
      }).finally(() => {
        if (this.token !== token) return
        this.pendingReplants.clear()
        this.running = false
        this.nextScanAt = this.host.now() + SCAN_MS
        if (this.once && this.enabled && !this.returnBlocked) this.off('ein Durchgang erledigt')
        else if (this.enabled) this.setActivity(this.returnBlocked ? 'Anker nicht erreichbar; wartet' : 'Wartet auf reife Pflanzen')
      })
    }
    const wait = this.wait
    if (!wait) return
    if (wait.done()) { this.wait = null; wait.resolve(true) }
    else if (now >= wait.until) { this.wait = null; wait.resolve(false) }
    else wait.each?.(send)
  }

  private cancel () {
    this.pendingReplants.clear()
    this.inventoryClosing = true
    this.token++
    this.running = false
    this.haltNavigation = true
    if (this.chestOpen) { this.chestOpen = false; this.host.cancelChest() }
    const wait = this.wait
    this.wait = null
    wait?.reject(new Cancelled())
  }

  private setActivity (text: string) {
    if (this.activity === text) return
    this.activity = text
    this.host.publish()
  }

  private problem (key: string, text: string) {
    if (this.reported.has(key)) return
    this.reported.add(key)
    log(text)
    this.onReport(text)
  }

  // ---- waits, all resolved by step() ----

  /** Resolves true once `done` holds, false after `ms`; `each` runs on every tick in between. */
  private ticks (ms: number, done: () => boolean = () => false, each?: (send: Send) => void): Promise<boolean> {
    return new Promise((resolve, reject) => { this.wait = { done, until: this.host.now() + ms, each, resolve, reject } })
  }

  /** Runs `action` on the next tick and resolves on the tick after it. */
  private act (action: (send: Send) => void) {
    let sent = false
    return this.ticks(Infinity, () => sent, send => { action(send); sent = true })
  }

  /** Awaits a promise from outside (search, chest) so that a cancel still ends the loop at once. */
  private async external<T> (promise: Promise<T>): Promise<T> {
    const box: { settled: boolean; value?: T; error?: unknown; failed?: boolean } = { settled: false }
    promise.then(value => { box.settled = true; box.value = value }, error => { box.settled = true; box.failed = true; box.error = error })
    await this.ticks(Infinity, () => box.settled)
    if (box.failed) throw box.error
    return box.value as T
  }

  private async walk (x: number, z: number, label: string, y?: number): Promise<string> {
    const token = ++this.navToken
    this.navEnd = null
    if (!this.host.enqueue({ type: 'navigate', x, z, ...(y === undefined ? {} : { y }), origin: { player: '', label, farm: token } })) return 'busy'
    await this.ticks(130000, () => this.navEnd !== null)
    if (this.navEnd === null) this.host.stopNavigation()
    return this.navEnd ?? 'timeout'
  }

  // ---- one round ----

  private async returnToAnchor () {
    const anchor = this.anchor!
    const p = this.host.state.position!
    if (Math.floor(p.x) === Math.floor(anchor.x) && Math.floor(p.z) === Math.floor(anchor.z) &&
      Math.abs(p.y - EYE_HEIGHT - anchor.y!) < .15) { this.returnBlocked = false; return true }
    this.setActivity('Kehrt zum Anker zurück')
    this.returnBlocked = (await this.walk(Math.floor(anchor.x), Math.floor(anchor.z), 'Farm-Anker', anchor.y)) !== 'arrived'
    if (!this.returnBlocked && anchor.y === undefined) anchor.y = this.host.state.position!.y - EYE_HEIGHT
    if (this.returnBlocked) this.problem('anchor', `Ich komme nicht zum Farm-Anker ${anchor.label}.`)
    else this.reported.delete('anchor')
    return !this.returnBlocked
  }

  private async round () {
    this.inventoryFailure = null
    const anchor = this.anchor!
    const state = this.host.state
    const here = () => state.position!
    if (anchor.y === undefined || this.returnBlocked || Math.hypot(here().x - anchor.x, here().z - anchor.z) > this.radius) {
      if (!(await this.returnToAnchor())) return
    }
    this.reported.delete('anchor')
    const tally: Tally = { harvested: Object.fromEntries(FARM_CROPS.map(kind => [kind, 0])) as Record<CropKind, number>, planted: 0, unplanted: 0 }
    // Spots left without seed earlier come first, as long as a seed is there now.
    if (this.unplanted.length) {
      const waiting = this.unplanted.splice(0)
      this.unplanted.push(...waiting.filter(spot => !this.selected(spot.kind)))
      await this.plantAll(waiting.filter(spot => this.selected(spot.kind)), tally)
    }
    if (!this.hasFreeSlot()) {
      await this.deposit()
      if (!this.hasFreeSlot()) {
        this.problem('full', 'Mein Inventar ist voll; ich ernte erst weiter, wenn Platz ist.')
        await this.returnToAnchor()
        return
      }
    }
    this.reported.delete('full')
    this.setActivity('Sucht reife Pflanzen')
    const centre = { x: anchor.x, y: here().y, z: anchor.z }
    const crops = await this.external(state.ripeCrops(centre, this.radius, undefined, FARM_CROPS.filter(kind => this.selected(kind)))).catch((error: unknown) => {
      if (error instanceof WorldError) { log('Suche nicht möglich: ' + error.message); return [] }
      throw error
    })
    log(`${crops.length} reife Pflanze(n) im Bereich.`)
    let remaining: Spot[] = crops
    while (remaining.length) {
      if (!this.hasFreeSlot()) break
      const choice = this.standFor(remaining)
      remaining = remaining.filter(crop => !choice.members.includes(crop))
      if (!choice.stand) { log(`Kein Standplatz für (${choice.members[0].x}, ${choice.members[0].y}, ${choice.members[0].z}).`); continue }
      await this.cluster(choice.stand, choice.members, tally)
    }
    const harvested = FARM_CROPS.reduce((sum, kind) => sum + tally.harvested[kind], 0)
    if (this.unplanted.length) await this.fetchSeeds(tally)
    if (this.surplus() > DEPOSIT_THRESHOLD || !this.hasFreeSlot()) await this.deposit()
    if (harvested) {
      const parts = FARM_CROPS.filter(kind => tally.harvested[kind]).map(kind => `${tally.harvested[kind]} ${CROP_LABELS[kind]}`)
      const summary = `${parts.join(', ')} geerntet, ${tally.planted} neu gepflanzt` + (this.unplanted.length ? `, ${this.unplanted.length} Stelle(n) ohne Saatgut` : '') + '.'
      this.lastSummary = summary
      log('Runde: ' + summary)
      this.onReport(summary)
    } else if (tally.planted) log(`Runde: ${tally.planted} Stelle(n) nachgepflanzt.`)
    await this.returnToAnchor()
  }

  // Harvests one cluster from one standing place, collects the drops and replants.
  private async cluster (stand: Stand, crops: Spot[], tally: Tally) {
    if (!(await this.goTo(stand, 'Feld'))) return
    this.setActivity('Erntet')
    const harvested: Spot[] = []
    for (const crop of [...crops].sort((a, b) => b.y - a.y)) {
      if (!this.selected(crop.kind)) continue
      const current = this.host.state.cropAt(crop.x, crop.y, crop.z)
      if (current?.kind !== crop.kind || !this.host.state.harvestable(crop.x, crop.y, crop.z, current)) continue
      if (crop.kind === 'cocoa') crop.direction = current.direction
      const centre = { x: crop.x + .5, y: crop.y + .5, z: crop.z + .5 }
      if (this.eyeDistance(centre) > REACH) { log(`(${crop.x}, ${crop.y}, ${crop.z}) außer Reichweite.`); continue }
      const pendingKey = `${crop.x}:${crop.y}:${crop.z}`
      if (CROPS[crop.kind]) this.pendingReplants.set(pendingKey, { ...crop })
      if (!(await this.harvest(crop, centre))) { this.pendingReplants.delete(pendingKey); continue }
      harvested.push(crop)
      tally.harvested[crop.kind]++
      if (crop.kind === 'cocoa') {
        await this.collect(stand, crop)
        await this.plantAll([crop], tally)
        harvested.pop()
      }
    }
    if (!harvested.length) return
    log(`${harvested.length} Pflanze(n) bei (${stand.x}, ${stand.z}) geerntet.`)
    await this.collect(stand, harvested[0])
    await this.plantAll(harvested.filter(spot => CROPS[spot.kind]), tally)
  }

  private async harvest (crop: Spot, centre: Position) {
    const state = this.host.state
    if (crop.kind === 'sweet_berry_bush') {
      const runtime = state.blockRuntimeIdAt(crop.x, crop.y, crop.z)
      if (runtime === null) return false
      // Empty hand avoids fertilising with bone meal or using another held item on the bush.
      const slot = await this.holdEmpty(centre)
      if (slot === null) return false
      await this.act(send => {
        this.host.navigator.clickBlock(send, crop, runtime, state.inventory.packetItem(slot), { hotbarSlot: slot })
        this.host.navigator.lookAt(send, centre)
      })
    } else {
      const action = (name: string) => ({ action: name, position: { x: crop.x, y: crop.y, z: crop.z }, face: 1 })
      const duration = crop.kind === 'melon_block' || crop.kind === 'pumpkin' ? 1600 : crop.kind === 'cocoa' ? 350 : 0
      if (duration) {
        if (await this.holdEmpty(centre) === null) return false
        await this.act(send => this.host.navigator.lookAt(send, centre, { flags: ['block_action'], fields: { block_action: [action('start_break')] } }))
        await this.ticks(duration, () => state.cropAt(crop.x, crop.y, crop.z)?.kind !== crop.kind,
          send => this.host.navigator.lookAt(send, centre, { flags: ['block_action'], fields: { block_action: [action('continue_break')] } }))
        await this.act(send => this.host.navigator.lookAt(send, centre, { flags: ['block_action'], fields: { block_action: [action('predict_break')] } }))
      } else {
        await this.act(send => this.host.navigator.lookAt(send, centre, { flags: ['block_action'], fields: { block_action: [action('start_break'), action('predict_break')] } }))
      }
      await this.act(send => this.host.navigator.lookAt(send, centre, { flags: ['block_action'], fields: { block_action: [action('stop_break')] } }))
    }
    return this.ticks(BREAK_MS, () => {
      const now = state.cropAt(crop.x, crop.y, crop.z)
      return crop.kind === 'sweet_berry_bush' ? now?.kind === crop.kind && now.growth < 3 : now?.kind !== crop.kind
    }, send => this.host.navigator.lookAt(send, centre))
  }

  private async holdEmpty (look: Position): Promise<number | null> {
    const slot = await this.freeHotbarSlot()
    if (slot < 0) { this.problem('emptyhand', this.inventoryFailure ?? 'Kein Platz zum Freiräumen eines Hotbar-Slots.'); return null }
    await this.act(send => send('mob_equipment', { runtime_entity_id: this.host.entityId(), item: this.host.state.inventory.packetItem(slot), slot, selected_slot: slot, window_id: 'inventory' }))
    this.equipped = null
    await this.ticks(150, () => false, send => this.host.navigator.lookAt(send, look))
    return slot
  }

  private async moveStack (move: Move, swap = false) {
    if (this.inventoryFailure) return false
    const token = this.token
    const inventory = this.host.state.inventory
    try {
      await this.act(send => {
        this.inventoryOpening = true
        this.inventoryClosing = false
        send('interact', { action_id: 'open_inventory', target_entity_id: this.host.entityId(), has_position: false })
      })
      if (!(await this.ticks(3000, () => this.inventoryWindow !== null))) {
        this.inventoryFailure = 'Der Server hat mein Inventarfenster nicht geöffnet.'
        return false
      }
      const box: { request?: Promise<StackResponse | null> } = {}
      await this.act(send => { box.request = (swap ? inventory.swap(send, move, this.host.now()) : inventory.place(send, move, this.host.now())).catch(() => null) })
      const response = await this.external(box.request!)
      this.equipped = null
      if (!response || (response.status !== 'ok' && response.status !== 0)) {
        this.inventoryFailure = response ? `Der Server hat das Umlagern abgelehnt (Status ${response.status}).` : 'Der Server hat das Umlagern nicht bestätigt.'
        return false
      }
      return true
    } finally {
      // The heartbeat also closes after cancellation and after a delayed open acknowledgement.
      if (this.token === token) this.inventoryClosing = true
    }
  }

  // Clear a hotbar slot without discarding items; only use a merge if the entire stack fits.
  private async freeHotbarSlot (): Promise<number> {
    const inventory = this.host.state.inventory
    const slots = inventory.slotList()
    const empty = slots.findIndex((slot, i) => i < 9 && slot === null)
    if (empty >= 0) return empty
    for (let from = 0; from < 9; from++) {
      const source = slots[from]!
      let to = slots.findIndex((slot, i) => i >= 9 && slot === null)
      if (to < 0) to = slots.findIndex((slot, i) => i !== from && slot !== null && slot.name === source.name &&
        slot.raw !== null && source.raw !== null && isDeepStrictEqual({ ...slot.raw as object, count: 0, stack_id: 0 }, { ...source.raw as object, count: 0, stack_id: 0 }) &&
        slot.count + source.count <= stackSize(source.name))
      if (to < 0) continue
      const move = { name: source.name, count: source.count, from: { container: playerContainer(from), slot: from, stackId: source.stackId },
        to: { container: playerContainer(to), slot: to, stackId: slots[to]?.stackId ?? 0 } }
      if (!(await this.moveStack(move))) return -1
      return inventory.slotList()[from] === null ? from : -1
    }
    return -1
  }

  // Walks onto the columns of drops around the standing place until they are picked up (at most PICKUP_WALKS walks).
  private async collect (stand: Stand, lookAt: Position) {
    this.setActivity('Sammelt ein')
    const look = { x: lookAt.x + .5, y: lookAt.y, z: lookAt.z + .5 }
    await this.ticks(600, () => false, send => this.host.navigator.lookAt(send, look))
    const skipped = new Set<string>()
    for (let walk = 0; walk < PICKUP_WALKS; walk++) {
      const drop = nearestDrop(this.host.state, (id, item) => !skipped.has(id) &&
        Math.max(Math.abs(Math.floor(item.position.x) - stand.x), Math.abs(Math.floor(item.position.z) - stand.z)) <= 2 &&
        Math.abs(item.position.y - stand.feetY) <= 3)
      if (!drop) return
      const p = this.host.state.position!
      const [id, item] = drop
      const column = dropColumn(item)
      if (Math.floor(p.x) !== column.x || Math.floor(p.z) !== column.z) {
        const status = await this.walk(column.x, column.z, 'Drop')
        if (status !== 'arrived') { skipped.add(id); continue }
      }
      if (!(await this.ticks(PICKUP_MS, () => !this.host.state.items.has(id), send => this.host.navigator.lookAt(send, look)))) skipped.add(id)
    }
  }

  // Replants harvested spots with the same crop, cluster by cluster; spots without seed are kept for later.
  private async plantAll (spots: Spot[], tally: Tally) {
    let remaining = spots.filter(spot => this.plantable(spot))
    for (const spot of remaining) this.pendingReplants.set(`${spot.x}:${spot.y}:${spot.z}`, { ...spot })
    while (remaining.length) {
      const choice = this.standFor(remaining)
      remaining = remaining.filter(spot => !choice.members.includes(spot))
      if (!choice.stand || !(await this.goTo(choice.stand, 'Feld'))) { this.unplanted.push(...choice.members); tally.unplanted += choice.members.length; continue }
      this.setActivity('Pflanzt')
      for (const spot of choice.members) {
        if (!this.plantable(spot)) continue
        const result = await this.plant(spot)
        if (result === 'planted') tally.planted++
        else { this.unplanted.push(spot); tally.unplanted++ }
        this.pendingReplants.delete(`${spot.x}:${spot.y}:${spot.z}`)
      }
    }
  }

  private plantable (spot: Spot) {
    const state = this.host.state
    return state.blockNameAt(spot.x, spot.y, spot.z) === 'minecraft:air' &&
      (spot.kind === 'cocoa' ? this.cocoaSupport(spot) !== null : !!CROPS[spot.kind] && state.blockNameAt(spot.x, spot.y - 1, spot.z) === 'minecraft:farmland')
  }

  private cocoaSupport (spot: Spot) {
    // Bedrock direction points into the support: south, west, north, east.
    const offset = [[0, 1, 2], [-1, 0, 5], [0, -1, 3], [1, 0, 4]][spot.direction ?? -1]
    if (!offset) return null
    const [dx, dz, face] = offset
    const position = { x: spot.x + dx, y: spot.y, z: spot.z + dz }
    const name = this.host.state.blockNameAt(position.x, position.y, position.z)
    if (!name || !/^minecraft:(?:stripped_)?jungle_(?:log|wood)$/.test(name)) return null
    return { position, face, clickPos: { x: face === 4 ? 0 : face === 5 ? 1 : .5, y: .5, z: face === 2 ? 0 : face === 3 ? 1 : .5 } }
  }

  private async plant (spot: Spot): Promise<'planted' | 'failed' | 'no_seed'> {
    const state = this.host.state
    const seed = CROPS[spot.kind]!
    const support = spot.kind === 'cocoa' ? this.cocoaSupport(spot) : null
    if (spot.kind === 'cocoa' && !support) return 'failed'
    const soilTop = support ? { x: spot.x + .5, y: spot.y + .5, z: spot.z + .5 } : { x: spot.x + .5, y: spot.y - .0625, z: spot.z + .5 }
    const slot = await this.holdSeed(seed, soilTop)
    if (slot === null) return 'no_seed'
    const soil = support?.position ?? { x: spot.x, y: spot.y - 1, z: spot.z }
    const soilRuntime = state.blockRuntimeIdAt(soil.x, soil.y, soil.z)
    if (soilRuntime === null) return 'failed'
    // Ends the break state left from harvesting; without it the server destroys the new crop in the same tick (verified live).
    const position = { x: spot.x, y: spot.y, z: spot.z }
    await this.act(send => this.host.navigator.lookAt(send, soilTop, { flags: ['block_action'], fields: { block_action: [{ action: 'abort_break', position, face: 1 }] } }))
    await this.ticks(150, () => false, send => this.host.navigator.lookAt(send, soilTop))
    const held = state.inventory.packetItem(slot)
    await this.act(send => {
      this.host.navigator.clickBlock(send, soil, soilRuntime, held, { face: support?.face ?? 1, clickPos: support?.clickPos ?? { x: .5, y: 1, z: .5 }, hotbarSlot: slot })
      // The server handles the click only together with an input packet.
      this.host.navigator.lookAt(send, soilTop)
    })
    const grown = () => state.cropAt(spot.x, spot.y, spot.z)?.kind === spot.kind
    const look = (send: Send) => this.host.navigator.lookAt(send, soilTop)
    if (!(await this.ticks(PLANT_MS, grown, look))) { log(`(${spot.x}, ${spot.y}, ${spot.z}) nicht gepflanzt.`); return 'failed' }
    await this.ticks(PLANT_CONFIRM_MS, () => false, look)
    if (!grown()) { log(`(${spot.x}, ${spot.y}, ${spot.z}): Pflanze gleich wieder zerstört.`); return 'failed' }
    return 'planted'
  }

  // Puts a stack of the seed into the hotbar if needed and selects it; returns the hotbar slot, or null without seed.
  private async holdSeed (seed: string, lookAt: Position): Promise<number | null> {
    const inventory = this.host.state.inventory
    const matches = (slot: Slot | null) => slot !== null && shortName(slot.name) === seed
    let slots = inventory.slotList()
    let index = slots.findIndex((slot, i) => i < 9 && matches(slot))
    if (index < 0) {
      const from = slots.findIndex(matches)
      if (from < 0) return null
      const empty = slots.findIndex((slot, i) => i < 9 && slot === null)
      const to = empty < 0 ? 0 : empty
      const source = slots[from]!
      log(`Lege ${source.count} ${seed} aus Slot ${from} in die Hotbar (${to}).`)
      const move = { name: source.name, count: source.count, from: { container: playerContainer(from), slot: from, stackId: source.stackId }, to: { container: playerContainer(to), slot: to, stackId: slots[to]?.stackId ?? 0 } }
      if (!(await this.moveStack(move, empty < 0))) { log('Saatgut ließ sich nicht in die Hotbar legen.'); return null }
      slots = inventory.slotList()
      index = matches(slots[to]) ? to : -1
      if (index < 0) return null
    }
    const slot = slots[index]!
    if (this.equipped?.slot !== index || this.equipped.stackId !== slot.stackId) {
      const item = inventory.packetItem(index)
      await this.act(send => send('mob_equipment', { runtime_entity_id: this.host.entityId(), item, slot: index, selected_slot: index, window_id: 'inventory' }))
      await this.ticks(300, () => false, send => this.host.navigator.lookAt(send, lookAt))
      this.equipped = { slot: index, stackId: slot.stackId }
    }
    return index
  }

  // ---- chests ----

  /** Harvest items above the reserve (wheat, beetroot and poisonous potatoes count fully). */
  private surplus (slots = this.host.state.inventory.slotList()) {
    return DEPOSIT.reduce((sum, name) => sum + Math.max(0, this.count(slots, name) - (RESERVE[name] ?? 0)), 0)
  }

  private count (slots: (Slot | null)[], name: string) {
    return slots.reduce((sum, slot) => sum + (slot && shortName(slot.name) === name ? slot.count : 0), 0)
  }

  private hasFreeSlot () { return this.host.state.inventory.slotList().some(slot => slot === null) }

  private async deposit () {
    if (this.surplus() === 0) return
    this.setActivity('Lagert ein')
    const planner: ChestPlanner = (inventory: Inventory, window) => {
      const own = inventory.slotList()
      for (const name of DEPOSIT) {
        const excess = this.count(own, name) - (RESERVE[name] ?? 0)
        if (excess <= 0) continue
        const full = own.find(slot => slot && shortName(slot.name) === name)!.name
        return nextTransfer(own, playerContainer, window.slots, () => CHEST_CONTAINER, full, excess)
      }
      return { stop: 'done' } as TransferStep
    }
    const result = await this.visitChests(planner)
    if (result === null) return this.problem('nochest', 'Keine erreichbare Kiste im Farmbereich zum Einlagern.')
    log(`${result} Gegenstände eingelagert.`)
    this.reported.delete('nochest')
  }

  // Fetches seeds for spots left without one, once per round, and plants them.
  private async fetchSeeds (tally: Tally) {
    const needed = new Map<string, number>()
    for (const spot of this.unplanted) {
      const seed = CROPS[spot.kind]
      if (seed && this.selected(spot.kind)) needed.set(seed, (needed.get(seed) ?? 0) + 1)
    }
    if (!needed.size) return
    this.setActivity('Holt Saatgut')
    const planner: ChestPlanner = (inventory: Inventory, window, moved) => {
      const own = inventory.slotList()
      for (const [seed, count] of needed) {
        if (this.count(own, seed) >= count) continue
        const full = window.slots.find(slot => slot && shortName(slot.name) === seed)?.name
        if (!full) continue
        const step = nextTransfer(window.slots, () => CHEST_CONTAINER, own, playerContainer, full, count - this.count(own, seed))
        if ('move' in step) return step
      }
      return { stop: moved ? 'done' : 'source_empty' } as TransferStep
    }
    const result = await this.visitChests(planner, true)
    log(`Saatgut aus Kiste: ${result ?? 'keine Kiste'}.`)
    const waiting = this.unplanted.splice(0)
    this.unplanted.push(...waiting.filter(spot => !this.selected(spot.kind)))
    tally.unplanted -= waiting.length
    await this.plantAll(waiting.filter(spot => this.selected(spot.kind)), tally)
    for (const [seed] of needed) {
      if (this.unplanted.some(spot => CROPS[spot.kind] === seed)) this.problem('seed:' + seed, `Kein ${seed} zum Nachpflanzen; die Stellen bleiben leer.`)
    }
  }

  // Opens the nearest chests in the farm area one after another; returns the moved total, or null when none could be opened.
  private async visitChests (planner: ChestPlanner, untilMoved = false): Promise<number | null> {
    const state = this.host.state
    const anchor = this.anchor!
    const p = state.position!
    const result = await this.external(state.searchBlocks(CHEST_IDS, 20, p)).catch((error: unknown) => {
      if (error instanceof WorldError) { log('Kistensuche nicht möglich: ' + error.message); return null }
      throw error
    })
    if (!result) return null
    const chests = result.hits.filter(hit => Math.hypot(hit.x + .5 - anchor.x, hit.z + .5 - anchor.z) <= this.radius + 2)
    let opened = 0; let moved = 0
    for (const chest of chests.slice(0, MAX_CHESTS * 2)) {
      if (opened >= MAX_CHESTS) break
      const eye = state.position!
      if (Math.hypot(chest.x + .5 - eye.x, chest.y + .5 - eye.y, chest.z + .5 - eye.z) > REACH) {
        const spot = chestStandSpot(state, chest, eye)
        if (!spot || (await this.walk(spot.x, spot.z, 'Kiste')) !== 'arrived') continue
      }
      this.chestOpen = true
      const visit = await this.external(this.host.useChest(chest, planner)).finally(() => { this.chestOpen = false })
      if (!visit.opened) continue
      opened++
      moved += visit.moved
      if (visit.stop !== 'target_full' && (visit.stop !== 'source_empty' || !untilMoved)) break
    }
    return opened ? moved : null
  }

  // ---- standing places ----

  // The column to stand on for the target nearest to the bot: within the 3×3 around it, the one that reaches the most targets
  // (Chebyshev distance ≤ 1), then the nearer one. Without a standable column the target alone is returned with stand null.
  private standFor<T extends Position & { kind?: CropKind; direction?: number }> (targets: T[]): { stand: Stand | null; members: T[] } {
    const p = this.host.state.position!
    const first = targets.reduce((best, target) => Math.hypot(target.x + .5 - p.x, target.z + .5 - p.z) < Math.hypot(best.x + .5 - p.x, best.z + .5 - p.z) ? target : best)
    let best: { stand: Stand; members: T[]; distance: number } | null = null
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const x = first.x + dx; const z = first.z + dz
      const support = first.kind === 'cocoa' ? [[0, 1], [-1, 0], [0, -1], [1, 0]][first.direction ?? -1] : null
      // Replant beside the pod so the new cocoa cannot occupy the bot's head space.
      if (first.kind === 'cocoa' && (!support || (!dx && !dz) || dx * support[0] + dz * support[1] > 0)) continue
      // Farmland top, level ground, a slab, one block up or down.
      // Include ground below tall cane and cocoa, including farmland and half slabs; prefer the bot's current floor.
      const heights = Array.from({ length: 7 }, (_, i) => first.y + 1 - i).flatMap(y => [y, y - .0625, y - .5])
      heights.sort((a, b) => Math.abs(a - (p.y - EYE_HEIGHT)) - Math.abs(b - (p.y - EYE_HEIGHT)))
      const feetY = heights.find(y => this.host.state.canStandAt(x + .5, z + .5, y) &&
        Math.hypot(first.x - x, first.y + .5 - y - EYE_HEIGHT, first.z - z) <= REACH)
      if (feetY === undefined) continue
      const eye = { x: x + .5, y: feetY + 1.62, z: z + .5 }
      const members = targets.filter(target => {
        if (target.kind === 'cocoa') {
          const support = [[0, 1], [-1, 0], [0, -1], [1, 0]][target.direction ?? -1]
          if (!support || (x === target.x && z === target.z) || (x - target.x) * support[0] + (z - target.z) * support[1] > 0) return false
        }
        return Math.max(Math.abs(target.x - x), Math.abs(target.z - z)) <= 1 &&
          Math.hypot(target.x + .5 - eye.x, target.y + .5 - eye.y, target.z + .5 - eye.z) <= REACH
      })
      if (!members.includes(first)) continue
      const distance = Math.hypot(x + .5 - p.x, z + .5 - p.z)
      if (!best || members.length > best.members.length || (members.length === best.members.length && distance < best.distance)) best = { stand: { x, z, feetY }, members, distance }
    }
    return best ? { stand: best.stand, members: best.members } : { stand: null, members: [first] }
  }

  private async goTo (stand: Stand, label: string) {
    const p = this.host.state.position!
    if (Math.floor(p.x) === stand.x && Math.floor(p.z) === stand.z && Math.abs(p.y - EYE_HEIGHT - stand.feetY) < .15) return true
    this.setActivity('Läuft zum Feld')
    const status = await this.walk(stand.x, stand.z, label, stand.feetY)
    if (status !== 'arrived') log(`Standplatz (${stand.x}, ${stand.z}) nicht erreicht: ${status}.`)
    return status === 'arrived'
  }

  private eyeDistance (point: Position) {
    const p = this.host.state.position!
    return Math.hypot(point.x - p.x, point.y - p.y, point.z - p.z)
  }
}
