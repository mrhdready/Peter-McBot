const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Terrain } = require('../dist/terrain.js')
const cube = [[0,0,0,1,1,1]]
const lower = [[0,0,0,1,.5,1]]
const upper = [[0,.5,0,1,1,1]]
const stair = [[0,0,0,1,.5,1],[.5,.5,0,1,1,1]]
function fixture () {
  const blocks = new Map()
  const set = (x,y,z,boxes) => blocks.set([x,y,z].join(':'), boxes === null ? null : { boxes, support: true })
  const terrain = new Terrain((x,y,z) => blocks.has([x,y,z].join(':')) ? blocks.get([x,y,z].join(':')) : { boxes: y === -1 ? cube : [], support: y === -1 })
  return { terrain, set }
}

test('half slabs support fractional feet heights and require headroom', () => {
  const { terrain, set } = fixture()
  set(1,0,0,lower)
  const end = terrain.transition({ x:.5,y:0,z:.5 },1.5,.5)
  assert.ok(end)
  assert.equal(end.y,.5)
  assert.equal(terrain.canStandAt(1.5,.5,.5),true)
  assert.equal(terrain.canStandAt(1.5,.5,0),false)
  set(1,2,0,cube)
  assert.equal(terrain.transition({x:.5,y:0,z:.5},1.5,.5),null)
  set(1,2,0,[]);set(1,0,0,upper)
  assert.equal(terrain.transition({x:.5,y:0,z:.5},1.5,.5),null,'An upper slab has a full-height approach from the ground')
  set(0,0,0,lower)
  assert.equal(terrain.transition({x:.5,y:.5,z:.5},1.5,.5).y,1)
})

test('stairs are traversed from their low face; high backs and sides require a jump', () => {
  const { terrain, set } = fixture()
  set(1,0,0,stair)
  assert.equal(terrain.transition({x:.5,y:0,z:.5},1.5,.5).y,1)
  assert.equal(terrain.transition({x:2.5,y:0,z:.5},1.5,.5),null)
  assert.equal(terrain.transition({x:1.5,y:0,z:-.5},1.5,.5),null)
  assert.equal(terrain.transition({x:1.5,y:1,z:.5},.5,.5).y,0)
})

test('full blocks up and drops deeper than one block are rejected', () => {
  const { terrain, set } = fixture()
  set(1,0,0,cube)
  assert.equal(terrain.transition({x:.5,y:0,z:.5},1.5,.5),null)
  assert.equal(terrain.transition({x:1.5,y:1,z:.5},.5,.5).y,0)
  for (let z=-1;z<=1;z++) { set(0,0,z,cube);set(0,1,z,cube) }
  set(1,0,0,[])
  assert.equal(terrain.transition({x:.5,y:2,z:.5},1.5,.5),null)
})

test('descent uses gravity and lands on the collision surface', () => {
  const { terrain, set } = fixture()
  set(0,0,0,cube)
  let p = {x:.5,y:1,z:.5}; let vy=-.0784; let grounded=true; let fallFrom=1; let sawAir=false
  for (let i=0;i<35;i++) {
    const next = terrain.move(p,Math.min(.05,1.5-p.x),0,vy,grounded,fallFrom)
    assert.ok(next)
    assert.ok(next.position.y >= 0)
    if (!next.onGround) { sawAir=true; assert.ok(next.velocityY<0) }
    p=next.position;vy=next.velocityY;grounded=next.onGround
    if (grounded) fallFrom=p.y
  }
  assert.equal(sawAir,true)
  assert.equal(grounded,true)
  assert.equal(p.y,0)
  assert.ok(Math.abs(p.x-1.5)<1e-6)
})

test('unknown and unsafe swept cells never become a floor or a passable corridor', () => {
  const { terrain, set } = fixture()
  set(1,0,0,null)
  assert.equal(terrain.transition({x:.5,y:0,z:.5},1.5,.5),null)
  assert.equal(terrain.canStandAt(1.5,.5,0),false)
  set(1,0,0,[]);set(1,-1,0,null)
  assert.equal(terrain.transition({x:.5,y:0,z:.5},1.5,.5),null)
})

test('jumps reach one-block tops in all directions, with swept headroom and known landing', () => {
  for (const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
    const {terrain,set}=fixture()
    set(dx,0,dz,cube)
    assert.equal(terrain.jumpTransition({x:.5,y:0,z:.5},dx+.5,dz+.5)?.y,1)
    set(dx,1,dz,cube)
    assert.equal(terrain.jumpTransition({x:.5,y:0,z:.5},dx+.5,dz+.5),null,'No two-block climbs')
    set(dx,1,dz,[]);set(0,2,0,cube)
    assert.equal(terrain.jumpTransition({x:.5,y:0,z:.5},dx+.5,dz+.5),null,'A low takeoff ceiling prevents jumping')
    set(0,2,0,null)
    assert.equal(terrain.jumpTransition({x:.5,y:0,z:.5},dx+.5,dz+.5),null,'Unknown swept space prevents jumping')
    set(0,2,0,[]);set(dx,0,dz,null)
    assert.equal(terrain.jumpTransition({x:.5,y:0,z:.5},dx+.5,dz+.5),null)
  }
  const {terrain}=fixture()
  assert.equal(terrain.jumpTransition({x:.5,y:0,z:.5},1.5,.5),null,'Do not jump on level ground or across gaps')
})

