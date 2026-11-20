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
