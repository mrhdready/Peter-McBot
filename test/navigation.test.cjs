const { test } = require('node:test')
const assert = require('node:assert/strict')
const { WorldState } = require('../dist/state.js')
const { Navigator, EYE_HEIGHT } = require('../dist/navigation.js')
const registry = require('prismarine-registry')('bedrock_1.26.60')
registry.handleStartGame({ itemstates: [], block_network_ids_are_hashes: true })
const hashes = new Map(Object.entries(registry.blocksByRuntimeId).map(([id, block]) => [block.stateId, Number(id) >>> 0]))
const hash = name => hashes.get(registry.blocksByName[name].defaultState)
async function setup (t) {
  const world = new WorldState(4)
  t.after(() => world.resetWorld())
  world.beginWorld('overworld', true)
  world.position = { x: .5, y: 71 + EYE_HEIGHT, z: .5 }; world.status = 'spawned'; world.setCenter(world.position)
  const deadline = Date.now() + 5000
  while (!world.coverage().ready) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10)) }
  for (const x of [-1, 0]) for (const z of [-1, 0]) world.receiveColumn({ x, z, dimension: 0, cache_enabled: false })
  for (let i = 0; i < 12; i++) world.requestSubchunks((_, p) => world.receiveSubchunks({ dimension: 0, cache_enabled: false, origin: p.origin,
    entries: p.requests.map(v => ({ dx: v.x, dy: v.y, dz: v.z, result: 'success_all_air' })) }))
  for (let x = -5; x <= 5; x++) for (let z = -5; z <= 5; z++) world.updateBlock({ x, y: 70, z }, hash('stone'))
  const navigator = new Navigator(world)
  const sent = []
  let now = 0
  const step = () => navigator.step((name, params) => sent.push({ name, params }), now += 50)
  return { world, navigator, sent, step }
}

test('preview uses the real planner on the heartbeat without moving or changing active navigation', async t => {
  const {world}=await setup(t)
  const {BotController}=require('../dist/bot.js')
  const {readConfig}=require('../dist/config.js')
  let connections=0
  const bot=new BotController(readConfig({BEDROCK_HOST:'localhost'}),()=>{connections++;throw new Error('No connection allowed')})
  bot.state=world; bot.navigator=new Navigator(world)
  t.after(()=>bot.stop())
  const before=world.snapshot()
  const pending=bot.previewRoute({x:4,z:0})
  for(let i=0;i<30;i++)bot.step()
  const preview=await pending
  assert.deepEqual(preview.path.at(-1),{x:4.5,y:71,z:.5})
  assert.deepEqual(world.position,before.position)
  assert.deepEqual(world.navigation,before.navigation)
  assert.equal(connections,0)
  const abort=new AbortController()
  const cancelled=bot.previewRoute({x:4,z:0},abort.signal)
  abort.abort()
  await assert.rejects(cancelled,/cancelled/)
  const stale=bot.previewRoute({x:4,z:0})
  world.position={...world.position,x:.6};bot.step()
  await assert.rejects(stale,/cancelled/)
  const interrupted=bot.previewRoute({x:4,z:0})
  bot.enqueue({type:'navigate',x:4,z:0});bot.step()
  await assert.rejects(interrupted,/cancelled/)
  await assert.rejects(bot.previewRoute({x:3,z:0}),/Stop navigation/)
})

test('central route snapshots shrink with movement and clear on replan, stop and session change', async t => {
  const {world,navigator,step}=await setup(t)
  navigator.start({x:4,z:0},0)
  for(let i=0;i<30&&world.navigation.status==='planning';i++)step()
  assert.equal(world.navigation.status,'moving')
  const snapshot=world.snapshot()
  assert.equal(snapshot.navigation.path.length,snapshot.navigation.remaining)
  assert.deepEqual(snapshot.navigation.path.at(-1),{x:4.5,y:71,z:.5})
  snapshot.navigation.path[0].x=999
  assert.notEqual(world.navigation.path[0].x,999,'Snapshot cannot mutate the route used by the bot')
  for(let i=0;i<8;i++)step()
  assert.equal(world.navigation.status,'moving')
  assert.ok(world.navigation.path.length<snapshot.navigation.path.length)
  navigator.serverCorrection({...world.position,z:world.position.z+.8},100n,{x:0,y:-.0784,z:0},true)
  assert.equal(world.navigation.status,'planning')
  assert.deepEqual(world.snapshot().navigation.path,[])
  for(let i=0;i<30&&world.navigation.status==='planning';i++)step()
  assert.ok(world.navigation.path.length)
  navigator.stop()
  assert.deepEqual(world.snapshot().navigation.path,[])
  navigator.start({x:4,z:0},10000)
  for(let i=0;i<30&&world.navigation.status==='planning';i++)step()
  world.clearChunks();step()
  assert.deepEqual(world.snapshot().navigation.path,[])
  assert.equal(world.navigation.status,'error')
})

