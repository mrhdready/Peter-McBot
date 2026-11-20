/*
 * The bot's own 36-slot inventory (hotbar 0–8, main inventory 9–35) as the server reports it.
 * Bedrock inventories are server-authoritative: items leave only through an item_stack_request that names
 * each slot together with the stack network ID the server assigned, and the server confirms with item_stack_response.
 */
type Send = (name: string, params: unknown) => void
type Slot = { name: string; count: number; stackId: number }
type PacketItem = { network_id?: number; count?: number; has_stack_id?: boolean; stack_id?: number }
type ResponseSlot = { slot?: number; count?: number; item_stack_id?: number }
type Response = { status?: string | number; request_id?: number; containers?: { slot_type?: { container_id?: string | number }; slots?: ResponseSlot[] }[] }
type Pending = { total: number; deadline: number; resolve: (dropped: number) => void; reject: (error: Error) => void }
export type InventoryItem = { name: string; count: number }

const SLOTS = 36
const HOTBAR = 9
const RESPONSE_TIMEOUT_MS = 3000
const PLAYER_CONTAINERS = new Set(['hotbar', 'inventory', 'hotbar_and_inventory', 12, 28, 29])
const log = (message: string) => console.log('[inv] ' + message)
/** "minecraft:dirt" → "dirt"; other namespaces stay visible. */
export const shortName = (name: string) => name.replace(/^minecraft:/, '')

export class Inventory {
  private names = new Map<number, string>()
  private slots: (Slot | null)[] = new Array(SLOTS).fill(null)
  private pending = new Map<number, Pending>()
  private nextRequestId = -1
  /** False until the server sent the inventory once after spawning. */
  known = false
  revision = 0

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
        source: { slot_type: { container_id: i < HOTBAR ? 'hotbar' : 'inventory', dynamic_container_id: undefined }, slot: i, stack_id: slot.stackId }
      })
      left -= amount
    }
    if (!actions.length) return Promise.reject(new Error(`Kein ${shortName(name)} im Inventar.`))
    // Client request IDs are negative and odd, as the vanilla client numbers them.
    const id = this.nextRequestId; this.nextRequestId -= 2
    const total = count - left
    log(`Werfe ${total} ${name} aus ${actions.length} Stack(s), Anfrage ${id}.`)
    send('item_stack_request', { requests: [{ request_id: id, actions, custom_names: [], cause: 'chat_public' }] })
    return new Promise((resolve, reject) => this.pending.set(id, { total, deadline: now + RESPONSE_TIMEOUT_MS, resolve, reject }))
  }

  /** Applies the server's answers: confirmed slots take the reported counts and stack IDs. */
  response (responses: unknown) {
    if (!Array.isArray(responses)) return
    for (const response of responses as Response[]) {
      const pending = this.pending.get(response.request_id as number)
      if (!pending) continue
      this.pending.delete(response.request_id as number)
      if (response.status !== 'ok' && response.status !== 0) {
        log(`Anfrage ${response.request_id} abgelehnt: Status ${response.status}.`)
        pending.reject(new Error('Der Server hat das Werfen abgelehnt.'))
        continue
      }
      log(`Anfrage ${response.request_id} bestätigt: ${(response.containers ?? []).map(container =>
        (container.slot_type?.container_id ?? '?') + ' ' + (container.slots ?? []).map(entry => `${entry.slot}=${entry.count}`).join(',')).join('; ') || 'keine Slots'}.`)
      for (const container of response.containers ?? []) {
        if (!PLAYER_CONTAINERS.has(container.slot_type?.container_id as string)) continue
        for (const entry of container.slots ?? []) {
          const slot = this.slots[entry.slot as number]
          if (!slot) continue
          if (!entry.count) this.slots[entry.slot as number] = null
          else { slot.count = entry.count; if (Number.isInteger(entry.item_stack_id)) slot.stackId = entry.item_stack_id! }
        }
      }
      this.revision++
      pending.resolve(pending.total)
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
    if (this.known) this.revision++
    this.known = false
  }

  private toSlot (item: unknown): Slot | null {
    const value = item as PacketItem | undefined
    if (!value || !value.network_id || !value.count) return null
    return { name: this.names.get(value.network_id) ?? '#' + value.network_id, count: value.count, stackId: value.has_stack_id ? value.stack_id ?? 0 : 0 }
  }
}
