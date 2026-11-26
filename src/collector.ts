import type { Command } from './bot.js'
import type { FarmAnchor } from './farming.js'
import { FARM_RADIUS, PAUSE_MS } from './farming.js'
import { shortName } from './inventory.js'
import { dropColumn, itemFilter, nearestDrop, PICKUP_MS } from './item-collection.js'
import type { Target } from './pathfinder.js'
import type { Navigator } from './navigation.js'
import type { ItemEntity, WorldState } from './state.js'

type CollectorHost = {
  readonly state: WorldState; readonly reach: number; readonly navigator: Pick<Navigator, 'lookAt'>
  now (): number
  enqueue (command: Command): boolean
  stopNavigation (): void
  activate (): void
  publish (): void
}
export type CollectorStatus = {
  enabled: boolean; anchor: FarmAnchor | null; radius: number; item: string | null; activity: string; pausedUntil: number | null; lastSummary: string | null
}
const RETRY_MS = 30000

/** Tick-driven collection: one navigation or pickup wait at a time, with no independent timers. */
export class Collector {
  private sleepPausedAt: number | null = null
  suspendForSleep (pause: boolean) {
    if (pause && this.sleepPausedAt === null) { this.sleepPausedAt = this.host.now(); this.cancel() }
    else if (!pause && this.sleepPausedAt !== null) {
      this.sleepPausedAt = null; this.nextScanAt = 0
    }
  }
  onReport: (text: string) => void = () => {}
  private enabled = false
  private anchor: FarmAnchor | null = null
  private filter: string | null = null
  private activity = 'Aus'
  private pausedUntil = 0
  private nextScanAt = 0
  private phase: 'scan' | 'walk' | 'pickup' | 'return' = 'scan'
  private navToken = 0
  private navEnd: string | null = null
  private deadline = 0
  private targetId: string | null = null
  private targetUniqueId: string | null = null
  private collected = new Map<string, number>()
  private lastSummary: string | null = null
  private skipped = new Map<string, number>()

  constructor (private host: CollectorHost) {}
  get radius () { return Math.max(0, Math.min(FARM_RADIUS, this.host.reach - 16)) }

  start (anchor: FarmAnchor, item?: unknown): string | null {
    let filter: string | null
    try { filter = itemFilter(item) } catch { return 'Ungültige Item-ID.' }
    const p = this.host.state.position
    if (this.host.state.status !== 'spawned' || !p) return 'Ich bin gerade nicht verbunden.'
    if (![anchor.x, anchor.z].every(n => Number.isFinite(n) && Math.abs(n) <= 30000000)) return 'Ungültiger Anker.'
    if (this.radius < 1) return 'Der geladene Bereich ist zu klein zum Sammeln.'
    if (Math.hypot(anchor.x - p.x, anchor.z - p.z) > this.host.reach) return `${anchor.label} ist zu weit weg.`
    this.finishRound()
    this.cancel()
    this.lastSummary = null
    this.host.activate()
    this.enabled = true; this.anchor = { ...anchor }; this.filter = filter
    this.pausedUntil = 0; this.nextScanAt = 0; this.skipped.clear()
    this.setActivity('Startet')
    this.onReport(`Collector an: ${anchor.label}, Radius ${this.radius}, ${filter ?? 'alle Items'}.`)
    return null
  }

  off (reason: string | null = null) {
    if (!this.enabled) return false
    this.finishRound()
    this.enabled = false; this.cancel(); this.setActivity('Aus')
    this.onReport('Collector aus' + (reason ? ` (${reason})` : '') + '.')
    return true
  }

  pause () {
    if (!this.enabled) return
    this.finishRound()
    this.cancel(); this.pausedUntil = this.host.now() + PAUSE_MS
    this.host.publish()
  }

  disconnected () { this.finishRound(); this.cancel(); this.nextScanAt = 0; this.skipped.clear() }
  acceptsNavigation (token: number) { return this.enabled && this.navToken === token && (this.phase === 'walk' || this.phase === 'return') }
  navigationEnded (token: number, status: string) { if (this.acceptsNavigation(token)) this.navEnd = status }

  status (): CollectorStatus {
    const paused = this.enabled && this.host.now() < this.pausedUntil
    const activity = !this.enabled ? 'Aus' : this.sleepPausedAt !== null ? 'Pausiert (Schlafen)' : this.host.state.status !== 'spawned' ? 'Wartet auf Verbindung' : paused ? 'Pausiert (Chat-Befehl)' : this.activity
    return { enabled: this.enabled, anchor: this.anchor && { ...this.anchor }, radius: this.radius, item: this.filter, activity, pausedUntil: paused ? this.pausedUntil : null, lastSummary: this.lastSummary }
  }

  /** Only the server's pickup packet naming this bot may add to the round's tally. */
  pickedUp (item: ItemEntity) {
    if (!this.enabled || this.host.state.status !== 'spawned' || this.host.now() < this.pausedUntil || item.count <= 0) return
    const name = shortName(item.name)
    this.collected.set(name, (this.collected.get(name) ?? 0) + item.count)
  }