test('flat A* detours around solid blocks; inputs are bounded, ticked and serializable for protocol 2225', async t => {
  const { world, navigator, step, sent } = await setup(t)
  world.updateBlock({ x: 1, y: 71, z: 0 }, hash('stone'))
  world.updateBlock({ x: 1, y: 72, z: 0 }, hash('stone'))
  navigator.acknowledgeTeleport()
  navigator.start({ x: 2, z: 0 }, 0)
  for (let i = 0; i < 600 && ['planning','moving'].includes(world.navigation.status); i++) step()
  step()
  assert.equal(world.navigation.status, 'arrived', world.navigation.message)
  assert.ok(Math.hypot(world.position.x - 2.5, world.position.z - .5) < .08)
  assert.equal(world.positionSource, 'predicted')
  assert.equal(world.lastServerPosition, null, 'Client predictions do not fabricate server confirmation')
  const serializer = require('bedrock-protocol/src/transforms/serializer').createSerializer('1.26.60')
  assert.equal(sent[0].params.move_vector.z, 0)
  assert.ok(sent[0].params.input_data.includes('handled_teleport'))
  assert.equal(sent.filter(p => p.params.input_data.includes('handled_teleport')).length, 1)
  for (let i = 0; i < sent.length; i++) {
    const { name, params } = sent[i]
    assert.equal(name, 'player_auth_input')
    assert.equal(params.tick, BigInt(i + 1))
    assert.ok(params.move_vector.z <= 1.00001)
    assert.ok(world.canStandAt(params.position.x, params.position.z, 71), 'Every swept step stays in known free space')
    assert.ok(!params.input_data.some(flag => /jump|sprint|fly/.test(flag)))
    assert.ok(serializer.createPacketBuffer({ name, params }).length > 0)
  }
  assert.equal(sent.at(-1).params.move_vector.z, 0)
})

test('walkability rejects unknowns, fluids, partial support, head collisions and footprint overhangs', async t => {
  const { world } = await setup(t)
  assert.equal(world.canStandAt(.5, .5, 71), true)
  assert.equal(world.canStandAt(10.5, .5, 71), false)
  assert.equal(world.canStandAt(5.95, .5, 71), true, 'Known partial support can hold the player at a ledge')
  assert.equal(world.canStandAt(6.31, .5, 71), false)
  world.updateBlock({ x: 0, y: 72, z: 0 }, hash('stone'))
  assert.equal(world.canStandAt(.5, .5, 71), false)
  world.updateBlock({ x: 0, y: 72, z: 0 }, hash('air'))
  world.updateBlock({ x: 0, y: 71, z: 0 }, hash('water'), 1)
  assert.equal(world.canStandAt(.5, .5, 71), false)
  world.updateBlock({ x: 0, y: 71, z: 0 }, hash('air'), 1)
  world.updateBlock({ x: 0, y: 70, z: 0 }, hash('smooth_stone_slab'))
  assert.equal(world.canStandAt(.5, .5, 71), false)
})

test('farmland and paths are standable 15/16-high surfaces, crops on them are passable', async t => {
  const { world } = await setup(t)
  for (const name of ['farmland', 'grass_path']) {
    world.updateBlock({ x: 0, y: 70, z: 0 }, hash(name))
    assert.equal(world.canStandAt(.5, .5, 70.9375), true, name)
  }
  world.updateBlock({ x: 0, y: 70, z: 0 }, hash('farmland'))
  world.updateBlock({ x: 0, y: 71, z: 0 }, hash('wheat'))
  assert.equal(world.canStandAt(.5, .5, 70.9375), true, 'A crop has no collision')
})

test('navigation crosses several farmland blocks (15/16 high) and leaves them again', async t => {
  const { world, navigator, step } = await setup(t)
  // Farmland's top is 1/16 below the stone floor's: route nodes must keep that height instead of rounding it to half blocks.
  for (const x of [1, 2, 3]) {
    world.updateBlock({ x, y: 70, z: 0 }, hash('farmland'))
    world.updateBlock({ x, y: 71, z: 0 }, hash('wheat'))
  }
  navigator.start({ x: 3, z: 0 }, 0)
  for (let i = 0; i < 400 && ['planning', 'moving'].includes(world.navigation.status); i++) step()
  assert.equal(world.navigation.status, 'arrived', world.navigation.message)
  assert.ok(Math.abs(world.position.y - EYE_HEIGHT - 70.9375) < .001)
  navigator.start({ x: 5, z: 0 }, 0)
  for (let i = 0; i < 400 && ['planning', 'moving'].includes(world.navigation.status); i++) step()
  assert.equal(world.navigation.status, 'arrived', world.navigation.message)
  assert.ok(Math.abs(world.position.y - EYE_HEIGHT - 71) < .001)
})

test('stop sends one neutral input and no later movement; unsafe targets send no inputs', async t => {
  const { world, navigator, step, sent } = await setup(t)
  navigator.synchroniseTick(50000n)
  navigator.start({ x: 30, z: 0 }, 0);
  for(let i=0;i<30&&world.navigation.status==='planning';i++)step()
  assert.equal(world.navigation.status, 'error')
  assert.equal(sent.length, 0)
  navigator.start({ x: 4, z: 0 }, 0)
  for (let i = 0; i < 10; i++) step()
  assert.ok(sent.some(p => p.params.move_vector.z > 0))
  navigator.stop(); step()
  assert.equal(world.navigation.status, 'stopped')
  assert.equal(sent.at(-1).params.move_vector.z, 0)
  const count = sent.length
  for (let i = 0; i < 10; i++) step()
  assert.equal(sent.length, count)
  const lastTick = sent.at(-1).params.tick
  world.tick += 1000
  navigator.start({ x: 3, z: 0 }, 2000)
  for (let i = 0; i < 10; i++) step()
  assert.ok(sent.at(-1).params.tick > lastTick + 900n, 'The input clock advances through idle periods')
})

