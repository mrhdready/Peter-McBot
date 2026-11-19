const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtemp, rm, readdir, stat, writeFile, readFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { MapArchive } = require('../dist/map-archive.js')
const { BotController } = require('../dist/bot.js')
const { readConfig } = require('../dist/config.js')
const { createWebServer } = require('../dist/web.js')
const { once } = require('node:events')
const cell = (name = 'minecraft:stone', y = 63, confirmed = true) => [name, y, confirmed]
const tile = (x = -1, z = -2, dimension = 0, value = cell()) => ({ x, z, dimension, cells: Array.from({length:256}, () => value && [...value]) })
async function directory (t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mc-map-'))
  t.after(() => rm(root, { recursive:true, force:true }))
  return root
}

test('surface archive survives restart, isolates worlds and dimensions, and preserves better observations', async t => {
  const root = await directory(t)
  const archive = new MapArchive(root, 'server-a', 'world-a')
  archive.observe(tile())
  await archive.flush()
  const live = await archive.tile(0, -1, -2, tile().cells)
  assert.ok(live.live.every(Boolean))
  const restarted = new MapArchive(root, 'server-a', 'world-a')
  const historical = await restarted.tile(0, -1, -2, null)
  assert.deepEqual(historical.cells, tile().cells)
  assert.ok(historical.live.every(v => !v))
  assert.notEqual(live.hash, historical.hash, 'Live status participates in the presentation fingerprint')
  restarted.observe(tile(-1, -2, 0, null))
  restarted.observe(tile(-1, -2, 0, cell('minecraft:dirt', 2, false)))
  await restarted.flush()
  assert.deepEqual((await restarted.tile(0,-1,-2,null)).cells[0],cell())
  restarted.observe(tile(-1, -2, 0, cell('minecraft:air', null)))
  await restarted.flush()
  assert.deepEqual((await new MapArchive(root,'server-a','world-a').tile(0,-1,-2,null)).cells[0],cell('minecraft:air',null),'Confirmed air replaces an old surface')
  for (const other of [new MapArchive(root,'server-b','world-a'),new MapArchive(root,'server-a','world-b')]) {
    assert.ok((await other.tile(0,-1,-2,null)).cells.every(v=>v===null))
  }
  assert.ok((await archive.tile(1,-1,-2,null)).cells.every(v=>v===null))
})

test('unchanged observations do not rewrite tiles; cache eviction and concurrent flushes retain changes', async t => {
  const root = await directory(t)
  const archive = new MapArchive(root,'server','world')
  archive.observe(tile()); await archive.flush()
  const folder = (await readdir(root))[0]
  const file = path.join(root,folder,'0','-1,-2.json')
  const before = await stat(file)
  archive.observe(tile()); await archive.flush()
  assert.equal((await stat(file)).ino, before.ino)
  for (let x=0;x<140;x++) archive.observe(tile(x,0))
  await Promise.all([archive.flush(), archive.tile(0,0,0,null), archive.tile(0,-1,-2,null)])
  archive.observe(tile(0,0,0,cell('minecraft:water',64)))
  const inProgress=archive.flush()
  archive.observe(tile(0,0,0,cell('minecraft:water',65)))
  await Promise.all([inProgress, archive.flush(), archive.tile(0,139,0,null)])
  const restarted = new MapArchive(root,'server','world')
  assert.deepEqual((await restarted.tile(0,0,0,null)).cells[0],cell('minecraft:water',65))
  assert.deepEqual((await restarted.tile(0,139,0,null)).cells[0],cell())
  assert.equal((await readdir(path.join(root,folder,'0'))).filter(name=>name.endsWith('.tmp')).length,0)
  await archive.tile(0,500,0,null)
  archive.observe(tile(500,0));await archive.flush()
  for(let x=600;x<740;x++)await archive.tile(0,x,0,null)
  assert.deepEqual((await archive.tile(0,500,0,null)).cells[0],cell(),'Saved tiles invalidate cached file absence before eviction')
})

test('a corrupt tile is reported and never overwritten by fresh observations', async t => {
  const root = await directory(t)
  const archive = new MapArchive(root,'server','world')
  archive.observe(tile()); await archive.flush()
  const file = path.join(root,(await readdir(root))[0],'0','-1,-2.json')
  await writeFile(file, '{broken')
  const restarted = new MapArchive(root,'server','world')
  restarted.observe(tile())
  await assert.rejects(restarted.flush())
  assert.ok(restarted.error)
  assert.equal(await readFile(file,'utf8'),'{broken')
})

