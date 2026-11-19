const { test } = require('node:test')
const assert = require('node:assert/strict')
const fixture = require('./fixtures/bedrock-1.26.65-subchunk.json')
const { WorldState } = require('../dist/state.js')
const registry = require('prismarine-registry')('bedrock_1.26.60')
registry.handleStartGame({ itemstates: [], block_network_ids_are_hashes: true })
const hashFor = name => Number(Object.entries(registry.blocksByRuntimeId).find(([, b]) => b.stateId === registry.blocksByName[name].defaultState)[0]) >>> 0
const waitFor = async predicate => {
  const end = Date.now() + 10000
  while (!predicate()) {
    if (Date.now() > end) assert.fail('Worker did not finish: ' + String(predicate))
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
async function setup (t, position = { x: -0.5, y: 8, z: -0.5 }) {
  const world = new WorldState(4)
  t.after(() => world.resetWorld())
  world.beginWorld('overworld', true)
  world.position = position
  world.setCenter(position)
  await waitFor(() => world.coverage().ready)
  return world
}
function column (world, x = -1, z = -1) {
  world.receiveColumn({ x, z, dimension: 0, cache_enabled: false })
  world.requestSubchunks(() => {})
}
function receive (world, result, payload, x = -1, z = -1, y = 0) {
  world.receiveSubchunks({ dimension: 0, cache_enabled: false, origin: { x, y, z }, entries: [{ dx: 0, dy: 0, dz: 0, result, payload }] })
}

test('real hashed subchunk produces nearest block coordinates across negative chunk boundaries', async t => {
  const world = await setup(t)
  column(world)
  receive(world, 'success', Buffer.from(fixture.payload, 'base64'))
  await waitFor(() => world.coverage().knownSubchunks === 1)
  const result = await world.searchBlocks('minecraft:iron_ore', 5, world.position)
  assert.equal(result.coverage.complete, false)
  assert.equal(result.outcome, 'found')
  const Chunk = require('prismarine-chunk')(registry)
  const decoded = new Chunk({ x: 0, z: 0 })
  await decoded.networkDecodeSubChunkNoCache(0, Buffer.from(fixture.payload, 'base64'))
  const expected = []
  for (let x = 0; x < 16; x++) for (let y = 0; y < 16; y++) for (let z = 0; z < 16; z++) {
    if (decoded.getBlock({ x, y, z }).name !== 'iron_ore') continue
    expected.push({ x: x - 16, y, z: z - 16, distance: Math.hypot(x - 16 - world.position.x, y - world.position.y, z - 16 - world.position.z) })
  }
  expected.sort((a, b) => a.distance - b.distance || a.x - b.x || a.y - b.y || a.z - b.z)
  assert.deepEqual(result.hits, expected.slice(0, 5))
  assert.equal((await world.searchBlocks('diamond_ore', 10, world.position)).outcome, 'unknown')
  const air = await world.searchBlocks('air', 100, world.position)
  assert.ok(air.hits.every(hit => decoded.getBlockStateId({ x: hit.x + 16, y: hit.y, z: hit.z + 16 }) === registry.blocksByName.air.defaultState))
  world.receiveColumn({ x: -1, z: -1, dimension: 0, cache_enabled: false })
  assert.equal(world.coverage().knownSubchunks, 0, 'A replacement column invalidates its old block data')
})

test('block updates received during worker decoding survive the older snapshot', async t => {
  const world = await setup(t)
  column(world)
  receive(world, 'success', Buffer.from(fixture.payload, 'base64'))
  world.updateBlock({ x: -1, y: 2, z: -16 }, hashFor('diamond_ore'))
  await waitFor(() => world.coverage().knownSubchunks === 1)
  const result = await world.searchBlocks('diamond_ore', 10, world.position)
  assert.deepEqual(result.hits.map(({ x, y, z }) => ({ x, y, z })), [{ x: -1, y: 2, z: -16 }])
  world.updateBlock({ x: -1, y: 2, z: -16 }, hashFor('air'))
  assert.equal((await world.searchBlocks('diamond_ore', 10, world.position)).hits.length, 0)
  world.updateBlock({ x: -1, y: 2, z: -16 }, hashFor('water'), 1)
  assert.ok((await world.searchBlocks('water', 100, world.position)).hits.some(hit => hit.x === -1 && hit.y === 2 && hit.z === -16))
})

test('unknown sections stay unknown; all-air replies and complete coverage have distinct absence results', async t => {
  const world = await setup(t, { x: 0, y: 8, z: 0 })
  world.updateBlock({ x: 0, y: 0, z: 0 }, hashFor('stone'))
  assert.equal(world.coverage().knownSubchunks, 0)
  for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) {
    world.receiveColumn({ x, z, dimension: 0, cache_enabled: false })
  }
  assert.equal(world.chunks.size, 49)
  assert.equal((await world.searchBlocks('diamond_ore', 3, world.position)).outcome, 'unknown')
  for (let tick = 0; tick < 200 && !world.coverage().complete; tick++) {
    world.requestSubchunks((name, packet) => {
      assert.equal(name, 'subchunk_request')
      world.receiveSubchunks({ dimension: 0, cache_enabled: false, origin: packet.origin,
        entries: packet.requests.map(p => ({ dx: p.x, dy: p.y, dz: p.z, result: 'success_all_air' })) })
    })
  }
  assert.equal(world.coverage().complete, true)
  assert.equal(world.coverage().knownSubchunks, 49 * 24)
  assert.equal((await world.searchBlocks('diamond_ore', 3, world.position)).outcome, 'not_found')
  assert.equal((await world.searchBlocks('air', 3, world.position)).hits[0].distance, 0)
  world.updateBlock({ x: 0, y: 8, z: 0 }, hashFor('diamond_ore'))
  assert.equal((await world.searchBlocks('diamond_ore', 3, world.position)).hits.length, 1)
  assert.ok((await world.searchBlocks('air', 3, world.position)).hits.every(hit => hit.x !== 0 || hit.y !== 8 || hit.z !== 0))
  world.updateBlock({ x: 0, y: 8, z: 0 }, 1)
  assert.equal(world.coverage().complete, false)
  assert.match(world.worldError, /Unknown/)
})

test('pruning, dimension reset and disconnect cannot resurrect in-flight chunks', async t => {
  const world = await setup(t)
  column(world)
  receive(world, 'success', Buffer.from(fixture.payload, 'base64'))
  world.setCenter({ x: 1600, y: 0, z: 1600 })
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(world.chunks.size, 0)
  world.beginWorld('nether', true)
  world.setCenter({ x: 0, y: 0, z: 0 })
  await waitFor(() => world.coverage().ready)
  world.receiveColumn({ x: 0, z: 0, dimension: 0, cache_enabled: false })
  assert.equal(world.chunks.size, 0)
  assert.equal(world.coverage().totalSubchunks, 49 * 8)
  world.resetWorld()
  assert.equal(world.coverage().ready, false)
  assert.equal(world.chunks.size, 0)
})

test('failed requests retry at most three times, and corrupt payloads never become air', async t => {
  const world = await setup(t)
  column(world)
  receive(world, 'success', Buffer.from([99, 0, 0]))
  await waitFor(() => world.worldError !== null)
  assert.equal(world.coverage().knownSubchunks, 0)
  const requested = new Map()
  for (let step = 0; step < 20; step++) world.requestSubchunks((name, packet) => {
    for (const p of packet.requests) {
      const y = p.y + packet.origin.y
      const key=[packet.origin.x,y,packet.origin.z].join(':')
      requested.set(key, (requested.get(key) || 0) + 1)
      receive(world, 'chunk_not_found', undefined, packet.origin.x, packet.origin.z, y)
    }
  }, Date.now() + 6000 * step)
  assert.ok([...requested.values()].every(count => count <= 3))
  assert.ok(world.coverage().failedSubchunks > 0)
  assert.equal(world.coverage().knownSubchunks, 0)
})

test('chunk crossings request missing columns without LevelChunk announcements and refill the map', async t => {
  const world=await setup(t,{x:.5,y:8,z:.5})
  const fill=()=>{
    for(let i=0;i<200&&!world.coverage().complete;i++)world.requestSubchunks((_,p)=>{
      world.receiveSubchunks({dimension:0,cache_enabled:false,origin:p.origin,
        entries:p.requests.map(v=>({dx:v.x,dy:v.y,dz:v.z,result:'success_all_air'}))})
    })
  }
  fill()
  assert.equal(world.coverage().receivedChunks,0,'No column announcement was fabricated')
  assert.equal(world.coverage().complete,true)
  const first=await world.surfaceMap()
  for(const x of [16.5,-.5,16.5]){
    world.setCenter({x,y:8,z:.5})
    assert.ok(world.coverage().completeChunks<49)
    fill()
    assert.equal(world.coverage().completeChunks,49)
    const map=await world.surfaceMap()
    assert.equal(map.x,(Math.floor(x/16)-4)*16)
    assert.ok(map.cells.some(c=>c!==null))
  }
  const cached=await world.surfaceMap()
  assert.notEqual(cached.x,first.x)
})

test('search validates input, yields, limits concurrent work and aborts on world reset', async t => {
  const world = await setup(t)
  column(world)
  receive(world, 'success_all_air')
  await assert.rejects(world.searchBlocks('<bad>', 2, world.position), /Invalid/)
  await assert.rejects(world.searchBlocks('air', 101, world.position), /Limit/)
  await assert.rejects(world.searchBlocks('unknown_block', 1, world.position), /Unknown block/)
  const pending = world.searchBlocks('air', 100, world.position)
  await assert.rejects(world.searchBlocks('air', 100, world.position), /already running/)
  world.resetWorld()
  await assert.rejects(pending, /World changed/)
})

test('top-down map matches real subchunk heights and marks missing data above', async t => {
  const world = await setup(t)
  column(world)
  receive(world, 'success', Buffer.from(fixture.payload, 'base64'))
  await waitFor(() => world.coverage().knownSubchunks === 1)
  const map = await world.surfaceMap()
  assert.equal(map.width, 144)
  assert.equal(map.height, 144)
  assert.equal(map.x, -80)
  assert.equal(map.z, -80)
  assert.equal(map.cells.length, 144 * 144)
  assert.equal(map.cells[0], null, 'Unreceived columns remain unknown')
  const Chunk = require('prismarine-chunk')(registry)
  const decoded = new Chunk({ x: 0, z: 0 })
  await decoded.networkDecodeSubChunkNoCache(0, Buffer.from(fixture.payload, 'base64'))
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) {
    let expected = null
    for (let y = 15; y >= 0; y--) {
      const block = decoded.getBlock({ x, y, z })
      if (block.name !== 'air') { expected = { name: 'minecraft:' + block.name, y }; break }
    }
    const cell = map.cells[(z - 16 - map.z) * map.width + x - 16 - map.x]
    if (!expected) assert.equal(cell, null)
    else {
      assert.equal(map.palette[cell[0]], expected.name)
      assert.equal(cell[1], expected.y)
      assert.equal(cell[2], false, 'A known underground block is not a confirmed surface')
    }
  }
  assert.strictEqual(await world.surfaceMap(), map, 'Unchanged snapshots reuse the cache')
  world.updateBlock({ x: -1, y: 15, z: -16 }, hashFor('diamond_ore'))
  const updated = await world.surfaceMap()
  const hit = updated.cells[(-16 - updated.z) * updated.width + -1 - updated.x]
  assert.equal(updated.palette[hit[0]], 'minecraft:diamond_ore')
  assert.notStrictEqual(updated, map)
})