test('an obstructed start keeps its original error without attempting to land', async t => {
  const { world, navigator, step, sent } = await setup(t)
  world.updateBlock({ x: 0, y: 72, z: 0 }, hash('stone'))
  const position = { ...world.position }
  navigator.start({ x: 4, z: 0 }, 0)
  const message = world.navigation.message
  assert.match(message, /Startposition/)
  for (let i = 0; i < 5; i++) step()
  assert.equal(world.navigation.status, 'error')
  assert.equal(world.navigation.message, message)
  assert.deepEqual(world.position, position)
  assert.equal(sent.length, 0)
})

test('obstacles replan; authoritative corrections stop height changes and old ticks cannot overwrite state', async t => {
  const { world, navigator, step, sent } = await setup(t)
  navigator.start({ x: 4, z: 0 }, 0)
  for (let i = 0; i < 3; i++) step()
  world.updateBlock({ x: 2, y: 71, z: 0 }, hash('stone'))
  for (let i = 0; i < 300 && ['planning','moving'].includes(world.navigation.status); i++) step()
  assert.ok(world.navigation.replans > 0)
  assert.equal(world.navigation.status, 'arrived', world.navigation.message)
  navigator.start({ x: -3, z: 0 }, 20000)
  step()
  const corrected = { x: world.position.x, y: world.position.y - 1, z: world.position.z }
  navigator.serverCorrection(corrected, 1000n)
  assert.equal(world.navigation.status, 'error')
  assert.deepEqual(world.lastServerPosition, corrected)
  assert.equal(navigator.serverCorrection({ x: 999, y: 999, z: 999 }, 999n), false)
  assert.deepEqual(world.position, corrected)
  step()
  assert.equal(sent.at(-1).params.move_vector.z, 0)
})

test('blocked routes terminate; new sessions cannot continue a path', async t => {
  const { world, navigator, step, sent } = await setup(t)
  for (let z = -5; z <= 5; z++) for (const y of [71,72]) world.updateBlock({ x: 1, y, z }, hash('stone'))
  navigator.start({ x: 3, z: 0 }, 0)
  for (let i = 0; i < 100 && ['planning','moving'].includes(world.navigation.status); i++) step()
  assert.equal(world.navigation.status, 'error')
  assert.equal(sent.length, 0)
  navigator.start({ x: -3, z: 0 }, 1000)
  step()
  world.clearChunks()
  step()
  assert.equal(world.navigation.status, 'error')
  assert.match(world.navigation.message, /Weltsitzung/)
})

test('registry slabs and stairs resolve target height from X/Z without jump inputs', async t => {
  const { world, navigator, step, sent } = await setup(t)
  const lower = registry.blocksByName.smooth_stone_slab.minStateId
  world.updateBlock({ x:1, y:71, z:0 }, hashes.get(lower))
  navigator.start({ x:2, z:0 },0)
  for (let i=0;i<400 && ['planning','moving'].includes(world.navigation.status);i++) step()
  assert.equal(world.navigation.status,'arrived',world.navigation.message)
  assert.ok(sent.some(p => Math.abs(p.params.position.y - EYE_HEIGHT - 71.5)<.001))
  assert.ok(sent.some(p => !p.params.input_data.includes('vertical_collision')),'Descending off the slab has an airborne phase')
  assert.ok(Math.abs(world.position.y-EYE_HEIGHT-71)<.001)
  assert.ok(sent.every(p => !p.params.input_data.some(flag => /jump|fly/.test(flag))))
  world.position={x:.5,y:71+EYE_HEIGHT,z:.5};world.setCenter(world.position)
  const stairs=registry.blocksByName.oak_stairs.minStateId
  world.updateBlock({x:1,y:71,z:0},hashes.get(stairs))
  world.updateBlock({x:2,y:71,z:0},hash('stone'))
  navigator.start({x:2,z:0},25000)
  for(let i=0;i<400 && ['planning','moving'].includes(world.navigation.status);i++)step()
  assert.equal(world.navigation.status,'arrived',world.navigation.message)
  assert.ok(Math.abs(world.position.y-EYE_HEIGHT-72)<.001)
})