test('tile HTTP uses fingerprints, conditional requests, bounded viewports and historical data offline', async t => {
  const archive = new MapArchive(await directory(t),'server','world')
  archive.observe(tile()); await archive.flush()
  const bot = new BotController(readConfig({BEDROCK_HOST:'localhost'}),()=>{throw Error('unused')})
  const web = createWebServer(bot, archive)
  t.after(()=>{bot.stop();web.close()})
  web.server.listen(0,'127.0.0.1'); await once(web.server,'listening')
  const base = `http://127.0.0.1:${web.server.address().port}`
  const manifest = await fetch(base+'/api/map/tiles?dimension=0&x=-1&z=-2&width=1&height=1').then(r=>r.json())
  assert.equal(manifest.tiles.length,1)
  assert.equal(manifest.tiles[0].cells,undefined)
  assert.equal(manifest.tiles[0].empty,false)
  const url = base+'/api/map/tile?dimension=0&x=-1&z=-2'
  const first = await fetch(url)
  const data = await first.json()
  assert.equal(data.hash,manifest.tiles[0].hash)
  assert.ok(data.live.every(v=>!v))
  const unchanged = await fetch(url,{headers:{'If-None-Match':first.headers.get('etag')}})
  assert.equal(unchanged.status,304)
  assert.equal(await unchanged.text(),'')
  for(const query of ['dimension=0&x=0&z=0&width=9&height=1','dimension=0&x=&z=0&width=1&height=1','dimension=3&x=0&z=0&width=1&height=1','dimension=0&x=0.5&z=0&width=1&height=1']) {
    assert.equal((await fetch(base+'/api/map/tiles?'+query)).status,400)
  }
  const emptyManifest=await fetch(base+'/api/map/tiles?dimension=0&x=50&z=50&width=1&height=1').then(r=>r.json())
  assert.equal(emptyManifest.tiles[0].empty,true,'Unknown tiles can be skipped without fetching their bodies')
  const page = await fetch(base).then(r=>r.text())
  assert.match(page,/const archiveEnabled = true;/)
  assert.match(page,/id="map-ground"/)
})

test('bot records surfaces without HTTP, including pending updates on eviction and disconnect', {timeout:10000}, async t => {
  const archive = new MapArchive(await directory(t),'server','world')
  const bot = new BotController(readConfig({BEDROCK_HOST:'localhost'}),()=>{throw Error('unused')})
  t.after(()=>bot.stop())
  bot.state.onSurfaceTile = value=>archive.observe(value)
  bot.state.beginWorld('overworld',true)
  bot.state.setCenter({x:-1,y:64,z:-1})
  const end = Date.now()+5000
  while(!bot.state.coverage().ready&&Date.now()<end) await new Promise(resolve=>setTimeout(resolve,10))
  assert.equal(bot.state.coverage().ready,true)
  bot.state.requestSubchunks(packet=>{},Date.now())
  // Replies use outstanding requests; fill the complete closest column with known air.
  const column = bot.state.chunks.get('-1:-1')
  for(let y=-4;y<=19;y++) {
    column.requests.set(y,{id:y+10,at:Date.now(),phase:'requested',updates:new Map()})
  }
  bot.state.receiveSubchunks({dimension:0,cache_enabled:false,origin:{x:-1,y:0,z:-1},entries:Array.from({length:24},(_,i)=>({dx:0,dy:i-4,dz:0,result:'success_all_air'}))})
  bot.step()
  await archive.flush()
  assert.deepEqual((await archive.tile(0,-1,-1,null)).cells[0],cell('minecraft:air',null))
  const registry = require('prismarine-registry')('bedrock_1.26.60')
  registry.handleStartGame({itemstates:[],block_network_ids_are_hashes:true})
  const stone = Number(Object.entries(registry.blocksByRuntimeId).find(([, block])=>block.stateId===registry.blocksByName.stone.defaultState)[0]) >>> 0
  bot.state.updateBlock({x:-16,y:63,z:-16},stone)
  const revision=bot.state.worldRevision
  bot.state.updateBlock({x:-16,y:63,z:-16},stone)
  assert.equal(bot.state.worldRevision,revision,'An identical block update does not invalidate surface caches')
  bot.state.setCenter({x:1000,y:64,z:1000})
  await archive.flush()
  assert.deepEqual((await archive.tile(0,-1,-1,null)).cells[0],cell())
  for(let i=0;i<3;i++)bot.state.requestSubchunks((name,packet)=>{
    bot.state.receiveSubchunks({dimension:0,cache_enabled:false,origin:packet.origin,entries:packet.requests.map(p=>({dx:p.x,dy:p.y,dz:p.z,result:'success_all_air'}))})
  })
  bot.state.updateBlock({x:992,y:63,z:992},stone)
  const periodic=archive.flush()
  bot.stop(); await Promise.all([periodic,archive.flush()])
  assert.deepEqual((await archive.tile(0,62,62,null)).cells[0],cell(),'Disconnect records the last dirty surface before clearing chunks')
  assert.equal(bot.state.collisionAt(-16,63,-16),null,'Archive does not become navigation terrain')
})

