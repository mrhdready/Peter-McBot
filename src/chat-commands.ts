/*
 * Chat commands: a chat or whisper line that starts with the bot's name ("Peter go Haus", "@Peter, find diamond_ore")
 * is a command. Replies go to public chat. Navigation runs through the bot's command queue like a web request.
 */
import type { BotController, NavigationOrigin } from './bot.js'
import type { PlaceStore, Poi } from './places.js'
import type { Position } from './state.js'
import { WorldError, dimensionId } from './world.js'

const COOLDOWN_MS = 2000
const COME_DISTANCE = 2
const HELP = 'Befehle: hallo, go <Wegpunkt>, come, find <Block>, stop'
const log = (message: string) => console.log('[chat] ' + message)
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export class ChatCommands {
  private prefix: RegExp
  private lastCommand = new Map<string, number>()

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
    return players.find(player => player.name === name) ?? players.find(player => player.name.toLowerCase() === name.toLowerCase()) ?? null
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

  private stop () {
    const active = ['planning', 'moving'].includes(this.bot.state.navigation.status)
    if (!active) return this.say('Ich laufe gerade nicht.')
    // A chat-started run reports its own end; only a web UI run needs a reply here.
    const fromChat = this.bot.navigationOrigin !== null
    this.bot.enqueue('stop_navigation')
    if (!fromChat) this.say('Angehalten.')
  }

  private navigationEnded (origin: NavigationOrigin | null, status: string, message: string | null) {
    if (!origin) return
    if (status === 'arrived') this.say(`Angekommen bei ${origin.label}.`)
    else if (status === 'error') this.say(`Weg zu ${origin.label} fehlgeschlagen: ${message ?? 'unbekannter Fehler'}`)
    else this.say(`Weg zu ${origin.label} abgebrochen.`)
  }
}