test('one-block descent lands before arrival and Stop during descent keeps all later inputs neutral', async t => {
  const {world,navigator,step,sent}=await setup(t)
  for(let x=1;x<=5;x++)for(let z=-5;z<=5;z++){
    world.updateBlock({x,y:70,z},hash('air'))
    world.updateBlock({x,y:69,z},hash('stone'))
  }
  navigator.start({x:2,z:0},0)
  for(let i=0;i<200 && !sent.some(p=>!p.params.input_data.includes('vertical_collision'));i++)step()
  assert.equal(world.navigation.status,'moving')
  assert.ok(sent.some(p=>!p.params.input_data.includes('vertical_collision')))
  navigator.stop()
  const stoppedCount=sent.length
  for(let i=0;i<20;i++)step()
  assert.equal(world.navigation.status,'stopped',world.navigation.message)
  assert.ok(sent.slice(stoppedCount).every(p=>p.params.move_vector.z===0))
  assert.ok(Math.abs(world.position.y-EYE_HEIGHT-70)<.001)
  assert.ok(world.canStandAt(world.position.x,world.position.z,70))
  const landedCount=sent.length
  step();step();assert.equal(sent.length,landedCount)
  navigator.start({x:2,z:0},30000)
  for(let i=0;i<200 && ['planning','moving'].includes(world.navigation.status);i++)step()
  assert.equal(world.navigation.status,'arrived',world.navigation.message)
  assert.ok(Math.abs(world.position.y-EYE_HEIGHT-70)<.001)
})

test('all four registry stair directions use their low face and upside-down stairs keep a full-height side', async t => {
  const {world}=await setup(t)
  const base=registry.blocksByName.oak_stairs.minStateId
  const approaches=[
    [{x:.5,y:71,z:.5},{x:2.5,y:71,z:.5}],
    [{x:2.5,y:71,z:.5},{x:.5,y:71,z:.5}],
    [{x:1.5,y:71,z:-.5},{x:1.5,y:71,z:1.5}],
    [{x:1.5,y:71,z:1.5},{x:1.5,y:71,z:-.5}]
  ]
  for(let direction=0;direction<4;direction++){
    world.updateBlock({x:1,y:71,z:0},hashes.get(base+direction))
    const [low,high]=approaches[direction]
    assert.equal(world.terrain.transition(low,1.5,.5)?.y,72)
    assert.equal(world.terrain.transition(high,1.5,.5),null)
    world.updateBlock({x:1,y:71,z:0},hashes.get(base+4+direction))
    assert.equal(world.terrain.transition(low,1.5,.5),null)
    assert.equal(world.canStandAt(1.5,.5,72),true)
  }
})

/* Safety-weighted routes, correction tolerance and unknown-waypoint waiting. */
async function plan (world, target) {
  const { RoutePlanner } = require('../dist/pathfinder.js')
  const planner = new RoutePlanner(world, world.position, target)
  for (let i = 0; i < 400; i++) { const path = planner.step(); if (path) return path }
  assert.fail('Planner did not finish')
}

test('routes walk around a single one-block hole instead of dropping in and jumping out', async t => {
  const { world } = await setup(t)
  world.updateBlock({ x: 2, y: 70, z: 0 }, hash('air'))
  world.updateBlock({ x: 2, y: 69, z: 0 }, hash('stone'))
  const path = await plan(world, { x: 4, z: 0 })
  assert.deepEqual(path.at(-1), { x: 4.5, y: 71, z: .5 })
  assert.ok(path.every(p => p.y === 71), 'No waypoint drops into the hole')
  assert.ok(!path.some(p => p.x === 2.5 && p.z === .5))
})

test('routes keep a distance from drop-offs when a safe detour exists', async t => {
  const { world } = await setup(t)
  for (let x = 0; x <= 4; x++) world.updateBlock({ x, y: 70, z: -1 }, hash('air'))
  const path = await plan(world, { x: 4, z: 0 })
  assert.deepEqual(path.at(-1), { x: 4.5, y: 71, z: .5 })
  assert.ok(path.slice(1, -1).every(p => p.z !== .5), 'Interior waypoints avoid the row next to the drop')
})

test('a jump is still planned when it is the only way to the target', async t => {
  const { world, navigator, step } = await setup(t)
  for (let x = 2; x <= 5; x++) for (let z = -5; z <= 5; z++) world.updateBlock({ x, y: 71, z }, hash('stone'))
  const path = await plan(world, { x: 3, z: 0 })
  assert.equal(path.at(-1).y, 72)
  navigator.start({ x: 3, z: 0 }, 0)
  for (let i = 0; i < 600 && ['planning', 'moving'].includes(world.navigation.status); i++) step()
  assert.equal(world.navigation.status, 'arrived', world.navigation.message)
})

test('small on-path server corrections are accepted without replanning', async t => {
  const { world, navigator, step } = await setup(t)
  for (let x = 6; x <= 12; x++) for (let z = -5; z <= 5; z++) world.updateBlock({ x, y: 70, z }, hash('stone'))
  navigator.start({ x: 10, z: 0 }, 0)
  for (let i = 0; i < 30 && world.navigation.status === 'planning'; i++) step()
  for (let i = 0; i < 10; i++) step()
  for (let tick = 1; tick <= 5; tick++) {
    navigator.serverCorrection({ ...world.position, z: .7 }, BigInt(tick * 10), { x: 0, y: -.0784, z: 0 }, true)
    assert.equal(world.navigation.status, 'moving', world.navigation.message)
    for (let i = 0; i < 5; i++) step()
  }
  assert.equal(world.navigation.replans, 0)
  for (let i = 0; i < 600 && ['planning', 'moving'].includes(world.navigation.status); i++) step()
  assert.equal(world.navigation.status, 'arrived', world.navigation.message)
})