  step (send: (name: string, params: unknown) => void) {
    if (this.sleepPausedAt !== null) return
    const state = this.host.state; const p = state.position; const now = this.host.now()
    if (!this.enabled || state.status !== 'spawned' || !p || now < this.pausedUntil) return
    if (!state.inventory.known) { this.setActivity('Wartet auf Inventar'); return }
    for (const [id, until] of this.skipped) if (until <= now || !state.items.has(id)) this.skipped.delete(id)
    if (this.phase === 'walk') {
      const item = this.targetId ? state.items.get(this.targetId) : null
      if (!item || item.uniqueId !== this.targetUniqueId || !this.inRange(item.position) || (this.filter !== null && shortName(item.name) !== this.filter)) {
        this.cancel(); return
      }
    }
    if (this.phase === 'walk' || this.phase === 'return') {
      if (!this.navEnd && now < this.deadline) return
      const end = this.navEnd; const returning = this.phase === 'return'
      if (!end) this.host.stopNavigation()
      this.navEnd = null
      if (returning) {
        this.finishRound()
        this.phase = 'scan'; this.nextScanAt = now + (end === 'arrived' ? 1000 : RETRY_MS)
        this.setActivity(end === 'arrived' ? this.idleActivity() : 'Anker nicht erreichbar; wartet')
        return
      }
      if (end !== 'arrived') { this.skip(); return }
      this.phase = 'pickup'; this.deadline = now + PICKUP_MS; this.setActivity('Sammelt ein')
    }
    if (this.phase === 'pickup') {
      const item = this.targetId ? state.items.get(this.targetId) : null
      if (item?.uniqueId === this.targetUniqueId && now < this.deadline) { this.host.navigator.lookAt(send, item.position); return }
      if (item?.uniqueId === this.targetUniqueId) this.skip()
      else { this.phase = 'scan'; this.targetId = null }
    }
    if (now < this.nextScanAt) return
    if (!this.inRange(p)) { this.returnToAnchor(); return }
    const free = state.inventory.slotList().some(slot => slot === null)
    if (free) {
      const drop = nearestDrop(state, (id, item) => !this.skipped.has(id) && this.inRange(item.position) && (this.filter === null || shortName(item.name) === this.filter))
      if (drop) {
        const [id, item] = drop
        this.targetId = id; this.targetUniqueId = item.uniqueId
        // Navigation needs the drop's level too, otherwise another floor in the same column wins.
        this.walk({ ...dropColumn(item), y: item.position.y }, 'walk', 'Drop')
        return
      }
    }
    this.returnToAnchor()
  }

  private finishRound () {
    // Empty polling rounds stay silent, so waiting at the anchor does not flood the chat.
    if (!this.collected.size) return
    this.lastSummary = 'Collector-Runde: ' + [...this.collected].sort(([a], [b]) => a.localeCompare(b))
      .map(([name, count]) => `${count} ${name}`).join(', ') + ' gesammelt.'
    this.collected.clear()
    console.log('[collect] ' + this.lastSummary)
    this.onReport(this.lastSummary)
    this.host.publish()
  }

  private inRange (p: { x: number; z: number }) { return Math.hypot(p.x - this.anchor!.x, p.z - this.anchor!.z) <= this.radius }
  private idleActivity () { return this.host.state.inventory.slotList().some(slot => slot === null) ? 'Wartet auf Drops' : 'Pausiert (Inventar voll)' }
  private returnToAnchor () {
    const anchor = this.anchor!; const p = this.host.state.position!
    if (Math.floor(p.x) !== Math.floor(anchor.x) || Math.floor(p.z) !== Math.floor(anchor.z)) this.walk({ x: Math.floor(anchor.x), z: Math.floor(anchor.z) }, 'return', 'Collector-Anker')
    else { this.finishRound(); this.setActivity(this.idleActivity()); this.nextScanAt = this.host.now() + 1000 }
  }
  private walk (target: Target, phase: 'walk' | 'return', label: string) {
    this.phase = phase; this.navEnd = null; this.deadline = this.host.now() + 130000
    const token = ++this.navToken
    this.setActivity(phase === 'return' ? 'Läuft zum Anker' : 'Läuft zum Drop')
    if (!this.host.enqueue({ type: 'navigate', ...target, origin: { player: '', label, collect: token } })) {
      if (phase === 'walk') this.skip()
      else { this.phase = 'scan'; this.nextScanAt = this.host.now() + 1000 }
    }
  }
  private skip () {
    if (this.targetId) this.skipped.set(this.targetId, this.host.now() + RETRY_MS)
    this.targetId = null; this.phase = 'scan'
  }
  private cancel () {
    this.navToken++; this.host.stopNavigation(); this.phase = 'scan'; this.targetId = null; this.navEnd = null; this.nextScanAt = 0
  }
  private setActivity (text: string) { if (text !== this.activity) { this.activity = text; this.host.publish() } }
}
