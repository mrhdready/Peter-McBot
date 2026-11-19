const {test}=require('node:test')
const assert=require('node:assert/strict')
const vm=require('node:vm')
const {mapPerformancePanel}=require('../dist/map-performance.js')

test('performance measurement reports timed draws, frame cadence and CPU deltas without navigation',async()=>{
  const elements=new Map()
  const element=id=>{
    if(!elements.has(id))elements.set(id,{textContent:'',disabled:false,before(){},scrollIntoView(){}})
    return elements.get(id)
  }
  let now=1,requests=0,pendingPointer=false
  const context=vm.createContext({
    document:{createElement:()=>({innerHTML:''}),visibilityState:'visible'},
    byId:element,navigator:{userAgent:'test-browser'},devicePixelRatio:1,navigationBusy:false,
    performance:{now:()=>now},PointerEvent:class {},
    setInterval:callback=>{queueMicrotask(callback);return 1},clearInterval(){},
    requestAnimationFrame:callback=>setImmediate(()=>{now+=1000/60;callback(now)}),
    fetch:async url=>{
      assert.equal(url,'/api/map-performance','Measurement must not send navigation or other commands')
      requests++
      return {ok:true,json:async()=>({monotonicMs:now,process:{cpu:{user:now*10,system:0},memory:{rss:100000000}},container:{cpuUsageUsec:now*20,memoryBytes:120000000,inactiveFileBytes:20000000,throttledUsec:0}})}
    },
    tickDraw:()=>{now+=.25},tickTerrain:()=>{now+=2},
    canvas:{getBoundingClientRect:()=>({left:0,top:0,width:800,height:800}),scrollIntoView(){},dispatchEvent(){
      if(!pendingPointer){pendingPointer=true;context.requestAnimationFrame(()=>{pendingPointer=false;vm.runInContext('drawMap()',context)})}
    }}
  })
  vm.runInContext(`
    let currentMap={width:112,height:112,tiles:[{raster:{}}]};
    let terrainKey='terrain'; let renderedTerrainKey='terrain';
    function paintTerrain(){if(renderedTerrainKey!==terrainKey){tickTerrain();renderedTerrainKey=terrainKey;}}
    function drawMap(){paintTerrain();tickDraw();}
  `,context)
  vm.runInContext(mapPerformancePanel.match(/<script>([\s\S]*?)<\/script>/)[1],context)
  await element('measure-map').onclick()
  assert.equal(element('measure-status').textContent,'Messung abgeschlossen.')
  const result=JSON.parse(element('measure-result').textContent)
  assert.equal(result.phases.length,3)
  assert.equal(result.width,112)
  assert.equal(result.phases[0].drawMs.count,0)
  assert.ok(result.phases[1].drawMs.count>100)
  assert.ok(result.phases[1].drawMs.max<1)
  assert.equal(result.phases[2].terrainMs.count,60)
  assert.ok(result.phases[2].terrainMs.mean>=2)
  for(const phase of result.phases){
    assert.ok(phase.rafFps>20&&phase.rafFps<=61)
    assert.ok(Math.abs(phase.containerCpuPercent-2)<.0001)
    assert.ok(Math.abs(phase.processCpuPercent-1)<.0001)
    assert.ok(Math.abs(phase.containerCpuPeakPercent-2)<.0001,'Cached duplicate counter samples must not make the peak NaN')
    assert.equal(phase.containerWorkingSetBytes.mean,100000000)
  }
  assert.equal(requests,9)
  context.document.visibilityState='hidden'
  await element('measure-map').onclick()
  assert.match(element('measure-status').textContent,/Tab muss sichtbar bleiben/)
  assert.equal(element('measure-map').disabled,false)
})