/* Walking speed: pass through straight waypoints, round safe turns, stay careful next to edges. */
const horizontalSteps = sent => sent.slice(1).map((p, i) => ({ from: sent[i].params.position,
  length: Math.hypot(p.params.position.x - sent[i].params.position.x, p.params.position.z - sent[i].params.position.z) }))

test('straight, level, edge-free segments keep walking speed through intermediate waypoints', async t => {
  const { world, navigator, step, sent } = await setup(t)
  for (let x = 6; x <= 12; x++) for (let z = -5; z <= 5; z++) world.updateBlock({ x, y: 70, z }, hash('stone'))
  navigator.start({ x: 10, z: 0 }, 0)
  let ticks = 0
  for (; ticks < 300 && ['planning', 'moving'].includes(world.navigation.status); ticks++) step()
  assert.equal(world.navigation.status, 'arrived', world.navigation.message)
  assert.ok(Math.hypot(world.position.x - 10.5, world.position.z - .5) < .08)
  assert.ok(ticks < 80, `Ten blocks took ${ticks} ticks`)
  const steps = horizontalSteps(sent)
  assert.ok(Math.max(...steps.map(s => s.length)) > .2, 'Reaches walking speed')
  const middle = steps.filter(s => s.from.x > 2.5 && s.from.x < 8.5)
  assert.ok(middle.length > 10 && middle.every(s => s.length > .15), 'No braking at intermediate waypoints')
  assert.ok(sent.every(p => p.params.move_vector.z <= 1.00001 && !p.params.input_data.some(flag => /sprint|jump/.test(flag))))
})

test('level turns on safe ground slow down without stopping', async t => {
  const { world, navigator, step, sent } = await setup(t)
  navigator.start({ x: 3, z: 3 }, 0)
  for (let i = 0; i < 300 && ['planning', 'moving'].includes(world.navigation.status); i++) step()
  assert.equal(world.navigation.status, 'arrived', world.navigation.message)
  assert.ok(Math.hypot(world.position.x - 3.5, world.position.z - 3.5) < .08)
  const travel = horizontalSteps(sent).slice(3).filter(s => Math.hypot(s.from.x - 3.5, s.from.z - 3.5) > 1)
  assert.ok(travel.length && travel.every(s => s.length > .05), 'Turns keep moving instead of stopping')
})

test('a pass waypoint reached on a careful segment after an edge is consumed instead of stalling', async t => {
  const { world, navigator, step } = await setup(t)
  // The drop next to the first two waypoints makes the segment into the third (a pass waypoint) careful.
  world.updateBlock({ x: 0, y: 70, z: -1 }, hash('air'))
  navigator.start({ x: 4, z: 0 }, 0)
  for (let i = 0; i < 600 && ['planning', 'moving'].includes(world.navigation.status); i++) step()
  assert.equal(world.navigation.status, 'arrived', world.navigation.message)
})

test('a one-block bridge between drops keeps the careful speed', async t => {
  const { world, navigator, step, sent } = await setup(t)
  for (let x = 1; x <= 3; x++) for (const z of [-1, 1]) world.updateBlock({ x, y: 70, z }, hash('air'))
  navigator.start({ x: 4, z: 0 }, 0)
  for (let i = 0; i < 600 && ['planning', 'moving'].includes(world.navigation.status); i++) step()
  assert.equal(world.navigation.status, 'arrived', world.navigation.message)
  assert.ok(horizontalSteps(sent).every(s => s.length <= .0601), 'No walking speed next to a drop')
  assert.ok(sent.every(p => p.params.move_vector.z <= .30001))
})

test('unknown waypoint data pauses movement for up to three seconds before replanning', async t => {
  const { world, navigator, step, sent } = await setup(t)
  navigator.start({ x: 4, z: 0 }, 0)
  for (let i = 0; i < 30 && world.navigation.status === 'planning'; i++) step()
  for (let i = 0; i < 10; i++) step()
  const isKnownAt = world.terrain.isKnownAt
  world.terrain.isKnownAt = () => false
  t.after(() => { world.terrain.isKnownAt = isKnownAt })
  step(); step()
  const count = sent.length
  for (let i = 0; i < 40; i++) step()
  assert.equal(world.navigation.status, 'moving', world.navigation.message)
  assert.equal(world.navigation.replans, 0)
  assert.ok(sent.slice(count).every(p => p.params.move_vector.z === 0), 'No forward input while waiting')
  world.terrain.isKnownAt = isKnownAt
  for (let i = 0; i < 600 && ['planning', 'moving'].includes(world.navigation.status); i++) step()
  assert.equal(world.navigation.status, 'arrived', world.navigation.message)
  navigator.start({ x: -3, z: 0 }, 100000)
  for (let i = 0; i < 30 && world.navigation.status === 'planning'; i++) step()
  world.terrain.isKnownAt = () => false
  for (let i = 0; i < 70; i++) step()
  assert.equal(world.navigation.replans, 1, 'Replans once after the wait expires')
})

/* Doors and fence gates: planned as passable, opened once, avoided when they stay closed, closed again behind the bot. */
const stateId = (name, props) => registry.blockStates.findIndex(s => s?.name === name &&
  Object.entries(props).every(([key, value]) => (s.states[key]?.value ?? s.states[key]) === value))
