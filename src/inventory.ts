/*
 * The bot's own 36-slot inventory (hotbar 0–8, main inventory 9–35) as the server reports it.
 * Bedrock inventories are server-authoritative: items leave only through an item_stack_request that names
 * each slot together with the stack network ID the server assigned, and the server confirms with item_stack_response.
 */
type Send = (name: string, params: unknown) => void
export type Slot = { name: string; count: number; stackId: number; raw: unknown }
type PacketItem = { network_id?: number; count?: number; has_stack_id?: boolean; stack_id?: number }
type ResponseSlot = { slot?: number; count?: number; item_stack_id?: number }
export type StackResponse = { status?: string | number; request_id?: number; containers?: { slot_type?: { container_id?: string | number }; slots?: ResponseSlot[] }[] }
// A drop resolves with the dropped total; a placement (raw) resolves with the server's answer, accepted or not.
type Pending = { total: number; deadline: number; name?: string; resolve: (value: never) => void; reject: (error: Error) => void }
export type InventoryItem = { name: string; count: number }
/** One slot in a stack request: the container name the server uses, the slot and the stack ID the server assigned (0 for empty). */
export type SlotRef = { container: string; slot: number; stackId: number }
export type Move = { name: string; count: number; from: SlotRef; to: SlotRef }
/** The next single move of a transfer, or why the transfer ends. */
export type TransferStep = { move: Move } | { stop: 'done' | 'source_empty' | 'target_full' }

const SLOTS = 36
const HOTBAR = 9
const RESPONSE_TIMEOUT_MS = 3000
const PLAYER_CONTAINERS = new Set(['hotbar', 'inventory', 'hotbar_and_inventory', 12, 28, 29])
// The name a chest's slots carry in stack requests and responses (verified live; "level_entity" is rejected).
export const CHEST_CONTAINER = 'container'
export const EMPTY_ITEM = { network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: false, can_place_on: [], can_destroy: [] } }
const log = (message: string) => console.log('[inv] ' + message)
/** "minecraft:dirt" → "dirt"; other namespaces stay visible. */
export const shortName = (name: string) => name.replace(/^minecraft:/, '')
/** The container name of one of the bot's own slots. */
export const playerContainer = (slot: number) => slot < HOTBAR ? 'hotbar' : 'inventory'

let itemsByName: Record<string, { stackSize?: number }> | null = null
/** Maximum stack size of an item from minecraft-data; 64 when the item is unknown. */
export function stackSize (name: string, version = '1.26.60') {
  itemsByName ??= require('prismarine-registry')('bedrock_' + version).itemsByName as Record<string, { stackSize?: number }>
  return itemsByName[shortName(name)]?.stackSize ?? 64
}

/**
 * The next move of `name` (or of the first item found when null) from `source` to `target`:
 * from source slots in slot order, onto a partial stack of the same item first, then into the first empty slot.
 */
export function nextTransfer (source: readonly (Slot | null)[], sourceContainer: (slot: number) => string,
  target: readonly (Slot | null)[], targetContainer: (slot: number) => string, name: string | null, left: number): TransferStep {
  if (left <= 0) return { stop: 'done' }
  const from = source.findIndex(slot => slot !== null && (name === null || slot.name === name))
  if (from < 0) return { stop: 'source_empty' }
  const item = source[from]!
  const max = stackSize(item.name)
  let to = target.findIndex(slot => slot !== null && slot.name === item.name && slot.count < max)
  if (to < 0) to = target.findIndex(slot => slot === null)
  if (to < 0) return { stop: 'target_full' }
  const there = target[to]
  const count = Math.min(left, item.count, max - (there?.count ?? 0))
  return { move: { name: item.name, count, from: { container: sourceContainer(from), slot: from, stackId: item.stackId }, to: { container: targetContainer(to), slot: to, stackId: there?.stackId ?? 0 } } }
}

/** An open chest window: its slots as the server reported them, updated from stack responses. */
export class ContainerWindow {
  constructor (readonly windowId: number | string, readonly type: unknown, public slots: (Slot | null)[]) {}
}

