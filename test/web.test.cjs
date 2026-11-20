const { test } = require('node:test')
const assert = require('node:assert/strict')
const { once } = require('node:events')
const { BotController } = require('../dist/bot.js')
const { readConfig } = require('../dist/config.js')
const { createWebServer } = require('../dist/web.js')

test('HTTP queues commands, validates requests, and streams state using SSE', async t => {
  const bot = new BotController(readConfig({ BEDROCK_HOST: 'localhost' }), () => { throw new Error('test factory') })
  const web = createWebServer(bot)
  t.after(() => { bot.stop(); web.close() })
  web.server.listen(0, '127.0.0.1')
  await once(web.server, 'listening')
  const base = `http://127.0.0.1:${web.server.address().port}`
  const page = await fetch(base).then(r => r.text())
  new (require('node:vm').Script)(page.match(/<script>([\s\S]*?)<\/script>/)[1])
  // The page is assembled from dist/ui with inline style and exactly one inline script.
  assert.equal(page.match(/<script>/g).length, 1)
  assert.match(page, /<style>[\s\S]*--sidebar[\s\S]*<\/style>/)
  assert.doesNotMatch(page, /<!-- ui:/)
  assert.match(page, /const archiveEnabled = false;/)
  assert.match(page, /id="sidebar"/)
  assert.match(page, /id="connection-toggle"/)
  assert.match(page, /list="block-ids"/)
  assert.match(page, /<datalist id="block-ids">/)
  assert.match(page, /<canvas id="map"/)
  assert.doesNotMatch(page, /id="measure-map"/)
  const measurementPage = await fetch(base + '/?measure=1').then(r => r.text())
  for (const script of measurementPage.matchAll(/<script>([\s\S]*?)<\/script>/g)) new (require('node:vm').Script)(script[1])
  assert.match(measurementPage, /id="measure-map"/)
  assert.match(measurementPage, /byId\('sidebar'\)\.append\(panel\)/, 'Measurement panel joins the sidebar, not the map overlay')
  const archived = createWebServer(bot, {})
  t.after(() => archived.close())
  archived.server.listen(0, '127.0.0.1')
  await once(archived.server, 'listening')
  assert.match(await fetch(`http://127.0.0.1:${archived.server.address().port}`).then(r => r.text()), /const archiveEnabled = true;/)
  const metrics = await fetch(base + '/api/map-performance').then(r => r.json())
  assert.ok(metrics.process.memory.rss > 0)
  assert.ok(metrics.process.cpu.user >= 0 && metrics.process.cpu.system >= 0)
  assert.ok(metrics.monotonicMs > 0)
  assert.ok(metrics.container.cpuUsageUsec === null || metrics.container.cpuUsageUsec >= 0)
  assert.equal((await fetch(base + '/api/map')).status, 409)
  assert.deepEqual(await fetch(base + '/api/block-ids').then(r => r.json()), { blockIds: [] })
  assert.equal((await fetch(base + '/api/status').then(r => r.json())).status, 'disconnected')
  assert.equal((await fetch(base + '/api/blocks?block=stone')).status, 409)
  assert.equal((await fetch(base + '/api/blocks?block=%3Cbad%3E')).status, 400)
  assert.equal((await fetch(base + '/api/blocks?block=stone&limit=101')).status, 400)
  assert.equal((await fetch(base + '/api/connect', { method: 'POST' })).status, 415)
  assert.equal((await fetch(base + '/api/connect', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://foreign.example' } })).status, 403)
  assert.equal((await fetch(base + '/api/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 400)
  assert.equal((await fetch(base + '/api/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' } })).status, 202)
  assert.equal(bot.state.status, 'disconnected')
  bot.step()
  assert.equal(bot.state.status, 'reconnecting')
  const abort = new AbortController()
  t.after(() => abort.abort())
  const events = await fetch(base + '/api/events', { signal: abort.signal })
  assert.match(events.headers.get('content-type'), /text\/event-stream/)
  const reader = events.body.getReader()
  const data = new TextDecoder().decode((await reader.read()).value)
  assert.match(data, /"status":"reconnecting"/)
  await reader.cancel()
  assert.equal((await fetch(base + '/missing')).status, 404)
})

test('HTTP block search returns bounded nearest world coordinates from known data', { timeout: 10000 }, async t => {
  const bot = new BotController(readConfig({ BEDROCK_HOST: 'localhost' }), () => { throw new Error('unused') })
  const web = createWebServer(bot)
  t.after(() => { bot.stop(); web.close() })
  bot.state.beginWorld('overworld', true)
  bot.state.position = { x: -1, y: 0, z: -1 }
  bot.state.setCenter(bot.state.position)
  const end = Date.now() + 5000
  while (!bot.state.coverage().ready && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(bot.state.coverage().ready, true)
  bot.state.receiveColumn({ x: -1, z: -1, dimension: 0, cache_enabled: false })
  bot.state.requestSubchunks(() => {})
  bot.state.receiveSubchunks({ dimension: 0, cache_enabled: false, origin: { x: -1, y: 0, z: -1 }, entries: [{ dx: 0, dy: 0, dz: 0, result: 'success_all_air' }] })
  web.server.listen(0, '127.0.0.1')
  await once(web.server, 'listening')
  const base = `http://127.0.0.1:${web.server.address().port}`
  const idsResponse = await fetch(base + '/api/block-ids')
  assert.equal(idsResponse.status, 200)
  const { blockIds } = await idsResponse.json()
  const registry = require('prismarine-registry')('bedrock_1.26.60')
  const expected = Object.keys(registry.blocksByName).map(name => 'minecraft:' + name).sort()
  assert.deepEqual(blockIds, expected)
  assert.ok(blockIds.includes('minecraft:diamond_ore'))
  assert.ok(blockIds.includes('minecraft:deepslate_diamond_ore'))
  const mapResponse = await fetch(base + '/api/map')
  assert.equal(mapResponse.status, 200)
  const map = await mapResponse.json()
  assert.equal(map.width, 144)
  assert.equal(map.cells.length, 144 * 144)
  assert.ok(map.cells.every(cell => cell === null), 'Air below unknown sections is not a surface')
  const response = await fetch(base + '/api/blocks?block=minecraft:air&limit=2')
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.hits.length, 2)
  assert.deepEqual(result.hits[0], { x: -1, y: 0, z: -1, distance: 0 })
  assert.equal(result.coverage.complete, false)
  assert.equal((await fetch(base + '/api/blocks?block=not_a_block')).status, 400)
  bot.state.clearChunks()
  assert.deepEqual(await fetch(base + '/api/block-ids').then(r => r.json()), { blockIds: [] })
  assert.equal((await fetch(base + '/api/map')).status, 409)
})

test('map markers select underground hits, survive map refresh and discard obsolete searches', async t => {
  const vm = require('node:vm')
  const bot = new BotController(readConfig({ BEDROCK_HOST: 'localhost' }), () => { throw new Error('unused') })
  const web = createWebServer(bot)
  t.after(() => { bot.stop(); web.close() })
  web.server.listen(0, '127.0.0.1')
  await once(web.server, 'listening')
  const page = await fetch(`http://127.0.0.1:${web.server.address().port}`).then(r => r.text())
  const elements = new Map()
  const arcs = []
  const rectangles = []
  const strokes = []; let points = []
  const context = new Proxy({}, { get (target,key) {
    if(key==='createImageData')return (width,height)=>({width,height,data:new Uint8ClampedArray(width*height*4)})
    if(key==='arc')return (...args)=>arcs.push({args,color:context.fillStyle})
    if(key==='strokeRect')return (...args)=>rectangles.push({args,color:context.strokeStyle})
    if(key==='beginPath')return ()=>{points=[]}
    if(key==='moveTo'||key==='lineTo')return (...args)=>points.push(args)
    // A rounded corner records its waypoint (the curve's control point).
    if(key==='quadraticCurveTo')return (cx,cz)=>points.push([cx,cz])
    // Records the line width and dash pattern of the route.
    if(key==='stroke')return ()=>strokes.push({color:context.strokeStyle,width:context.lineWidth,dash:target.dash||[],points:points.map(p=>[...p])})
    if(key==='setLineDash')return dash=>{target.dash=dash}
    return target[key]||(()=>{})
  } })
  // Elements expose `style` for the DOM pins.
  const element = () => ({
    children: [], textContent: '', value: '', hidden: false, disabled: false, style: {},
    replaceChildren (...children) { this.children = children },
    append (child) { this.children.push(child) },
    getContext: () => context,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 32, height: 32 })
  })
  const byId = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id) }
  const coverage = { session: 1, ready: true, knownSubchunks: 24, totalSubchunks: 1176, completeChunks: 1, expectedChunks: 49, radius: 4 }
  const map = { x: -16, z: -16, width: 32, height: 32, palette: ['minecraft:stone'], cells: Array(1024).fill(null), coverage }
  const state = { status: 'spawned', position: { x: 0, y: 70, z: 0 }, loadedChunks: 1, coverage }
  state.positionSource = 'predicted'
  state.navigation = { status: 'moving', target: { x: -2, z: 3 }, feetY: 68, remaining: 3, message: null,
    path:[{x:.5,y:68,z:.5},{x:-1.5,y:68,z:.5},{x:-1.5,y:68,z:3.5}] }
  let result = { blockId: 'minecraft:diamond_ore', hits: [
    { x: -1, y: 5, z: -1, distance: 65 }, { x: -1, y: -6, z: -1, distance: 76 }, { x: 4, y: 7, z: 5, distance: 64 }
  ], coverage, outcome: 'found' }
  let events, pendingSearch, pendingPreview
  const requests = []
  let now = 10000
  class Clock extends Date { static now () { return now } }
  const browser = vm.createContext({
    document: { getElementById: byId, createElement: element },
    Date: Clock, AbortController, URLSearchParams, setTimeout, clearTimeout,
    requestAnimationFrame: callback => { callback(); return null },
    EventSource: class { constructor () { events = this } },
    fetch: async (url, options) => {
      requests.push({ url, options })
      if (url.startsWith('/api/blocks?') && pendingSearch) return pendingSearch
      if (url === '/api/preview') {
        if(pendingPreview)return pendingPreview
        const target=JSON.parse(options.body)
        return {ok:true,json:async()=>({target,origin:{...state.position},session:state.coverage.session,revision:state.worldRevision??0,
          path:[{x:state.position.x,y:68,z:state.position.z},{x:target.x+.5,y:68,z:target.z+.5}]})}
      }
      const body = url === '/api/map' ? map : url === '/api/block-ids' ? { blockIds: ['minecraft:diamond_ore'] } : result
      return { ok: true, json: async () => body }
    }
  })
  vm.runInContext(page.match(/<script>([\s\S]*?)<\/script>/)[1], browser)
  const publish = async () => { events.onmessage({ data: JSON.stringify(state) }); await new Promise(resolve => setImmediate(resolve)) }
  const submit = () => byId('search').onsubmit({ preventDefault () {} })
  await publish()
  assert.deepEqual(strokes.filter(s=>s.color==='#111111').at(-1).points,[[16,16],[16.5,16.5],[14.5,16.5],[14.5,19.5]],'Route projects actual world positions into the map')
  // 2 screen pixels at 1 pixel per block; active navigation is solid.
  assert.equal(strokes.filter(s=>s.color==='#111111').at(-1).width,2)
  // The dash array comes from the vm realm, so compare its length instead of its prototype.
  assert.equal(strokes.filter(s=>s.color==='#111111').at(-1).dash.length,0)
  const botPin = byId('map-pins').children.find(pin => pin.textContent === '🤖')
  assert.ok(botPin, 'The bot is a pin')
  assert.equal(botPin.style.left, '50%')
  assert.equal(botPin.style.top, '50%')
  // Other players get an animal chip chosen by name; hovering shows name, position and distance.
  state.players = [{ id: '20', name: 'Alex', x: 8, y: 65.62, z: 0 }]
  await publish()
  const playerPin = byId('map-pins').children.find(pin => pin.className.includes('pin-player'))
  assert.ok(playerPin, 'A nearby player is a pin')
  assert.notEqual(playerPin.textContent, '🤖')
  assert.equal(playerPin.style.left, '75%')
  assert.equal(playerPin.style.top, '50%')
  state.players = [{ id: '20', name: 'Alex', x: 8, y: 65.62, z: -8 }]
  await publish()
  assert.equal(byId('map-pins').children.find(pin => pin.className.includes('pin-player')).textContent, playerPin.textContent, 'A player keeps the same animal')
  byId('map').onpointermove({ clientX: 24, clientY: 8 })
  assert.equal(byId('map-pin-overlay').hidden, false)
  assert.equal(byId('map-pin-overlay').textContent, playerPin.textContent + ' Alex\nX: 8.0, Y: 65.6, Z: -8.0\n11 Blöcke vom Bot entfernt')
  state.players = []
  await publish()
  assert.ok(!byId('map-pins').children.some(pin => pin.className.includes('pin-player')), 'A player out of range disappears')
  assert.equal(byId('map-pin-overlay').hidden, true, 'Its overlay disappears with it')
  state.position={x:-.5,y:69.62,z:.5}
  state.navigation.path=state.navigation.path.slice(1);state.navigation.remaining=2
  await publish()
  assert.deepEqual(strokes.filter(s=>s.color==='#111111').at(-1).points,[[15.5,16.5],[14.5,16.5],[14.5,19.5]],'Status updates move the origin and remove completed waypoints')
  for(const status of ['planning','stopped','arrived','error']){
    state.navigation.status=status;strokes.length=0;await publish()
    assert.ok(!strokes.some(s=>s.color==='#111111'),'No obsolete route for '+status)
  }
  state.navigation.status='moving';await publish()
  strokes.length=0;events.onerror()
  assert.ok(!strokes.some(s=>s.color==='#111111'),'Connection loss hides a potentially stale route')
  await publish()
  // One toggle sends the command that matches the connection state.
  assert.equal(byId('connection-toggle').textContent, 'Trennen')
  assert.equal(byId('status').textContent, 'Verbunden')
  await byId('connection-toggle').onclick()
  assert.equal(requests.at(-1).url, '/api/disconnect')
  state.status = 'disconnected'; await publish()
  assert.equal(byId('connection-toggle').textContent, 'Verbinden')
  await byId('connection-toggle').onclick()
  assert.equal(requests.at(-1).url, '/api/connect')
  state.status = 'spawned'; await publish()
  assert.match(byId('position').textContent, /Client-Prognose/)
  assert.match(byId('nav-status').textContent, /Unterwegs.*X: -2, Z: 3/)
  assert.equal(byId('nav-start').disabled, true)
  byId('target-x').value = '-2'; byId('target-z').value = '3'
  await byId('navigate').onsubmit({ preventDefault () {} })
  const navigationRequest = requests.find(r => r.url === '/api/navigate')
  assert.deepEqual(JSON.parse(navigationRequest.options.body), { x: -2, z: 3 })
  await byId('nav-stop').onclick()
  assert.ok(requests.some(r => r.url === '/api/stop_navigation' && r.options.method === 'POST'))
  byId('block').value = 'diamond_ore'; byId('limit').value = '3'
  await submit()
  assert.match(byId('map-hit-info').textContent, /3 Treffer/)
  assert.equal(byId('hits').children.length, 3)
  // The hit list sets the target without starting movement.
  const navigateRequests = requests.filter(r => r.url === '/api/navigate').length
  byId('hits').children[2].children[4].children[0].onclick()
  assert.equal(byId('target-x').value, '4')
  assert.equal(byId('target-z').value, '5')
  assert.match(byId('nav-feedback').textContent, /Ziel gewählt.*X: 4, Z: 5/)
  assert.match(byId('map-hit-info').textContent, /X: 4, Y: 7, Z: 5/)
  assert.equal(requests.filter(r => r.url === '/api/navigate').length, navigateRequests, 'Choosing a hit must not start movement')
  const canvas = byId('map')
  const navigationCount = () => requests.filter(r => r.url === '/api/navigate').length
  const beforeClick = navigationCount()
  canvas.onclick({ clientX: 15.5, clientY: 15.5 })
  assert.equal(byId('target-x').value, '-1')
  assert.equal(byId('target-z').value, '-1')
  assert.equal(navigationCount(), beforeClick, 'Selecting a target must not start movement')
  assert.match(byId('nav-feedback').textContent, /Ziel gewählt.*X: -1, Z: -1/)
  const targetPin = byId('map-pins').children.find(pin => pin.textContent === '📌')
  assert.ok(targetPin, 'Chosen target has a pin')
  assert.equal(targetPin.style.left, (15.5 / 32 * 100) + '%')
  assert.equal(targetPin.style.top, (15.5 / 32 * 100) + '%')
  assert.match(byId('map-hit-info').textContent, /minecraft:diamond_ore – X: -1, Y: 5, Z: -1/)
  const choices = byId('map-hit-options').children
  assert.equal(choices.length, 2, 'Both vertical hits at one X/Z remain selectable')
  choices[1].onclick()
  assert.match(byId('map-hit-info').textContent, /Y: -6/)
  assert.ok(arcs.some(({ args }) => args[0] === 15.5 && args[1] === 15.5 && args[2] === 1.1), 'Marker uses world X/Z at the centre of the cell')
  now += 6000
  await publish()
  assert.match(byId('map-hit-info').textContent, /Y: -6/, 'Map polling preserves the selection')
  assert.equal(byId('target-x').value, '-1', 'Map polling preserves the pending navigation target')
  canvas.onpointermove({ clientX: 20.5, clientY: 21.5 })
  canvas.onkeydown({ key: 'Enter', preventDefault () {} })
  assert.equal(byId('target-x').value, '4')
  assert.equal(byId('target-z').value, '5')
  assert.equal(navigationCount(), beforeClick)
  canvas.onkeydown({ key: ' ', preventDefault () {} })
  assert.equal(byId('target-z').value, '5')
  assert.match(byId('map-hit-info').textContent, /X: 4, Y: 7, Z: 5/)
  canvas.onclick({ clientX: 0, clientY: 0 })
  assert.equal(byId('target-x').value, '-16')
  assert.equal(byId('target-z').value, '-16', 'Unknown map cells can be selected; navigation validates their safety')
  assert.match(byId('map-hit-info').textContent, /Kein Suchtreffer/)
  canvas.getBoundingClientRect = () => ({ left: 100, top: 200, width: 320, height: 320 })
  canvas.onclick({ clientX: 255, clientY: 355 })
  assert.equal(byId('target-x').value, '-1', 'Scaled map with an offset resolves negative world coordinates')
  assert.equal(byId('target-z').value, '-1')
  canvas.onclick({ clientX: 420, clientY: 520 })
  assert.equal(byId('target-x').value, '-1', 'Outside clicks do not select a cell beyond the map')
  assert.equal(navigationCount(), beforeClick)
  state.navigation.status = 'idle'
  await publish()
  assert.equal(byId('nav-start').disabled, false)
  const beforePreview=JSON.stringify(state.position)
  await new Promise(resolve=>setTimeout(resolve,300))
  assert.match(byId('preview-status').textContent,/Wegvorschau: 2 Wegpunkte/)
  assert.equal(JSON.stringify(state.position),beforePreview)
  assert.equal(navigationCount(),beforeClick,'A completed preview still does not submit navigation')
  assert.deepEqual(strokes.filter(s=>s.color==='#111111').at(-1).points.at(-1),[15.5,15.5])
  const mapCount=()=>requests.filter(r=>r.url==='/api/map').length
  const beforeMap=mapCount()
  state.navigation.status='arrived';await publish()
  assert.ok(mapCount()>beforeMap,'Arrival refreshes the map immediately, even inside the five-second interval')
  const afterArrival=mapCount()
  state.coverage={...state.coverage,knownSubchunks:25};await publish()
  assert.ok(mapCount()>afterArrival,'New chunk data refreshes the map without waiting five seconds')
  let finishPreview
  pendingPreview=new Promise(resolve=>{finishPreview=resolve})
  byId('target-x').value='-2';byId('target-x').oninput()
  await new Promise(resolve=>setTimeout(resolve,300))
  pendingPreview=null
  byId('target-x').value='-3';byId('target-x').oninput()
  await new Promise(resolve=>setTimeout(resolve,300))
  finishPreview({ok:true,json:async()=>({session:1,origin:{...state.position},path:[{x:999,y:0,z:999}]})})
  await new Promise(resolve=>setImmediate(resolve))
  assert.deepEqual(strokes.filter(s=>s.color==='#111111').at(-1).points.at(-1),[13.5,15.5],'Late preview cannot overwrite the latest target')
  byId('target-x').value='-1';byId('target-x').oninput()
  await byId('navigate').onsubmit({ preventDefault () {} })
  assert.deepEqual(JSON.parse(requests.filter(r => r.url === '/api/navigate').at(-1).options.body), { x: -1, z: -1 })
  assert.equal(byId('preview-status').textContent,'','Starting navigation removes the obsolete preview caption')
  result = { ...result, hits: [], outcome: 'unknown' }
  await submit()
  assert.equal(byId('map-hit-options').children.length, 0)
  assert.equal(byId('hits').children.length, 0)
  let finish
  pendingSearch = new Promise(resolve => { finish = resolve })
  const obsolete = submit()
  state.coverage = { ...coverage, session: 2, ready: false }
  state.position = null
  await publish()
  finish({ ok: true, json: async () => ({ ...result, hits: [{ x: 0, y: 0, z: 0 }] }) })
  await obsolete
  assert.equal(byId('hits').children.length, 0, 'Late response cannot restore hits from an old session')
  assert.equal(byId('find').disabled, false)
  assert.equal(canvas.hidden, true)
  assert.ok(!strokes.slice(-1).some(s=>s.color==='#111111'))
})