const DIRECTIONS = ['south', 'west', 'north', 'east']
// Like a Bedrock server, only the lower half carries facing and open state; the upper half keeps default values.
function placeDoor (world, name, open, direction) {
  for (const upper of [0, 1]) {
    const id = stateId(name, upper ? { open_bit: 0, upper_block_bit: 1, door_hinge_bit: 0, 'minecraft:cardinal_direction': 'south' }
      : { open_bit: open ? 1 : 0, upper_block_bit: 0, door_hinge_bit: 0, 'minecraft:cardinal_direction': direction })
    assert.ok(id >= 0, `${name} state exists`)
    world.updateBlock({ x: 2, y: 71 + upper, z: 0 }, hashes.get(id))
  }
}
const passesDoorBlock = world => world.terrain.transition({ x: 1.5, y: 71, z: .5 }, 2.5, .5) !== null &&
  world.terrain.transition({ x: 2.5, y: 71, z: .5 }, 3.5, .5) !== null
// A stone wall at x=2 whose only gap at z=0 holds a door whose closed panel already blocks entering the door block from the west.
function doorWall (world, name = 'wooden_door') {
  for (let z = -5; z <= 5; z++) if (z !== 0) for (const y of [71, 72]) world.updateBlock({ x: 2, y, z }, hash('stone'))
  for (const direction of DIRECTIONS) {
    placeDoor(world, name, true, direction)
    const open = passesDoorBlock(world)
    placeDoor(world, name, false, direction)
    if (open && world.terrain.transition({ x: 1.5, y: 71, z: .5 }, 2.5, .5) === null) return direction
  }
  assert.fail('No door direction blocks the gap when closed')
}
const clicks = sent => sent.filter(p => p.name === 'inventory_transaction')
async function walkToDoor (world, step, sent) {
  for (let i = 0; i < 400 && !clicks(sent).length && ['planning', 'moving'].includes(world.navigation.status); i++) step()
  assert.equal(clicks(sent).length, 1, world.navigation.message)
}

test('a closed door reported as facing south blocks walking along X and opens to a passable panel (verified on a live server)', async t => {
  const { world } = await setup(t)
  placeDoor(world, 'wooden_door', false, 'south')
  assert.equal(world.terrain.transition({ x: 1.5, y: 71, z: .5 }, 2.5, .5), null)
  placeDoor(world, 'wooden_door', true, 'south')
  assert.ok(passesDoorBlock(world))
})

test('routes pass closed wooden doors and fence gates only with door opening enabled; iron doors stay walls', async t => {
  const { world, sent } = await setup(t)
  const direction = doorWall(world)
  const path = await plan(world, { x: 4, z: 0 })
  assert.ok(path.some(p => p.x === 2.5 && p.z === .5), 'Route leads through the closed door')
  world.openDoors = false
  await assert.rejects(plan(world, { x: 4, z: 0 }), /Kein Weg/)
  world.openDoors = true
  placeDoor(world, 'iron_door', false, direction)
  await assert.rejects(plan(world, { x: 4, z: 0 }), /Kein Weg/)
  world.updateBlock({ x: 2, y: 72, z: 0 }, hash('air'))
  const gate = open => DIRECTIONS.map(d => stateId('fence_gate', { open_bit: open, in_wall_bit: 0, 'minecraft:cardinal_direction': d }))
  const blocking = gate(0).findIndex(id => { world.updateBlock({ x: 2, y: 71, z: 0 }, hashes.get(id)); return !passesDoorBlock(world) })
  assert.ok(blocking >= 0, 'A closed fence gate blocks the gap')
  world.updateBlock({ x: 2, y: 71, z: 0 }, hashes.get(gate(1)[blocking]))
  assert.ok(passesDoorBlock(world), 'The open fence gate is passable')
  world.updateBlock({ x: 2, y: 71, z: 0 }, hashes.get(gate(0)[blocking]))
  assert.ok((await plan(world, { x: 4, z: 0 })).some(p => p.x === 2.5 && p.z === .5), 'Route leads through the closed fence gate')
  assert.equal(sent.length, 0, 'Planning never sends packets')
})

test('navigation stops at a closed door, clicks it once, passes after the server opens it and closes it behind itself', async t => {
  const { world, navigator, step, sent } = await setup(t)
  const direction = doorWall(world)
  navigator.start({ x: 4, z: 0 }, 0)
  await walkToDoor(world, step, sent)
  const { transaction } = clicks(sent)[0].params
  assert.equal(transaction.transaction_type, 'item_use')
  assert.equal(transaction.transaction_data.action_type, 'click_block')
  assert.deepEqual(transaction.transaction_data.block_position, { x: 2, y: 71, z: 0 })
  assert.equal(transaction.transaction_data.face, 4, 'Clicks the west face, towards the bot')
  const serializer = require('bedrock-protocol/src/transforms/serializer').createSerializer('1.26.60')
  assert.ok(serializer.createPacketBuffer(clicks(sent)[0]).length > 0)
  assert.ok(Math.abs(world.position.x - 1.5) < .08, 'Waits in front of the door')
  for (let i = 0; i < 20; i++) step()
  assert.equal(world.navigation.status, 'moving')
  assert.equal(clicks(sent).length, 1, 'One click only while waiting')
  assert.ok(Math.abs(world.position.x - 1.5) < .08)
  placeDoor(world, 'wooden_door', true, direction)
  for (let i = 0; i < 400 && ['planning', 'moving'].includes(world.navigation.status); i++) step()
  assert.equal(world.navigation.status, 'arrived', world.navigation.message)
  assert.equal(world.navigation.replans, 0)
  assert.equal(clicks(sent).length, 2, 'Closes the door it opened')
  const close = clicks(sent)[1]
  assert.equal(close.params.transaction.transaction_data.face, 5, 'Closes from the east side')
  assert.ok(close.params.transaction.transaction_data.player_pos.x >= 3.3, 'Closes only after leaving the door block')
})