test('map handles confirmed air, surface layers, cancellation and session resets', async t => {
  const world = await setup(t, { x: 0, y: 8, z: 0 })
  world.receiveColumn({ x: 0, z: 0, dimension: 0, cache_enabled: false })
  for (let i = 0; i < 3; i++) world.requestSubchunks((name, packet) => {
    world.receiveSubchunks({ dimension: 0, cache_enabled: false, origin: packet.origin,
      entries: packet.requests.map(p => ({ dx: p.x, dy: p.y, dz: p.z, result: 'success_all_air' })) })
  })
  const empty = await world.surfaceMap()
  const index = (0 - empty.z) * empty.width + 0 - empty.x
  assert.deepEqual(empty.cells[index], [0, null, true])
  world.updateBlock({ x: 0, y: 70, z: 0 }, hashFor('stone'))
  world.updateBlock({ x: 0, y: 71, z: 0 }, hashFor('water'), 1)
  const water = await world.surfaceMap()
  assert.equal(water.palette[water.cells[index][0]], 'minecraft:water')
  assert.deepEqual(water.cells[index].slice(1), [71, true])
  world.updateBlock({ x: 0, y: 71, z: 0 }, hashFor('air'), 1)
  const stone = await world.surfaceMap()
  assert.equal(stone.palette[stone.cells[index][0]], 'minecraft:stone')
  assert.equal(stone.cells[index][1], 70)
  world.setCenter({ x: 16, y: 8, z: 0 })
  const moved = await world.surfaceMap()
  assert.equal(moved.x, -48)
  world.updateBlock({ x: 0, y: 70, z: 0 }, hashFor('air'))
  const controller = new AbortController()
  const cancelled = world.surfaceMap(controller.signal)
  controller.abort()
  await assert.rejects(cancelled, /cancelled/)
  const pending = world.surfaceMap()
  await assert.rejects(world.surfaceMap(), /already being generated/)
  world.resetWorld()
  await assert.rejects(pending, /World changed/)
  await assert.rejects(world.surfaceMap(), /not ready/)
})