export class Inventory {
  private names = new Map<number, string>()
  private slots: (Slot | null)[] = new Array(SLOTS).fill(null)
  private pending = new Map<number, Pending>()
  private nextRequestId = -1
  /** False until the server sent the inventory once after spawning. */
  known = false
  revision = 0
  /** The open chest, if any; its slots follow the stack responses like the bot's own. */
  window: ContainerWindow | null = null

  /** Network item ID → item name, from the item_registry packet. */
  setRegistry (entries: unknown) {
    if (!Array.isArray(entries)) return
    for (const entry of entries as { name?: unknown; runtime_id?: unknown }[]) {
      if (typeof entry?.name === 'string' && Number.isInteger(entry.runtime_id)) this.names.set(entry.runtime_id as number, entry.name)
    }
  }

  setContent (items: unknown) {
    if (!Array.isArray(items)) return
    for (let i = 0; i < SLOTS; i++) this.slots[i] = this.toSlot(items[i])
    log(`Inventar erhalten: ${this.slots.filter(Boolean).length} belegte Slots.`)
    this.known = true
    this.revision++
  }

  setSlot (slot: unknown, item: unknown) {
    if (!Number.isInteger(slot) || (slot as number) < 0 || (slot as number) >= SLOTS) return
    this.slots[slot as number] = this.toSlot(item)
    const value = this.slots[slot as number]
    log(`Slot ${slot}: ${value ? `${value.count} ${value.name}` : 'leer'}.`)
    this.revision++
  }

  /** Opens the chest window from its inventory_content. */
  openWindow (windowId: number | string, type: unknown, items: unknown) {
    this.window = new ContainerWindow(windowId, type, Array.isArray(items) ? items.map(item => this.toSlot(item)) : [])
    log(`Kiste geöffnet: Fenster ${windowId}, ${this.window.slots.length} Slots, ${this.window.slots.filter(Boolean).length} belegt.`)
    return this.window
  }

  /** The bot's 36 slots (copies). */
  slotList (): (Slot | null)[] {
    return this.slots.map(slot => slot && { ...slot })
  }

  /** The raw packet item of a slot, as a click sends it for the held item. */
  heldItem (slot: number) {
    return this.slots[slot]?.raw ?? EMPTY_ITEM
  }

  /** Totals per item name, largest first. */
  items (): InventoryItem[] {
    const totals = new Map<string, number>()
    for (const slot of this.slots) if (slot) totals.set(slot.name, (totals.get(slot.name) ?? 0) + slot.count)
    return [...totals].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  }

  /** Drops up to `count` of the named item from as many stacks as needed; resolves with the dropped amount once the server confirms. */
  drop (send: Send, name: string, count: number, now: number): Promise<number> {
    const actions = []
    let left = count
    for (let i = 0; i < SLOTS && left > 0; i++) {
      const slot = this.slots[i]
      if (!slot || slot.name !== name) continue
      const amount = Math.min(left, slot.count)
      actions.push({
        type_id: 'drop', legacy_type_id: 3, count: amount, randomly: false,
        source: { slot_type: { container_id: playerContainer(i), dynamic_container_id: undefined }, slot: i, stack_id: slot.stackId }
      })
      left -= amount
    }
    if (!actions.length) return Promise.reject(new Error(`Kein ${shortName(name)} im Inventar.`))
    const id = this.requestId()
    const total = count - left
    log(`Werfe ${total} ${name} aus ${actions.length} Stack(s), Anfrage ${id}.`)
    send('item_stack_request', { requests: [{ request_id: id, actions, custom_names: [], cause: 'chat_public' }] })
    return new Promise((resolve, reject) => this.pending.set(id, { total, deadline: now + RESPONSE_TIMEOUT_MS, resolve: resolve as (value: never) => void, reject }))
  }