for (const fromEast of [false, true]) test(`door clicks from the ${fromEast ? 'east' : 'west'} use the real held item and immediately aim without moving`, async t => {
  const { world, navigator, step, sent } = await setup(t)
  const direction = doorWall(world)
  world.position.x = fromEast ? 3.5 : 1.5
  const held = { ...world.inventory.heldItem(0), network_id: 1, count: 2, has_stack_id: true, stack_id: 12 }
  world.inventory.setSlot(0, held)
  navigator.start({ x: fromEast ? 0 : 4, z: 0 }, 0)
  await walkToDoor(world, step, sent)
  const before = { ...world.position }
  const assertClick = packet => {
    const data = packet.params.transaction.transaction_data
    assert.deepEqual(data.held_item, held)
    const input = sent[sent.indexOf(packet) + 1]
    assert.equal(input?.name, 'player_auth_input', 'Every click is flushed even when already stationary')
    assert.deepEqual(input.params.position, data.player_pos)
    assert.deepEqual(input.params.move_vector, { x: 0, z: 0 })
    const dx = 2.5 - data.player_pos.x; const dz = .5 - data.player_pos.z
    const yaw = Math.atan2(-dx, dz) * 180 / Math.PI
    const pitch = Math.atan2(data.player_pos.y - 71.5, Math.hypot(dx, dz)) * 180 / Math.PI
    assert.equal(input.params.yaw, yaw)
    assert.equal(input.params.head_yaw, yaw)
    assert.equal(input.params.pitch, pitch)
    assert.deepEqual(input.params.interact_rotation, { x: pitch, z: yaw })
  }
  assertClick(clicks(sent)[0])
  for (let i = 0; i < 5; i++) step()
  assert.deepEqual(world.position, before, 'Waits for the server without moving')
  assert.equal(clicks(sent).length, 1, 'No repeated toggle while awaiting the server')
  placeDoor(world, 'wooden_door', true, direction)
  for (let i = 0; i < 400 && ['planning', 'moving'].includes(world.navigation.status); i++) step()
  assert.equal(world.navigation.status, 'arrived', world.navigation.message)
  assert.equal(clicks(sent).length, 2)
  assertClick(clicks(sent)[1])
})

test('a door stays open when another player is next to it', async t => {
  const { world, navigator, step, sent } = await setup(t)
  const direction = doorWall(world)
  world.players.set('7', { name: 'Alex', position: { x: 3.5, y: 71 + EYE_HEIGHT, z: 1.5 }, uniqueId: '7', uuid: 'u' })
  navigator.start({ x: 4, z: 0 }, 0)
  await walkToDoor(world, step, sent)
  placeDoor(world, 'wooden_door', true, direction)
  for (let i = 0; i < 400 && ['planning', 'moving'].includes(world.navigation.status); i++) step()
  assert.equal(world.navigation.status, 'arrived', world.navigation.message)
  for (let i = 0; i < 10; i++) step()
  assert.equal(clicks(sent).length, 1, 'No closing click')
})

test('a door that stays closed for two seconds becomes a wall for this navigation: detour or failure', async t => {
  const { world, navigator, step, sent } = await setup(t)
  doorWall(world)
  navigator.start({ x: 4, z: 0 }, 0)
  await walkToDoor(world, step, sent)
  for (let i = 0; i < 60 && ['planning', 'moving'].includes(world.navigation.status); i++) step()
  assert.equal(world.navigation.status, 'error')
  assert.match(world.navigation.message, /Kein Weg/)
  assert.equal(clicks(sent).length, 1)
  for (const y of [71, 72]) world.updateBlock({ x: 2, y, z: 4 }, hash('air'))
  navigator.start({ x: 4, z: 0 }, 100000)
  const before = clicks(sent).length
  for (let i = 0; i < 1200 && ['planning', 'moving'].includes(world.navigation.status); i++) step()
  assert.equal(world.navigation.status, 'arrived', world.navigation.message)
  assert.equal(clicks(sent).length, before + 1, 'A new navigation tries the door again')
  assert.ok(world.navigation.replans >= 1)
})

test('OPEN_DOORS defaults to on, accepts only on or off and reaches the world model', () => {
  const { readConfig } = require('../dist/config.js')
  const { BotController } = require('../dist/bot.js')
  assert.equal(readConfig({ BEDROCK_HOST: 'localhost' }).openDoors, true)
  assert.equal(readConfig({ BEDROCK_HOST: 'localhost', OPEN_DOORS: 'off' }).openDoors, false)
  assert.throws(() => readConfig({ BEDROCK_HOST: 'localhost', OPEN_DOORS: 'yes' }), /OPEN_DOORS/)
  const bot = new BotController(readConfig({ BEDROCK_HOST: 'localhost', OPEN_DOORS: 'off' }), () => { throw new Error('No connection allowed') })
  assert.equal(bot.state.openDoors, false)
  bot.stop()
})

