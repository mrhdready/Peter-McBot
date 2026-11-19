// One-way descent test for a dedicated test player: no blocks are changed and no return jump is attempted.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const base = process.env.NAV_WEB_BASE
if (!base || process.env.TERRAIN_TEST_PLAYER !== 'MCBotTerrain') throw new Error('Use a dedicated MCBotTerrain deployment and set NAV_WEB_BASE and TERRAIN_TEST_PLAYER=MCBotTerrain')
const signal = AbortSignal.timeout(120000)
const wait = ms => new Promise(resolve => setTimeout(resolve,ms))
const read = path => fetch(base+path,{signal}).then(async r=>{assert.equal(r.status,200);return r.json()})
const post = async (path,target) => {
  const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:target?JSON.stringify(target):undefined,signal})
  assert.equal(r.status,202,await r.text())
}
async function until (predicate,ms=35000) {
  const end=Date.now()+ms
  while(Date.now()<end){const s=await read('/api/status');assert.ok(!['error','dead'].includes(s.status),s.lastError);if(predicate(s))return s;await wait(50)}
  throw new Error('Timed out: '+JSON.stringify(await read('/api/status')))
}
const report={checkedAt:new Date().toISOString(),base,player:'MCBotTerrain',result:'failed'}
async function main(){
  await until(s=>s.status==='spawned'&&s.coverage.complete)
  const s=await read('/api/status');const start=report.start=s.position;const feet=Math.round((start.y-1.62)*2)/2
  const map=await read('/api/map');const candidates=[]
  map.cells.forEach((c,i)=>{
    if(!c||!c[2]||c[1]===null||Math.abs(c[1]+1-(feet-1))>.001||!/^minecraft:(grass_block|dirt|stone|sand|gravel|cobblestone)$/.test(map.palette[c[0]]))return
    const x=map.x+i%map.width;const z=map.z+Math.floor(i/map.width);const d=Math.hypot(x+.5-start.x,z+.5-start.z)
    if(d<=12)candidates.push({x,z,d})
  })
  candidates.sort((a,b)=>a.d-b.d);assert.ok(candidates.length,'No nearby one-block descent in known terrain')
  report.candidates=candidates.slice(0,8)
  for(const target of candidates.slice(0,8)){
    await post('/api/navigate',{x:target.x,z:target.z});await wait(100)
    let stopSent=false
    const end=Date.now()+20000
    let current
    while(Date.now()<end){
      current=await read('/api/status')
      if(!stopSent&&current.navigation.status==='moving'&&current.position.y<start.y-.005&&current.position.y>start.y-.95){
        report.inAir=current.position;await post('/api/stop_navigation');stopSent=true
      }
      if(!['planning','moving','idle'].includes(current.navigation.status)&&Math.abs(current.position.y-1.62-(feet-1))<.001)break
      if(current.navigation.status==='error')break
      await wait(50)
    }
    console.log('terrain candidate',JSON.stringify({target,position:current?.position,navigation:current?.navigation,stopSent}))
    if(current&&['stopped','arrived'].includes(current.navigation.status)&&Math.abs(current.position.y-1.62-(feet-1))<.001){
      report.target={x:target.x,z:target.z};report.predictedLanding=current.position;report.stopDuringFall=stopSent
      await post('/api/disconnect');await wait(500);await post('/api/connect')
      const server=await until(s=>s.status==='spawned'&&s.position&&Math.abs(s.position.y)<1000)
      report.serverLanding=server.position
      assert.ok(Math.abs(server.position.y-start.y+1)<.1,'Server did not confirm a one-block descent')
      assert.ok(Math.hypot(server.position.x-current.position.x,server.position.z-current.position.z)<.4,'Server and predicted landing differ')
      report.result='passed';return
    }
    assert.ok(current&&Math.hypot(current.position.x-start.x,current.position.z-start.z)<.1&&Math.abs(current.position.y-start.y)<.1,'A rejected candidate moved the test player; stop further trials')
  }
  throw new Error('No candidate could be traversed')
}
main().catch(error=>{report.error=error.stack||error.message;console.error(report.error);process.exitCode=1}).finally(async()=>{
  await post('/api/stop_navigation').catch(()=>{});await post('/api/disconnect').catch(()=>{})
  fs.mkdirSync('data',{recursive:true});fs.writeFileSync('data/terrain-smoke-result.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report))
})