  /** Moves one stack portion with a single `place` action; resolves with the server's answer, whether accepted or not. */
  place (send: Send, move: Move, now: number): Promise<StackResponse> {
    const ref = (slot: SlotRef) => ({ slot_type: { container_id: slot.container, dynamic_container_id: undefined }, slot: slot.slot, stack_id: slot.stackId })
    const id = this.requestId()
    log(`Lege ${move.count} ${move.name} von ${move.from.container} ${move.from.slot} nach ${move.to.container} ${move.to.slot}, Anfrage ${id}.`)
    send('item_stack_request', { requests: [{ request_id: id, actions: [{ type_id: 'place', legacy_type_id: 1, count: move.count, source: ref(move.from), destination: ref(move.to) }], custom_names: [], cause: 'chat_public' }] })
    return new Promise((resolve, reject) => this.pending.set(id, { total: move.count, name: move.name, deadline: now + RESPONSE_TIMEOUT_MS, resolve: resolve as (value: never) => void, reject }))
  }

  /** Applies the server's answers: confirmed slots take the reported counts and stack IDs. */
  response (responses: unknown) {
    if (!Array.isArray(responses)) return
    for (const response of responses as StackResponse[]) {
      const pending = this.pending.get(response.request_id as number)
      if (!pending) continue
      this.pending.delete(response.request_id as number)
      if (response.status !== 'ok' && response.status !== 0) {
        log(`Anfrage ${response.request_id} abgelehnt: Status ${response.status}.`)
        if (pending.name !== undefined) (pending.resolve as (value: StackResponse) => void)(response)
        else pending.reject(new Error('Der Server hat das Werfen abgelehnt.'))
        continue
      }
      log(`Anfrage ${response.request_id} bestätigt: ${(response.containers ?? []).map(container =>
        (container.slot_type?.container_id ?? '?') + ' ' + (container.slots ?? []).map(entry => `${entry.slot}=${entry.count}`).join(',')).join('; ') || 'keine Slots'}.`)
      for (const container of response.containers ?? []) {
        const id = container.slot_type?.container_id
        const slots = PLAYER_CONTAINERS.has(id as string) ? this.slots : id === CHEST_CONTAINER && this.window ? this.window.slots : null
        if (!slots) continue
        for (const entry of container.slots ?? []) {
          const index = entry.slot as number
          if (!Number.isInteger(index) || index < 0 || index >= slots.length) continue
          const slot = slots[index]
          if (!entry.count) slots[index] = null
          else if (slot) { slot.count = entry.count; if (Number.isInteger(entry.item_stack_id)) slot.stackId = entry.item_stack_id! }
          // A slot that was empty now holds the moved item; only a placement says which one.
          else if (pending.name !== undefined) slots[index] = { name: pending.name, count: entry.count, stackId: entry.item_stack_id ?? 0, raw: null }
        }
      }
      this.revision++
      if (pending.name !== undefined) (pending.resolve as (value: StackResponse) => void)(response)
      else (pending.resolve as (value: number) => void)(pending.total)
    }
  }

  /** Fails requests the server has not answered in time. */
  expire (now: number) {
    for (const [id, pending] of this.pending) {
      if (now < pending.deadline) continue
      this.pending.delete(id)
      log(`Anfrage ${id} ohne Antwort.`)
      pending.reject(new Error('Der Server hat nicht geantwortet.'))
    }
  }

  /** Forgets everything; called with every world reset. The registry is resent with the next start_game. */
  reset () {
    for (const pending of this.pending.values()) pending.reject(new Error('Verbindung getrennt.'))
    this.pending.clear()
    this.names.clear()
    this.slots.fill(null)
    this.window = null
    if (this.known) this.revision++
    this.known = false
  }

  // Client request IDs are negative and odd, as the vanilla client numbers them.
  private requestId () {
    const id = this.nextRequestId; this.nextRequestId -= 2
    return id
  }

  private toSlot (item: unknown): Slot | null {
    const value = item as PacketItem | undefined
    if (!value || !value.network_id || !value.count) return null
    return { name: this.names.get(value.network_id) ?? '#' + value.network_id, count: value.count, stackId: value.has_stack_id ? value.stack_id ?? 0 : 0, raw: value }
  }
}