test('cropAt reads crop growth, blockNameAt names blocks and ripeCrops finds ripe crops within the horizontal radius, nearest first', async t => {
  const { world } = await setup(t)
  const wheat = registry.blocksByName.wheat
  const growth = value => hashes.get(wheat.minStateId + value)
  world.updateBlock({ x: 1, y: 70, z: 0 }, hash('farmland'))
  world.updateBlock({ x: 1, y: 71, z: 0 }, growth(7))
  world.updateBlock({ x: 3, y: 71, z: 0 }, growth(3))
  world.updateBlock({ x: -4, y: 71, z: -4 }, growth(7))
  assert.deepEqual(world.cropAt(1, 71, 0), { kind: 'wheat', growth: 7 })
  assert.deepEqual(world.cropAt(3, 71, 0), { kind: 'wheat', growth: 3 })
  assert.equal(world.cropAt(2, 71, 0), null)
  assert.equal(world.blockNameAt(1, 70, 0), 'minecraft:farmland')
  assert.equal(world.blockNameAt(2, 71, 0), 'minecraft:air')
  assert.deepEqual(await world.ripeCrops({ x: .5, y: 72, z: .5 }, 24), [{ x: 1, y: 71, z: 0, kind: 'wheat' }, { x: -4, y: 71, z: -4, kind: 'wheat' }])
  assert.deepEqual(await world.ripeCrops({ x: .5, y: 72, z: .5 }, 3), [{ x: 1, y: 71, z: 0, kind: 'wheat' }])
})

test('beetroot growth 3 stays immature and growth 7 is found as ripe', async t => {
  const { world } = await setup(t)
  const beetroot = registry.blocksByName.beetroot
  world.updateBlock({ x: 1, y: 71, z: 0 }, hashes.get(beetroot.minStateId + 3))
  world.updateBlock({ x: 2, y: 71, z: 0 }, hashes.get(beetroot.minStateId + 7))
  assert.deepEqual(world.cropAt(1, 71, 0), { kind: 'beetroot', growth: 3 })
  assert.deepEqual(world.cropAt(2, 71, 0), { kind: 'beetroot', growth: 7 })
  assert.deepEqual(await world.ripeCrops(world.position, 24), [{ x: 2, y: 71, z: 0, kind: 'beetroot' }])
  const { scanBeetroot } = require('../scripts/smoke-beetroot.cjs')
  const scan = await scanBeetroot(world, registry)
  assert.deepEqual(scan.growthCounts, { 3: 1, 7: 1 })
  assert.deepEqual(scan.crops.map(crop => [crop.x, crop.growth, crop.runtimeId]), [
    [1, 3, hashes.get(beetroot.minStateId + 3)], [2, 7, hashes.get(beetroot.minStateId + 7)]
  ])
  assert.equal(scan.coverage.complete, false, 'Partial coverage remains visible in the scan report')
  assert.equal(scan.stale, false)
  assert.equal(scan.limitReached, false)
})

test('lookAt sends pitch, flags and extra fields; clickBlock options set face, click position and hotbar slot', async t => {
  const { navigator, sent } = await setup(t)
  const send = (name, params) => sent.push({ name, params })
  navigator.lookAt(send, { x: 1.5, y: 71.25, z: .5 }, { flags: ['block_action'], fields: { block_action: [{ action: 'start_break' }] } })
  const input = sent.at(-1).params
  assert.ok(input.pitch > 45 && input.pitch < 60, 'Looks down at the crop')
  assert.equal(input.interact_rotation.x, input.pitch)
  assert.equal(Math.round(input.yaw), -90)
  assert.ok(input.input_data.includes('block_action'))
  assert.deepEqual(input.block_action, [{ action: 'start_break' }])
  // Without extras, turning keeps pitch 0 and no block action.
  navigator.face(send, { x: 1.5, z: .5 })
  assert.equal(sent.at(-1).params.pitch, 0)
  assert.equal(sent.at(-1).params.block_action, undefined)
  navigator.clickBlock(send, { x: 1, y: 70, z: 0 }, 5, { network_id: 300 }, { face: 1, clickPos: { x: .5, y: 1, z: .5 }, hotbarSlot: 3 })
  const planted = sent.at(-1).params.transaction.transaction_data
  assert.equal(planted.face, 1)
  assert.deepEqual(planted.click_pos, { x: .5, y: 1, z: .5 })
  assert.equal(planted.hotbar_slot, 3)
  assert.deepEqual(planted.held_item, { network_id: 300 })
  // The default click hits the face towards the bot with hotbar slot 0.
  navigator.clickBlock(send, { x: 1, y: 71, z: 0 }, 5)
  const door = sent.at(-1).params.transaction.transaction_data
  assert.equal(door.face, 4)
  assert.deepEqual(door.click_pos, { x: 0, y: .5, z: .5 })
  assert.equal(door.hotbar_slot, 0)
})
