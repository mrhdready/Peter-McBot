const { test } = require('node:test')
const assert = require('node:assert/strict')
const fixture = require('./fixtures/bedrock-1.26.65-subchunk.json')

test('uniform subchunks resolve signed hashed IDs and reject unknown runtime IDs', async () => {
  const registry = require('prismarine-registry')('bedrock_1.26.60')
  registry.handleStartGame({ itemstates: [], block_network_ids_are_hashes: true })
  const Chunk = require('prismarine-chunk')(registry)
  const Stream = require('prismarine-chunk/src/bedrock/common/Stream')
  const [hash, block] = Object.entries(registry.blocksByRuntimeId).find(([hash, block]) => Number(hash) < 0 && block.name !== 'air')
  const payload = runtimeId => {
    const stream = new Stream()
    for (const value of [9, 1, 0, 1]) stream.writeUInt8(value)
    stream.writeZigZagVarInt(runtimeId)
    return stream.getBuffer()
  }
  const chunk = new Chunk({ x: 0, z: 0 })
  await chunk.networkDecodeSubChunkNoCache(0, payload(Number(hash)))
  assert.equal(chunk.getBlockStateId({ x: 0, y: 0, z: 0 }), block.stateId)
  assert.equal(chunk.getBlockStateId({ x: 15, y: 15, z: 15 }), block.stateId)
  assert.equal(registry.blocksByRuntimeId[1], undefined)
  await assert.rejects(chunk.networkDecodeSubChunkNoCache(0, payload(1)), /Unknown block runtime ID/)
})

test('BDS 1.26.65 captured subchunk decodes all 4096 cells using hashed runtime IDs', async () => {
  const registry = require('prismarine-registry')('bedrock_' + fixture.dataVersion)
  assert.equal(registry.version.majorVersion, '1.26')
  assert.equal(fixture.protocol, registry.version.version)
  registry.handleStartGame({ itemstates: [], block_network_ids_are_hashes: fixture.hashed })
  const Chunk = require('prismarine-chunk')(registry)
  const chunk = new Chunk({ x: 0, z: 0 })
  await chunk.networkDecodeSubChunkNoCache(fixture.y, Buffer.from(fixture.payload, 'base64'))
  const counts = {}
  for (let x = 0; x < 16; x++) {
    for (let y = 0; y < 16; y++) {
      for (let z = 0; z < 16; z++) {
        const block = chunk.getBlock({ x, y: fixture.y * 16 + y, z })
        assert.ok(block.name && registry.blocksByName[block.name])
        counts[block.name] = (counts[block.name] || 0) + 1
      }
    }
  }
  assert.deepEqual(counts, {
    deepslate: 1058, air: 810, stone: 1399, diorite: 273, water: 17,
    iron_ore: 23, redstone_ore: 3, gold_ore: 6, andesite: 264,
    deepslate_iron_ore: 13, dirt: 19, deepslate_lapis_ore: 7,
    lapis_ore: 4, granite: 199, deepslate_redstone_ore: 1
  })
})
