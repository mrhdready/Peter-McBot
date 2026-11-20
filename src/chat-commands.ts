/*
 * Chat commands: a chat or whisper line that starts with the bot's name ("Peter go Haus", "@Peter, find diamond_ore")
 * is a command. Replies go to public chat. Navigation runs through the bot's command queue like a web request.
 */
import type { BotController, ChestResult, ChestStop, NavigationOrigin } from './bot.js'
import type { PlaceStore, Poi } from './places.js'
import type { Position } from './state.js'
import { WorldError, dimensionId } from './world.js'
import { CHEST_CONTAINER, nextTransfer, playerContainer, shortName, type Slot, type TransferStep } from './inventory.js'

type PendingGive = { token: number; player: string; name: string; count: number; requested: number | null }
// A put/get run over up to MAX_CHESTS chests. `name` is the full item name; for get it is resolved in the first chest that has it,
// and null for "put all". `query` is what the player typed.
type ChestRun = {
  token: number; player: string; mode: 'put' | 'get'; all: boolean; query: string; name: string | null; requested: number | null
  moved: number; opened: number; tried: number; candidates: Position[]; lastStop: ChestStop | null; problem: string | null
}

const COOLDOWN_MS = 2000
const COME_DISTANCE = 2
// After walking up, the receiver must still be this close (horizontally) or the bot keeps the items.
const GIVE_REACH = 4
const INVENTORY_LINES = 8
const HELP = 'Befehle: hallo, go <Wegpunkt>, come, find <Block>, inventory, give <Item> [Anzahl], put <Item>|all [Anzahl], get <Item> [Anzahl], stop'
// Every chest kind counts; ender chests, barrels and shulker boxes do not.
export const CHEST_IDS = ['chest', 'trapped_chest', 'copper_chest', 'exposed_copper_chest', 'weathered_copper_chest', 'oxidized_copper_chest',
  'waxed_copper_chest', 'waxed_exposed_copper_chest', 'waxed_weathered_copper_chest', 'waxed_oxidized_copper_chest']
