type Metadata = { key: string; value: unknown }

/** Read raw bits: minecraft-data 3.119.0 shifts named extended flags by one bit. */
export function sleepingFlag (entries: Metadata[]): boolean | null {
  const player = entries.find(e => e.key === 'player_flags')?.value
  const extended = entries.find(e => e.key === 'flags_extended')?.value as { _value?: bigint | string } | undefined
  const a = typeof player === 'number' && Number.isInteger(player) ? (player & 2) !== 0 : null
  let b: boolean | null = null
  if (extended?._value !== undefined) {
    try { b = (BigInt(extended._value) & 4096n) !== 0n } catch { return null }
  }
  return a !== null && b !== null && a !== b ? null : a ?? b
}

export class WorldConditions {
  private names = new Map<string, string>()
  private sample: { time: number; paused: boolean; at: number } | null = null
  private partners = new Map<string, { name: string; sleeping: boolean | null }>()
  private requests = new Map<string, number>()
  selfSleeping: boolean | null = null
  selfRevision = 0
  rain = false
  thunder = false

  reset () {
    this.names.clear(); this.sample = null; this.partners.clear(); this.requests.clear()
    this.selfSleeping = null; this.selfRevision = 0; this.rain = false; this.thunder = false
  }

  start (packet: { rain_level?: number; lightning_level?: number }) {
    this.rain = (packet.rain_level ?? 0) > 0; this.thunder = (packet.lightning_level ?? 0) > 0
  }

  legacyTime (time: number, now: number) {
    if (Number.isFinite(time) && ![...this.names.values()].includes('minecraft:overworld')) this.sample = { time: Math.abs(time), paused: time < 0, at: now }
  }

  clocks (packet: { payload_type: string; clocks?: { id: bigint | string; name: string; time: number; paused: boolean }[]; sync_states?: { clock_id: bigint | string; time: number; paused: boolean }[] }, now: number) {
    if (packet.payload_type === 'initialize_registry') {
      this.names.clear(); this.sample = null
      for (const clock of packet.clocks ?? []) {
        this.names.set(String(clock.id), clock.name)
        if (clock.name === 'minecraft:overworld' && Number.isFinite(clock.time)) this.sample = { time: clock.time, paused: clock.paused, at: now }
      }
    } else if (packet.payload_type === 'sync_state') {
      for (const clock of packet.sync_states ?? []) if (this.names.get(String(clock.clock_id)) === 'minecraft:overworld' && Number.isFinite(clock.time)) {
        this.sample = { time: clock.time, paused: clock.paused, at: now }
      }
    }
  }

  weather (event: string | number) {
    if (event === 'start_rain' || event === 3001) this.rain = true
    if (event === 'stop_rain' || event === 3003) this.rain = false
    if (event === 'start_thunder' || event === 3002) this.thunder = true
    if (event === 'stop_thunder' || event === 3004) this.thunder = false
  }

  player (id: string, name: string, entries: Metadata[]) {
    const sleeping = sleepingFlag(entries)
    this.partners.set(id, { name, sleeping })
    if (sleeping === false) this.requests.delete(name)
  }
  remove (id: string) { this.partners.delete(id) }
  offline (name: string) {
    this.requests.delete(name)
    for (const [id, player] of this.partners) if (player.name === name) this.partners.delete(id)
  }
  metadata (id: string, self: string, entries: Metadata[]) {
    const relevant = entries.some(e => e.key === 'player_flags' || e.key === 'flags_extended')
    if (!relevant) return
    const sleeping = sleepingFlag(entries)
    if (id === self) { this.selfSleeping = sleeping; this.selfRevision++ }
    else {
      const player = this.partners.get(id)
      if (player) {
        player.sleeping = sleeping
        if (sleeping === false) this.requests.delete(player.name)
      }
    }
  }

  notice (packet: { type?: string; needs_translation?: boolean; source_name?: string; message?: string; parameters?: string[] }, selfName: string, now: number) {
    if (packet.type !== 'translation' || packet.needs_translation !== true || packet.source_name || packet.message !== 'chat.type.sleeping') return
    const name = packet.parameters?.[0]
    if (!name || name === selfName) return
    // A fresh structured server notice is a lease, not a permanent global sleep state.
    this.requests.set(name, now)
  }

  time (now: number) {
    if (!this.sample) return null
    return ((this.sample.time + (this.sample.paused ? 0 : Math.max(0, now - this.sample.at) / 50)) % 24000 + 24000) % 24000
  }

  sleepAllowed (now: number) {
    const time = this.time(now)
    return this.thunder || (time !== null && time >= 12542 && time < 23460)
  }

  hasPartner (now: number) {
    return [...this.partners.values()].some(player => player.sleeping === true) || [...this.requests.values()].some(at => now - at < 60000)
  }

  clearRequests () { this.requests.clear() }

  snapshot (now: number) {
    const time = this.time(now)
    const minutes = time === null ? null : Math.floor(((time + 6000) % 24000) * 1440 / 24000)
    return { time, clock: minutes === null ? null : String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0'), rain: this.rain, thunder: this.thunder }
  }

  skyLight (now: number) {
    const time = this.time(now)
    if (time === null) return null
    // Approximate the vanilla day/night curve; the UI labels all light values as estimates.
    const day = Math.max(0, Math.min(1, time < 12000 ? 1 : time < 14000 ? (14000 - time) / 2000 : time < 22000 ? 0 : (time - 22000) / 2000))
    return Math.round((4 + 11 * day) * (this.thunder ? .45 : this.rain ? .75 : 1))
  }
}