test('navigation API bounds JSON and accepts X/Z only; start and stop use the tick queue', async t => {
  const bot = new BotController(readConfig({ BEDROCK_HOST: 'localhost' }), () => { throw new Error('unused') })
  const web = createWebServer(bot)
  t.after(() => { bot.stop(); web.close() })
  web.server.listen(0, '127.0.0.1'); await once(web.server, 'listening')
  const base = `http://127.0.0.1:${web.server.address().port}`
  const post = body => fetch(base + '/api/navigate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
  const previewPost=body=>fetch(base+'/api/preview',{method:'POST',headers:{'Content-Type':'application/json'},body})
  assert.equal((await previewPost('{"x":0,"z":0}')).status,409)
  for(const body of ['bad','{"x":1.5,"z":0}','{"x":0,"z":0,"y":70}'])assert.equal((await previewPost(body)).status,400)
  assert.equal((await previewPost(' '.repeat(129))).status,413)
  assert.equal((await post('{"x":0,"z":0}')).status, 409)
  for (const body of ['bad', 'null', '[]', '{"x":0.5,"z":0}', '{"x":0,"z":0,"y":70}', '{"x":"1","z":0}', '{"x":30000001,"z":0}', '{}']) assert.equal((await post(body)).status, 400)
  assert.equal((await post(' '.repeat(129))).status, 413)
  bot.state.status = 'spawned'
  assert.equal((await post('{"x":-3,"z":2}')).status, 202)
  assert.equal(bot.state.navigation.status, 'idle')
  bot.step()
  assert.equal(bot.state.navigation.status, 'error', 'Missing world data must fail rather than move')
  assert.deepEqual(bot.state.navigation.target, { x: -3, z: 2 })
  assert.equal((await post('{"x":5,"z":5}')).status, 202)
  assert.equal((await fetch(base + '/api/stop_navigation', { method: 'POST', headers: { 'Content-Type': 'application/json' } })).status, 202)
  bot.step()
  assert.deepEqual(bot.state.navigation.target, { x: -3, z: 2 }, 'Stop discards the pending start')
})