// Interaction reach from the bot's eyes to the chest centre, with some margin below the vanilla 6 blocks.
const CHEST_REACH = 4.5
const MAX_CHESTS = 5
// Unreachable chests do not count against MAX_CHESTS; this bounds how many are tried at all.
const MAX_CANDIDATES = 10
const MAX_AMOUNT = 2304
const chestLabel = (count: number) => count === 1 ? '1 Kiste' : `${count} Kisten`
const log = (message: string) => console.log('[chat] ' + message)
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export class ChatCommands {
  private prefix: RegExp
  private lastCommand = new Map<string, number>()
  // The give run whose navigation is under way; a newer one replaces it.
  private pendingGive: PendingGive | null = null
  private giveToken = 0
  // The running put/get run; a newer one or any other navigation ends it.
  private chestRun: ChestRun | null = null
  private chestToken = 0

  constructor (private bot: BotController, private places: PlaceStore | null, private reach: number, name: string, private now = Date.now) {
    // The name may contain spaces; it must be followed by optional "," or ":" and then whitespace or the end.
    this.prefix = new RegExp('^\\s*@?' + escape(name).replace(/ /g, '\\s+') + '(?:\\s*[,:])?(?:\\s+(.*))?$', 'is')
    bot.onChat = (sender, message) => { void this.handle(sender, message) }
    bot.onNavigationEnd = (origin, status, message) => this.navigationEnded(origin, status, message)
  }

  async handle (sender: string, message: string) {
    log(`<${sender}> ${message}`)
    const match = this.prefix.exec(message)
    if (!match) return
    const now = this.now()
    if (now - (this.lastCommand.get(sender) ?? -Infinity) < COOLDOWN_MS) return
    this.lastCommand.set(sender, now)
    const [word = '', ...rest] = (match[1] ?? '').trim().split(/\s+/)
    const argument = rest.join(' ')
    try {
      switch (word.toLowerCase()) {
        case 'hallo': case 'hi': case 'hey': return this.say(`Hallo ${sender}!`)
        case 'go': return await this.go(sender, argument)
        case 'come': return this.come(sender)
        case 'find': return await this.find(sender, argument)
        case 'inventory': case 'inv': return this.inventory()
        case 'give': return this.give(sender, rest)
        case 'put': return await this.put(sender, rest)
        case 'get': return await this.get(sender, rest)
        case 'stop': return this.stop()
        default: return this.say(HELP)
      }
    } catch (error) {
      log(`Fehler bei "${message}": ${error instanceof Error ? error.message : String(error)}`)
      this.say('Das hat nicht geklappt.')
    }
  }

  private say (text: string) {
    log('> ' + text)
    this.bot.say(text)
  }

  private player (name: string) {
    const players = [...this.bot.state.players.values()]
    // Chat sender names may carry formatting codes (§x) or padding that add_player names do not.
    const plain = (text: string) => text.replace(/§./g, '').trim().toLowerCase()
    const found = players.find(player => player.name === name) ?? players.find(player => plain(player.name) === plain(name)) ?? null
    if (!found) log(`Absender ${JSON.stringify(name)} nicht unter sichtbaren Spielern: ${JSON.stringify(players.map(player => player.name))}`)
    return found
  }

  /** Starts a navigation if the target lies within the loaded radius; answers either way. */
  private navigate (x: number, z: number, origin: NavigationOrigin) {
    const p = this.bot.state.position
    if (!p) return this.say('Meine Position ist gerade unbekannt.')
    const distance = Math.round(Math.hypot(x - p.x, z - p.z))
    if (distance > this.reach) return this.say(`${origin.label} ist zu weit weg (${distance} Blöcke).`)
    if (!this.bot.enqueue({ type: 'navigate', x, z, origin })) return this.say('Ich bin gerade beschäftigt, versuch es gleich nochmal.')
    this.say(`Unterwegs zu ${origin.label} (${distance} Blöcke).`)
  }

  private async go (sender: string, name: string) {
    if (!name) return this.say('Wohin? go <Wegpunkt>')
    if (!this.places) return this.say('Wegpunkte sind nicht verfügbar.')
    const dimension = dimensionId(this.bot.state.dimension)
    if (dimension === null) return this.say('Meine Dimension ist gerade unbekannt.')
    const wanted = name.replace(/\s+/g, ' ').toLowerCase()
    const { pois } = await this.places.list(dimension)
    let found: Poi[] = pois.filter(poi => poi.name.toLowerCase() === wanted)
    if (!found.length) found = pois.filter(poi => poi.name.toLowerCase().startsWith(wanted))
    if (!found.length) return this.say(`Wegpunkt "${name}" kenne ich nicht.`)
    if (found.length > 1) return this.say('Mehrdeutig: ' + found.slice(0, 5).map(poi => poi.name).join(', ') + (found.length > 5 ? ', …' : ''))
    this.navigate(found[0].x, found[0].z, { player: sender, label: found[0].name })
  }

  private come (sender: string) {
    const player = this.player(sender)
    const p = this.bot.state.position
    if (!player) return this.say(`Ich sehe dich nicht, ${sender}.`)
    if (!p) return this.say('Meine Position ist gerade unbekannt.')
    // Stop COME_DISTANCE blocks short on the line from the bot, so the bot does not walk into the player.
    const dx = player.position.x - p.x; const dz = player.position.z - p.z; const d = Math.hypot(dx, dz)
    if (d <= COME_DISTANCE + .5) return this.say('Ich bin schon da.')
    const x = Math.floor(player.position.x - dx / d * COME_DISTANCE); const z = Math.floor(player.position.z - dz / d * COME_DISTANCE)
    this.navigate(x, z, { player: sender, label: sender })
  }

  private async find (sender: string, blockId: string) {
    if (!blockId) return this.say('Was soll ich suchen? find <Block>')
    const id = blockId.toLowerCase()
    const player = this.player(sender)
    const origin: Position | null = player ? player.position : this.bot.state.position
    const from = player ? 'von dir' : 'von mir'
    const result = await this.bot.state.searchBlocks(id, 1, origin).catch((error: unknown) => {
      if (!(error instanceof WorldError)) throw error
      if (error.status === 429) this.say('Suche läuft schon, versuch es gleich nochmal.')
      else if (error.message.startsWith('Unknown block ID')) this.say(`Den Block ${id} kenne ich nicht.`)
      else if (error.message === 'Invalid block ID') this.say(`"${blockId}" ist keine gültige Block-ID.`)
      else this.say('Suche nicht möglich: ' + error.message)
      return null
    })
    if (!result) return
    const name = result.blockId.replace(/^minecraft:/, '')
    const hit = result.hits[0]
    if (hit) return this.say(`Nächstes ${name}: ${hit.x} ${hit.y} ${hit.z} (${Math.round(hit.distance)} Blöcke ${from}).`)
    this.say(result.outcome === 'unknown'
      ? `Kein ${name} gefunden; die Umgebung ist noch nicht vollständig geladen.`
      : `Kein ${name} im geladenen Bereich.`)
  }

  private inventory () {
    const inventory = this.bot.state.inventory
    if (!inventory.known) return this.say('Mein Inventar ist noch unbekannt.')
    const items = inventory.items()
    if (!items.length) return this.say('Mein Inventar ist leer.')
    const shown = items.slice(0, INVENTORY_LINES).map(item => `${shortName(item.name)} ×${item.count}`)
    this.say('Inventar: ' + shown.join(', ') + (items.length > INVENTORY_LINES ? ` … +${items.length - INVENTORY_LINES} weitere` : ''))
  }

  /** give <item> [count]: walks up to the sender like come, then throws the items towards them. */
  private give (sender: string, words: string[]) {
    const amountText = words.length > 1 && /^\d+$/.test(words.at(-1)!) ? words.pop()! : null
    const query = words.join(' ').toLowerCase()
    if (!query) return this.say('Was soll ich geben? give <Item> [Anzahl]')
    const requested = amountText === null ? null : Number(amountText)
    if (requested !== null && (requested < 1 || requested > 2304)) return this.say('Die Anzahl muss zwischen 1 und 2304 liegen.')
    if (!this.bot.state.inventory.known) return this.say('Mein Inventar ist noch unbekannt.')
    const items = this.bot.state.inventory.items()
    const wanted = shortName(query)
    let found = items.filter(item => shortName(item.name) === wanted)
    if (!found.length) found = items.filter(item => shortName(item.name).startsWith(wanted))
    if (!found.length) return this.say(`Ich habe kein ${wanted}.`)
    if (found.length > 1) return this.say('Mehrdeutig: ' + found.slice(0, 5).map(item => shortName(item.name)).join(', ') + (found.length > 5 ? ', …' : ''))
    const item = found[0]
    const player = this.player(sender)
    const p = this.bot.state.position
    if (!player) return this.say(`Ich sehe dich nicht, ${sender}.`)
    if (!p) return this.say('Meine Position ist gerade unbekannt.')
    const pending = { token: ++this.giveToken, player: sender, name: item.name, count: requested ?? item.count, requested }
    const dx = player.position.x - p.x; const dz = player.position.z - p.z; const d = Math.hypot(dx, dz)
    if (d <= COME_DISTANCE + .5) return this.handOver(pending)
    const x = Math.floor(player.position.x - dx / d * COME_DISTANCE); const z = Math.floor(player.position.z - dz / d * COME_DISTANCE)
    this.pendingGive = pending
    this.navigate(x, z, { player: sender, label: sender, give: pending.token })
  }

  /** Throws the items if the receiver is still close; answers with what the server confirmed. */
  private handOver (pending: PendingGive) {
    const player = this.player(pending.player)
    const p = this.bot.state.position
    if (!player || !p || Math.hypot(player.position.x - p.x, player.position.z - p.z) > GIVE_REACH) {
      return this.say(`Du bist weggelaufen, ${pending.player}. Ich behalte die Sachen.`)
    }
    const name = shortName(pending.name)
    const available = this.bot.state.inventory.items().find(item => item.name === pending.name)?.count ?? 0
    if (!available) return this.say(`Ich habe kein ${name} mehr.`)
    const count = Math.min(pending.count, available)
    void this.bot.dropItems(pending.name, count, player.position).then(dropped => {
      this.say(pending.requested !== null && dropped < pending.requested ? `Ich habe nur ${dropped} ${name}, hier sind sie.` : `Hier, ${dropped} ${name}.`)
    }, (error: unknown) => {
      log(`Werfen fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`)
      this.say('Werfen fehlgeschlagen.')
    })
  }

  /** put <item> [count] | put all: stores items in the nearest chests. */
  private async put (sender: string, words: string[]) {
    if (words.length === 1 && words[0].toLowerCase() === 'all') {
      if (!this.bot.state.inventory.known) return this.say('Mein Inventar ist noch unbekannt.')
      if (!this.bot.state.inventory.items().length) return this.say('Mein Inventar ist leer.')
      return this.startChestRun({ player: sender, mode: 'put', all: true, query: 'all', name: null, requested: null })
    }
    const parsed = this.amount(words, 'Was soll ich ablegen? put <Item>|all [Anzahl]')
    if (!parsed) return
    if (!this.bot.state.inventory.known) return this.say('Mein Inventar ist noch unbekannt.')
    const items = this.bot.state.inventory.items()
    const wanted = shortName(parsed.query)
    let found = items.filter(item => shortName(item.name) === wanted)
    if (!found.length) found = items.filter(item => shortName(item.name).startsWith(wanted))
    if (!found.length) return this.say(`Ich habe kein ${wanted}.`)
    if (found.length > 1) return this.say('Mehrdeutig: ' + found.slice(0, 5).map(item => shortName(item.name)).join(', ') + (found.length > 5 ? ', …' : ''))
    await this.startChestRun({ player: sender, mode: 'put', all: false, query: wanted, name: found[0].name, requested: parsed.requested })
  }

  /** get <item> [count]: fetches items from the nearest chests; the name is matched against each chest's content. */
  private async get (sender: string, words: string[]) {
    const parsed = this.amount(words, 'Was soll ich holen? get <Item> [Anzahl]')
    if (!parsed) return
    if (!this.bot.state.inventory.known) return this.say('Mein Inventar ist noch unbekannt.')
    await this.startChestRun({ player: sender, mode: 'get', all: false, query: shortName(parsed.query), name: null, requested: parsed.requested })
  }

  // "<item words> [count]" → the item query and the count (null for all); answers and returns null when invalid.
  private amount (words: string[], usage: string) {
    const rest = [...words]
    const amountText = rest.length > 1 && /^\d+$/.test(rest.at(-1)!) ? rest.pop()! : null
    const query = rest.join(' ').toLowerCase()
    if (!query || query === 'all') { this.say(usage); return null }
    const requested = amountText === null ? null : Number(amountText)
    if (requested !== null && (requested < 1 || requested > MAX_AMOUNT)) { this.say(`Die Anzahl muss zwischen 1 und ${MAX_AMOUNT} liegen.`); return null }
    return { query, requested }
  }

  private async startChestRun (base: Pick<ChestRun, 'player' | 'mode' | 'all' | 'query' | 'name' | 'requested'>) {
    const p = this.bot.state.position
    if (!p) return this.say('Meine Position ist gerade unbekannt.')
    const result = await this.bot.state.searchBlocks(CHEST_IDS, 20, p).catch((error: unknown) => {
      if (!(error instanceof WorldError)) throw error
      this.say(error.status === 429 ? 'Suche läuft schon, versuch es gleich nochmal.' : 'Kistensuche nicht möglich: ' + error.message)
      return null
    })
    if (!result) return
    const candidates = result.hits.filter(hit => Math.hypot(hit.x + .5 - p.x, hit.z + .5 - p.z) <= this.reach).map(({ x, y, z }) => ({ x, y, z }))
    if (!candidates.length) return this.say(result.outcome === 'unknown' ? 'Keine Kiste gefunden; die Umgebung ist noch nicht vollständig geladen.' : 'Keine Kiste in der Nähe.')
    // A new run replaces the old one; the old one's callbacks see the token change and stay silent.
    if (this.chestRun) this.bot.cancelChest()
    const run: ChestRun = { ...base, token: ++this.chestToken, moved: 0, opened: 0, tried: 0, candidates, lastStop: null, problem: null }
    this.chestRun = run
    log(`[chest] ${run.mode} ${run.query} (${run.requested ?? 'alles'}): ${candidates.length} Kiste(n) in Reichweite.`)
    this.nextChest(run)
  }

  // Walks to the next candidate, or opens it at once when it is already within reach.
  private nextChest (run: ChestRun): void {
    if (this.chestRun !== run) return
    if (run.opened >= MAX_CHESTS || run.tried >= MAX_CANDIDATES || !run.candidates.length) return this.finishChestRun(run)
    const chest = run.candidates.shift()!
    run.tried++
    const p = this.bot.state.position
    if (!p) return this.finishChestRun(run, 'Meine Position ist gerade unbekannt.')
    if (Math.hypot(chest.x + .5 - p.x, chest.y + .5 - p.y, chest.z + .5 - p.z) <= CHEST_REACH) return this.openChest(run, chest)
    // Stand on the nearest free neighbour column (also diagonal), with the feet at most one block above or below the chest.
    let best: { x: number; z: number; distance: number } | null = null
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const x = chest.x + dx; const z = chest.z + dz
      if (![chest.y, chest.y - 1, chest.y + 1].some(feetY => this.bot.state.canStandAt(x + .5, z + .5, feetY))) continue
      const distance = Math.hypot(x + .5 - p.x, z + .5 - p.z)
      if (!best || distance < best.distance) best = { x, z, distance }
    }
    if (!best) { log(`[chest] Kein Standplatz an (${chest.x}, ${chest.y}, ${chest.z}); nächste Kiste.`); return this.nextChest(run) }
    run.candidates.unshift(chest)
    if (!this.bot.enqueue({ type: 'navigate', x: best.x, z: best.z, origin: { player: run.player, label: `Kiste ${chest.x} ${chest.y} ${chest.z}`, chest: run.token } })) {
      return this.finishChestRun(run, 'Ich bin gerade beschäftigt, versuch es gleich nochmal.')
    }
  }

  private chestNavigationEnded (token: number, status: string): void {
    const run = this.chestRun
    if (!run || run.token !== token) return
    const chest = run.candidates.shift()!
    if (status === 'arrived') return this.openChest(run, chest)
    if (status === 'error') { log(`[chest] Kiste (${chest.x}, ${chest.y}, ${chest.z}) nicht erreichbar; nächste.`); return this.nextChest(run) }
    this.finishChestRun(run, 'Abgebrochen.')
  }

  private openChest (run: ChestRun, chest: Position): void {
    this.bot.useChest(chest, (inventory, window, moved) => this.chestStep(run, inventory.slotList(), window.slots, moved)).then(
      result => this.chestDone(run, chest, result),
      (error: unknown) => this.finishChestRun(run, 'Abgebrochen: ' + (error instanceof Error ? error.message : String(error))))
  }

  // The next move inside an open chest. For get, the item name is resolved against this chest's content first.
  private chestStep (run: ChestRun, own: (Slot | null)[], chest: (Slot | null)[], moved: number): TransferStep {
    const left = run.requested === null ? Infinity : run.requested - run.moved - moved
    if (run.mode === 'put') return nextTransfer(own, playerContainer, chest, () => CHEST_CONTAINER, run.all ? null : run.name, left)
    if (run.name === null) {
      const names = [...new Set(chest.filter((slot): slot is Slot => slot !== null).map(slot => slot.name))]
      let found = names.filter(name => shortName(name) === run.query)
      if (!found.length) found = names.filter(name => shortName(name).startsWith(run.query))
      if (!found.length) return { stop: 'source_empty' }
      if (found.length > 1) { run.problem = 'Mehrdeutig: ' + found.slice(0, 5).map(shortName).join(', ') + (found.length > 5 ? ', …' : ''); return { stop: 'done' } }
      run.name = found[0]
    }
    return nextTransfer(chest, () => CHEST_CONTAINER, own, playerContainer, run.name, left)
  }

  private chestDone (run: ChestRun, chest: Position, result: ChestResult): void {
    if (this.chestRun !== run) return
    run.lastStop = result.stop
    if (!result.opened) {
      if (result.stop === 'cancelled') return this.finishChestRun(run, 'Abgebrochen.')
      log(`[chest] Kiste (${chest.x}, ${chest.y}, ${chest.z}) ließ sich nicht öffnen; nächste.`)
      return this.nextChest(run)
    }
    run.opened++
    run.moved += result.moved
    // A double chest opens both halves; the other half is no longer a candidate of its own.
    if (result.size > 27) run.candidates = run.candidates.filter(other => other.y !== chest.y || Math.abs(other.x - chest.x) + Math.abs(other.z - chest.z) !== 1)
    if (run.problem) return this.finishChestRun(run, run.problem, false)
    const more = run.candidates.length > 0 && run.opened < MAX_CHESTS && run.tried < MAX_CANDIDATES
    const item = run.name ? shortName(run.name) : run.query
    switch (result.stop) {
      case 'done': return this.finishChestRun(run)
      case 'target_full':
        if (run.mode === 'get') { this.say('Mein Inventar ist voll.'); return this.finishChestRun(run) }
        if (more) this.say('Kiste voll, versuche die nächste.')
        return this.nextChest(run)
      case 'source_empty':
        if (run.mode === 'put') return this.finishChestRun(run)
        // Without a count the bot collects from every chest, so running dry in one is no news.
        if (more && run.requested !== null) this.say(result.moved ? `Hier nur ${result.moved} ${item}, versuche die nächste.` : `Hier kein ${item}, versuche die nächste.`)
        return this.nextChest(run)
      case 'cancelled': return this.finishChestRun(run, 'Abgebrochen.')
      case 'closed': return this.finishChestRun(run, 'Die Kiste wurde geschlossen.')
      case 'rejected': return this.finishChestRun(run, 'Der Server hat das Umlagern abgelehnt.')
      default: return this.finishChestRun(run, 'Die Kiste hat nicht geantwortet.')
    }
  }

  // Ends the run with a summary of what the server confirmed; `reason` explains an early end.
  private finishChestRun (run: ChestRun, reason?: string, summarize = true) {
    if (this.chestRun !== run) return
    this.chestRun = null
    if (!summarize) { log(`[chest] Ende: ${reason}`); return this.say(reason ?? '') }
    const item = run.name ? shortName(run.name) : run.query
    const chests = chestLabel(run.opened)
    let summary: string
    if (run.mode === 'put') {
      const what = run.all ? `${run.moved} Gegenstände` : `${run.moved} ${item}`
      if (!run.opened) summary = 'Ich komme an keine Kiste heran.'
      else if (run.requested !== null && run.moved < run.requested && run.lastStop === 'source_empty') summary = `Ich hatte nur ${run.moved} ${item}, in ${chests} abgelegt.`
      else if (run.requested !== null && run.moved < run.requested) summary = `Nur ${run.moved} von ${run.requested} ${item} abgelegt (${chests}).`
      else summary = `${what} in ${chests} abgelegt.` + (run.lastStop === 'target_full' ? ' Der Rest passt nicht mehr.' : '')
    } else if (!run.opened) summary = 'Ich komme an keine Kiste heran.'
    else if (!run.moved) summary = run.lastStop === 'target_full' ? 'Nichts geholt.' : `Kein ${item} gefunden (${chests} durchsucht).`
    else if (run.requested !== null && run.moved < run.requested) summary = `Nur ${run.moved} von ${run.requested} ${item} geholt (${chests} durchsucht).`
    else summary = `${run.moved} ${item} aus ${chests} geholt.`
    log(`[chest] Ende: ${summary}${reason ? ' (' + reason + ')' : ''}`)
    this.say(reason ? `${reason} ${summary}` : summary)
  }

  private stop () {
    // A put/get run ends via its navigation or chest callbacks, which report what was moved.
    if (this.chestRun) { this.bot.enqueue('stop_navigation'); return }
    const active = ['planning', 'moving'].includes(this.bot.state.navigation.status)
    if (!active) return this.say('Ich laufe gerade nicht.')
    // A chat-started run reports its own end; only a web UI run needs a reply here.
    const fromChat = this.bot.navigationOrigin !== null
    this.bot.enqueue('stop_navigation')
    if (!fromChat) this.say('Angehalten.')
  }

  private navigationEnded (origin: NavigationOrigin | null, status: string, message: string | null) {
    if (!origin) return
    if (origin.chest !== undefined) return this.chestNavigationEnded(origin.chest, status)
    if (origin.give !== undefined) {
      // Only the newest give run may still hand over; it ends with the hand-over instead of an arrival line.
      const pending = this.pendingGive?.token === origin.give ? this.pendingGive : null
      if (pending) this.pendingGive = null
      if (pending && status === 'arrived') return this.handOver(pending)
    }
    if (status === 'arrived') this.say(`Angekommen bei ${origin.label}.`)
    else if (status === 'error') this.say(`Weg zu ${origin.label} fehlgeschlagen: ${message ?? 'unbekannter Fehler'}`)
    else this.say(`Weg zu ${origin.label} abgebrochen.`)
  }
}
