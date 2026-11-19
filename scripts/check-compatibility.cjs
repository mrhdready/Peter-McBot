const assert = require('node:assert/strict')
const fs = require('node:fs')
const registryLoader = require('prismarine-registry')
const chunkLoader = require('prismarine-chunk')
const { Versions } = require('bedrock-protocol/src/options')
const { createRequire } = require('node:module')
const registryRequire = createRequire(require.resolve('prismarine-registry'))
const protocolRequire = createRequire(require.resolve('bedrock-protocol'))

async function main () {
  let server = null
  if (process.env.BEDROCK_HOST) {
    const url = new URL('http://localhost/v1/join')
    url.hostname = process.env.BEDROCK_HOST
    url.port = process.env.BEDROCK_PORT || '19132'
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      server = await response.json()
    } catch (error) {
      server = { error: error.message, code: error.cause?.code }
    }
  }
  const versions = process.argv.slice(2)
  if (!versions.length) versions.push('1.26.65', '1.26.60', '1.21.130')
  const checks = []
  for (const version of versions) {
    // Verified against BDS 1.26.65 (protocol 2225) and its captured hashed subchunk.
    const dataVersion = version === '1.26.65' ? '1.26.60' : version
    const result = { version, dataVersion, exactVersionData: version === dataVersion, protocol: Versions[dataVersion] ?? null, registry: false, chunkLoader: false, roundtrip: false }
    try {
      if (server?.version === version && Number(server.protocol) !== result.protocol) throw new Error('Server protocol no longer matches the validated data version')
      const registry = registryLoader(`bedrock_${dataVersion}`)
      result.registry = true
      result.majorVersion = registry.version.majorVersion
      const Chunk = chunkLoader(registry)
      result.chunkLoader = true
      // Plain runtime IDs for the synthetic roundtrip; the captured test covers hashed IDs.
      registry.handleStartGame({ itemstates: [], block_network_ids_are_hashes: false })
      const original = new Chunk({ x: 0, z: 0 })
      const position = { x: 3, y: 64, z: 5 }
      original.setBlockStateId(position, registry.blocksByName.diamond_ore.defaultState)
      const payload = await original.networkEncodeSubChunkNoCache(4)
      const decoded = new Chunk({ x: 0, z: 0 })
      await decoded.networkDecodeSubChunkNoCache(4, payload)
      assert.equal(decoded.getBlock(position).name, 'diamond_ore')
      assert.equal(decoded.getBlockStateId(position), original.getBlockStateId(position))
      result.roundtrip = true
      result.bytes = payload.length
    } catch (error) {
      result.error = error.message
    }
    checks.push(result)
  }
  const fixture = require('../test/fixtures/bedrock-1.26.65-subchunk.json')
  const registry = registryLoader(`bedrock_${fixture.dataVersion}`)
  registry.handleStartGame({ itemstates: [], block_network_ids_are_hashes: fixture.hashed })
  const CapturedChunk = chunkLoader(registry)
  const captured = new CapturedChunk({ x: 0, z: 0 })
  await captured.networkDecodeSubChunkNoCache(fixture.y, Buffer.from(fixture.payload, 'base64'))
  let decodedBlocks = 0
  for (let x = 0; x < 16; x++) for (let y = 0; y < 16; y++) for (let z = 0; z < 16; z++) {
    assert.ok(captured.getBlock({ x, y: fixture.y * 16 + y, z }).name)
    decodedBlocks++
  }
  const report = {
    checkedAt: new Date().toISOString(),
    node: process.version,
    packages: Object.fromEntries(['bedrock-protocol', 'prismarine-chunk', 'prismarine-registry'].map(name => [name, require(`${name}/package.json`).version])),
    transitivePackages: { 'minecraft-data': registryRequire('minecraft-data/package.json').version, nethernet: protocolRequire('nethernet/package.json').version },
    server,
    protocolDataCandidates: server?.protocol ? Object.keys(Versions).filter(version => Versions[version] === Number(server.protocol)) : [],
    checks,
    capturedSubchunk: { serverVersion: fixture.serverVersion, hashed: fixture.hashed, decodedBlocks },
    limitation: 'Validated protocol 2225 and a recorded server subchunk, not every block state, add-on or server release.'
  }
  fs.writeFileSync('compatibility-result.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
  if (!checks[0].roundtrip || !checks[0].protocol || server?.error) process.exitCode = 1
}
main().catch(error => { console.error(error); process.exitCode = 1 })