test('browser reuses terrain rasters, batches pointer events, pans without navigation and ignores obsolete viewports', async t => {
  const vm = require('node:vm')
  const archive = new MapArchive(await directory(t),'server','world')
  const bot = new BotController(readConfig({BEDROCK_HOST:'localhost'}),()=>{throw Error('unused')})
  const web = createWebServer(bot,archive)
  t.after(()=>{bot.stop();web.close()})
  web.server.listen(0,'127.0.0.1'); await once(web.server,'listening')
  const page = await fetch(`http://127.0.0.1:${web.server.address().port}`).then(r=>r.text())
  const elements = new Map(); const frames=[]; const requests=[]
  let rasterPaints=0, groundPaints=0, overlayPaints=0, events, now=10000, nextHash='a', lateManifest=null, emptyTiles=false
  function element (tag) {
    const id = tag
    const context = new Proxy({}, {get(target,key) {
      if(key==='fillRect') return ()=>{if(id==='map-ground')groundPaints++}
      if(key==='createImageData')return (width,height)=>({width,height,data:new Uint8ClampedArray(width*height*4)})
      if(key==='putImageData')return ()=>{if(id==='canvas')rasterPaints++}
      if(key==='clearRect') return ()=>{if(id==='map')overlayPaints++}
      return target[key]||(()=>{})
    }})
    return {style:{},children:[],value:'',hidden:false,width:0,height:0,replaceChildren(...items){this.children=items},append(item){this.children.push(item)},
      getContext:()=>context,getBoundingClientRect:()=>({left:0,top:0,width:224,height:224}),setPointerCapture(){}}
  }
  const byId = id=>{if(!elements.has(id))elements.set(id,element(id));return elements.get(id)}
  class Clock extends Date {static now(){return now}}
  const browser = vm.createContext({document:{getElementById:byId,createElement:element},AbortController,URLSearchParams,setTimeout,clearTimeout,Date:Clock,
    requestAnimationFrame:callback=>{frames.push(callback);return frames.length},
    EventSource:class {constructor(){events=this}},
    fetch:async (url,options)=>{
      requests.push(url)
      if(url.startsWith('/api/map/tiles?')) {
        if(lateManifest) return lateManifest
        const query=new URL('http://local'+url).searchParams
        const tiles=[]
        for(let z=0;z<Number(query.get('height'));z++)for(let x=0;x<Number(query.get('width'));x++)tiles.push({x:Number(query.get('x'))+x,z:Number(query.get('z'))+z,hash:nextHash,empty:emptyTiles&&Number(query.get('x'))+x===-1&&Number(query.get('z'))+z===-1})
        return {ok:true,json:async()=>({session:0,tiles})}
      }
      if(url.startsWith('/api/map/tile?')) {
        const query=new URL('http://local'+url).searchParams
        return {ok:true,json:async()=>({...tile(Number(query.get('x')),Number(query.get('z')),Number(query.get('dimension'))),live:Array(256).fill(false),hash:nextHash,session:0})}
      }
      return {ok:true,json:async()=>({blockIds:[]})}
    }
  })
  vm.runInContext(page.match(/<script>([\s\S]*?)<\/script>/)[1],browser)
  const settle=()=>new Promise(resolve=>setImmediate(resolve))
  const state={status:'disconnected',position:null,dimension:null,coverage:{session:0,ready:false},worldRevision:0}
  const publish=async()=>{events.onmessage({data:JSON.stringify(state)});await settle()}
  await publish()
  assert.equal(byId('map').hidden,false,'Historical map is visible without a live registry')
  assert.ok(rasterPaints>0)
  const painted=rasterPaints, terrain=groundPaints
  const tileRequests=()=>requests.filter(url=>url.startsWith('/api/map/tile?')).length
  const count=tileRequests()
  now+=6000;await publish()
  assert.equal(tileRequests(),count,'Unchanged manifest does not fetch tile bodies')
  assert.equal(rasterPaints,painted)
  assert.equal(groundPaints,terrain,'Unchanged map does not repaint the terrain layer')
  const canvas=byId('map');const before=overlayPaints
  for(let i=0;i<100;i++)canvas.onpointermove({clientX:30+i,clientY:30})
  assert.equal(frames.length,1)
  assert.equal(overlayPaints,before)
  frames.shift()()
  assert.equal(overlayPaints,before+1,'One pointer frame causes one overlay redraw')
  assert.equal(rasterPaints,painted,'Pointer movement never rasterizes terrain')
  assert.match(byId('map-info').textContent,/Historische Beobachtung/)
  canvas.onpointerdown({clientX:100,clientY:100,button:0,pointerId:1})
  canvas.onpointermove({clientX:150,clientY:100});frames.shift()()
  canvas.onpointerup({clientX:150,clientY:100});canvas.onclick({clientX:150,clientY:100})
  await settle()
  assert.equal(byId('target-x').value,'','Dragging does not select a navigation target')
  assert.ok(!requests.includes('/api/navigate'))
  byId('map-zoom-in').onclick();await settle()
  assert.equal(canvas.width,56)
  let finish
  lateManifest=new Promise(resolve=>{finish=resolve})
  byId('map-zoom-in').onclick()
  lateManifest=null
  byId('map-zoom-out').onclick();await settle()
  finish({ok:true,json:async()=>({session:0,tiles:[]})});await settle()
  assert.equal(canvas.width,56,'An obsolete viewport cannot overwrite the newer zoom')
  nextHash='b';now+=6000;await publish()
  assert.ok(rasterPaints>painted,'Changed fingerprint replaces the cached raster')
  byId('map-dimension').value='1';byId('map-dimension').onchange();await settle()
  canvas.onclick({clientX:100,clientY:100})
  assert.match(byId('nav-feedback').textContent,/aktuell verbundenen Dimension/)
  byId('map-home').onclick();await settle()
  const beforeHome=groundPaints, beforeHomeRaster=rasterPaints
  byId('map-home').onclick();await settle()
  assert.ok(groundPaints>beforeHome,'Returning to the same viewport restores its cleared ground layer')
  assert.equal(rasterPaints,beforeHomeRaster,'Returning home reuses the tile rasters')
  assert.equal(canvas.width,56)
  assert.ok(!requests.includes('/api/navigate'))
  for(let zoom=0;zoom<4;zoom++){byId('map-zoom-out').onclick();await settle()}
  assert.equal(canvas.width,448,'Overview zoom reaches four times the initial width and remains bounded')
  for(const url of requests.filter(url=>url.startsWith('/api/map/tiles?'))){
    const query=new URL('http://local'+url).searchParams
    assert.ok(Number(query.get('width'))<=8&&Number(query.get('height'))<=8,'Large views use bounded manifest pages')
  }
  const overviewRequests=tileRequests()
  now+=6000;await publish()
  assert.equal(tileRequests(),overviewRequests,'Visible tiles beyond the small LRU remain reusable on overview refresh')
  emptyTiles=true;now+=6000;await publish()
  assert.equal(tileRequests(),overviewRequests,'Empty tiles do not trigger body requests')
  canvas.onpointermove({clientX:104.25,clientY:104.25});frames.shift()()
  assert.match(byId('map-info').textContent,/Unbekannte Daten/,'A tile removed by the manifest clears its old terrain')
  state.status='spawned';state.dimension=0;state.position={x:0,y:64,z:0};state.coverage.ready=true
  await publish()
  assert.equal(byId('find').disabled,false,'The search button re-enables once the live registry becomes ready')
})

test('archive reports a saturated observation queue instead of silently claiming a successful flush', async t => {
  const archive = new MapArchive(await directory(t),'server','world')
  for(let x=0;x<300;x++) archive.observe(tile(x,0))
  await assert.rejects(archive.flush(),/backlog/)
  assert.match(archive.error,/could not be recorded/)
})
