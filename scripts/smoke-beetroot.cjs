// Read-only live scan. Stop the regular bot first: this script logs in with the same BOT_NAME.
// Run after pnpm build: node --env-file=.env scripts/smoke-beetroot.cjs
// Reports the nearest 100 beetroot blocks in loaded chunks; never navigates, harvests or plants.
const fs = require('node:fs')

async function scanBeetroot (state, registry) {
  const block = registry.blocksByName.beetroot
  if (!block) throw new Error('Registry has no beetroot block')
  const registryStates = []
  for (let stateId = block.minStateId; stateId <= block.maxStateId; stateId++) {
    const growth = registry.blockStates[stateId]?.states?.growth
    registryStates.push({ stateId, growth: growth?.value ?? growth ?? null })
  }
  const search = await state.searchBlocks('minecraft:beetroot', 100, state.position)
  const crops = search.hits.map(hit => {
    const stateId = state.stateAt(hit.x, hit.y, hit.z)
    const growth = registryStates.find(entry => entry.stateId === stateId)?.growth ?? null
    return { ...hit, stateId, runtimeId: state.blockRuntimeIdAt(hit.x, hit.y, hit.z), growth }
  })
  const growthCounts = {}
  for (const crop of crops) {
    const key = crop.growth ?? 'unknown'
    growthCounts[key] = (growthCounts[key] ?? 0) + 1
  }
  return { origin: search.origin, coverage: search.coverage, outcome: search.outcome,
    stale: search.stale || crops.some(crop => crop.growth === null), limitReached: search.limitReached,
    registryStates, growthCounts, crops }
}

async function main () {
  const { createClient } = require('bedrock-protocol')
  const { readConfig } = require('../dist/config.js')
  const { BotController } = require('../dist/bot.js')
  const config = readConfig()
  const registry = require('prismarine-registry')('bedrock_' + config.version)
  const report = { checkedAt: new Date().toISOString(), host: config.host, version: config.version, result: 'failed' }
  const bot = new BotController(config, options => createClient({
    host: options.host, port: options.port, version: options.version, username: options.username, transport: options.transport,
    offline: true, raknetBackend: 'jsp-raknet',
    skinData: { SelfSignedId: require('bedrock-protocol/src/datatypes/util').uuidFrom(options.username) },
    connectTimeout: 9000, pingTimeout: 5000, conLog: console.log,
    ...(options.transport === 'nethernet' ? { nethernet: { webrtcBackend: 'werift', signalling: 'http', serverKeyPath: './data/server-key.sha256', iceHost: options.iceHost } } : {})
  }))
  const until = async (predicate, ms) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (['dead', 'error'].includes(bot.state.status)) throw new Error('Bot ' + bot.state.status + ': ' + bot.state.lastError)
      if (bot.state.worldError) throw new Error(bot.state.worldError)
      if (predicate()) return true
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    return false
  }
  try {
    bot.start()
    bot.enqueue('connect')
    if (!await until(() => bot.state.status === 'spawned' && bot.state.position && Math.abs(bot.state.position.y) < 1000, 30000)) {
      throw new Error('Timed out waiting for spawn')
    }
    if (!await until(() => bot.state.coverage().complete, 20000)) console.log('Weltdaten nach 20 s unvollständig; scanne geladene Bereiche.')
    Object.assign(report, await scanBeetroot(bot.state, registry))
    report.result = report.stale ? 'stale' : report.crops.length ? 'found' : report.coverage.complete ? 'not-found' : 'unknown'
    console.log('Registry-Zustände (keine Live-Messung):', JSON.stringify(report.registryStates))
    console.table(report.crops)
    console.log('Beobachtete growth-Werte:', JSON.stringify(report.growthCounts))
    if (report.limitReached) console.log('Trefferlimit 100 erreicht; weitere Pflanzen sind möglich.')
    if (!report.coverage.complete) console.log('Unvollständige Weltdaten: keine Aussage über ungeladene Bereiche.')
    if (report.stale) console.log('Weltdaten während der Suche geändert; Scan bitte wiederholen.')
    console.log('Ein Scan zeigt Zustände, bestätigt aber allein nicht, welche Pflanze sichtbar ausgewachsen ist.')
  } catch (error) {
    report.error = error.stack || error.message
    console.error(report.error)
    process.exitCode = 1
  } finally {
    bot.stop()
    fs.mkdirSync('data', { recursive: true })
    fs.writeFileSync('data/beetroot-smoke-result.json', JSON.stringify(report, null, 2) + '\n')
    console.log('Report: data/beetroot-smoke-result.json, result ' + report.result)
    setTimeout(() => process.exit(), 500).unref()
  }
}

module.exports = { scanBeetroot }
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