function navigationFixture () {
  const {terrain,set}=fixture()
  const {Navigator,EYE_HEIGHT}=require('../dist/navigation.js')
  const world={terrain,status:'spawned',position:{x:.5,y:EYE_HEIGHT,z:.5},navigation:{},tick:0,worldSession:1,worldRevision:1,
    chunks:new Map([['0:0',{}],['-1:0',{}],['0:-1',{}]]),setCenter:()=>{},canStandAt:(x,z,y)=>terrain.canStandAt(x,z,y)}
  const navigator=new Navigator(world);navigator.reset()
  const sent=[]
  const step=()=>{world.tick++;navigator.step((name,params)=>sent.push({name,params}),world.tick*50)}
  return {world,navigator,step,sent,set,EYE_HEIGHT}
}

test('X/Z navigation jumps once onto a full block and serializes protocol 2225 jump inputs', () => {
  const {world,navigator,step,sent,set,EYE_HEIGHT}=navigationFixture()
  set(1,0,0,cube)
  navigator.start({x:1,z:0},0)
  for(let i=0;i<300&&['planning','moving'].includes(world.navigation.status);i++)step()
  step()
  assert.equal(world.navigation.status,'arrived',world.navigation.message)
  assert.ok(Math.abs(world.position.y-EYE_HEIGHT-1)<.0001)
  assert.ok(Math.abs(world.position.x-1.5)<.08)
  assert.equal(sent.filter(p=>p.params.input_data.includes('start_jumping')).length,1)
  assert.equal(sent.filter(p=>p.params.input_data.includes('jump_released_raw')).length,1)
  const serializer=require('bedrock-protocol/src/transforms/serializer').createSerializer('1.26.60')
  for(const {name,params} of sent){
    assert.ok(params.move_vector.z<=1.00001)
    assert.ok(!params.input_data.some(flag=>/sprint|fly/.test(flag)))
    assert.ok(serializer.createPacketBuffer({name,params}).length)
  }
})

test('Stop during ascent releases jump and settles safely without further forward inputs', () => {
  const {world,navigator,step,sent,set,EYE_HEIGHT}=navigationFixture()
  set(1,0,0,cube)
  navigator.start({x:1,z:0},0)
  for(let i=0;i<50&&!sent.some(p=>p.params.input_data.includes('start_jumping'));i++)step()
  assert.ok(world.position.y>EYE_HEIGHT)
  navigator.stop()
  const count=sent.length
  for(let i=0;i<50;i++)step()
  assert.equal(world.navigation.status,'stopped',world.navigation.message)
  assert.ok(sent.slice(count).every(p=>p.params.move_vector.z===0&&!p.params.input_data.includes('start_jumping')))
  assert.ok(world.canStandAt(world.position.x,world.position.z,world.position.y-EYE_HEIGHT))
  const landedCount=sent.length;step();step();assert.equal(sent.length,landedCount)
})

test('server correction during an authorized ascent settles and replans; unrelated upward motion is rejected', () => {
  const {world,navigator,step,sent,set,EYE_HEIGHT}=navigationFixture()
  set(1,0,0,cube)
  navigator.start({x:1,z:0},0)
  for(let i=0;i<50&&!sent.some(p=>p.params.input_data.includes('start_jumping'));i++)step()
  const input=sent.at(-1).params
  navigator.serverCorrection(input.position,input.tick,input.delta,false)
  assert.equal(world.navigation.status,'planning')
  for(let i=0;i<300&&['planning','moving'].includes(world.navigation.status);i++)step()
  assert.equal(world.navigation.status,'arrived',world.navigation.message)
  assert.ok(Math.abs(world.position.y-EYE_HEIGHT-1)<.0001)
  navigator.start({x:0,z:0},world.tick*50)
  navigator.serverCorrection({...world.position,y:world.position.y+.2},10000n,{x:0,y:.3,z:0},false)
  assert.equal(world.navigation.status,'error')
})

test('drop hazards cover holes, deep drops and unknown data but not walls or half steps', () => {
  const { terrain, set } = fixture()
  assert.equal(terrain.dropHazard(1,0,0),false,'Flat ground')
  set(1,0,0,cube)
  assert.equal(terrain.dropHazard(1,0,0),false,'A wall cannot be fallen into')
  set(1,0,0,[]);set(1,-1,0,lower)
  assert.equal(terrain.dropHazard(1,0,0),false,'Half-block step down')
  set(1,-1,0,[])
  assert.equal(terrain.dropHazard(1,0,0),true,'One-block hole')
  set(1,0,0,null)
  assert.equal(terrain.dropHazard(1,0,0),true,'Unknown data')
  assert.equal(terrain.isKnownAt(1.5,.5,0),false)
  assert.equal(terrain.isKnownAt(3.5,.5,0),true)
})
