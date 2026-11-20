import { createClient, type ClientOptions } from 'bedrock-protocol'
import { readFileSync } from 'node:fs'
import { readConfig } from './config.js'
import { BotController } from './bot.js'
import { createWebServer } from './web.js'
import { MapArchive } from './map-archive.js'
import { PlaceStore } from './places.js'
import { SkinStore } from './skin.js'

const config = readConfig()
try { console.log('BDS operator key pin (SHA-256): ' + readFileSync('./data/server-key.sha256', 'utf8').trim()) }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
const skins = new SkinStore('./data/skin.json')
if (skins.error) console.error('Skin:', skins.error)
const bot = new BotController(config, options => {
  const clientOptions: ClientOptions & { skinData: Record<string, unknown> } = {
    host: options.host, port: options.port, version: options.version,
    username: options.username, transport: options.transport,
    offline: true, raknetBackend: 'jsp-raknet',
    // The skin is read at every connect, so an upload applies on the next connection.
    skinData: { SelfSignedId: require('bedrock-protocol/src/datatypes/util').uuidFrom(options.username), ...skins.connectSkinData() },
    connectTimeout: 9000, pingTimeout: 5000,
    conLog: (message: string) => console.log(message),
    ...(options.transport === 'nethernet' ? { nethernet: { webrtcBackend: 'werift' as const, signalling: 'http' as const, serverKeyPath: './data/server-key.sha256', iceHost: options.iceHost } } : {})
  }
  return createClient(clientOptions)
}, () => web.broadcast())
// Places share the map archive's server/world key.
const mapServer = JSON.stringify([config.host.toLowerCase(), config.port, config.transport])
const archive = new MapArchive('./data/maps', mapServer, config.mapWorldId)
const places = new PlaceStore('./data/places', mapServer, config.mapWorldId)
bot.state.onSurfaceTile = tile => archive.observe(tile)
const mapTimer = setInterval(() => { void archive.flush().catch(error => console.error('Map persistence:', error)) }, 5000)
mapTimer.unref()
const web = createWebServer(bot, archive, places, skins)
web.server.on('error', error => {
  console.error(error)
  bot.stop()
  web.close()
  clearInterval(mapTimer)
  void archive.flush().catch(error => console.error('Map persistence:', error))
  process.exitCode = 1
})
web.server.listen(config.webPort, config.webHost, () => {
  bot.start()
  const address = web.server.address()
  console.log(`MC Bot web listening on ${config.webHost}:${typeof address === 'object' && address ? address.port : config.webPort}; manual connect required`)
})
async function shutdown () {
  bot.stop()
  web.close()
  clearInterval(mapTimer)
  try { await archive.flush() }
  catch (error) { console.error('Map persistence:', error); process.exitCode = 1 }
  setTimeout(() => process.exit(process.exitCode ? Number(process.exitCode) : 0), 5000).unref()
}
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
