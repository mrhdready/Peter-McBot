const assert = require('node:assert/strict')
const base = 'http://bot:3000'
const deadline = AbortSignal.timeout(100000)
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const status = () => fetch(base + '/api/status', { signal: deadline }).then(response => {
  assert.equal(response.status, 200)
  return response.json()
})
const command = async name => {
  const response = await fetch(base + '/api/' + name, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: deadline
  })
  assert.equal(response.status, 202)
}
async function waitForSpawn () {
  const until = Date.now() + 35000
  let state
  while (Date.now() < until) {
    state = await status()
    if (state.status === 'spawned' && state.position && Math.abs(state.position.y) < 1000) return state
    assert.ok(!['dead', 'error'].includes(state.status), state.lastError)
    await wait(500)
  }
  assert.fail('No final spawn position: ' + JSON.stringify(state))
}
async function main () {
  require('node:child_process').execFileSync(process.execPath, ['--test', '--test-isolation=none', '/app/test/terrain.test.cjs'], { stdio: 'inherit', timeout: 15000 })
  assert.equal((await fetch(base + '/healthz', { signal: deadline })).status, 200)
  const page = await fetch(base, { signal: deadline }).then(response => response.text())
  assert.match(page, /Minecraft AFK-Bot/)
  new (require('node:vm').Script)(page.match(/<script>([\s\S]*?)<\/script>/)[1])
  const eventsAbort = new AbortController()
  const events = await fetch(base + '/api/events', { signal: AbortSignal.any([deadline, eventsAbort.signal]) })
  assert.match(events.headers.get('content-type'), /text\/event-stream/)
  const reader = events.body.getReader()
  assert.match(new TextDecoder().decode((await reader.read()).value), /^data: /)
  await reader.cancel()
  eventsAbort.abort()
  await command('connect')
  const initial = await waitForSpawn()
  await wait(3000)
  const running = await status()
  assert.equal(running.status, 'spawned', running.lastError)
  assert.ok(running.tick >= initial.tick + 30, 'Heartbeat stalled')
  assert.equal(running.lastError, null)
  const dataDeadline = Date.now() + 30000
  let scanned = running
  while (scanned.coverage?.knownSubchunks < 24 && Date.now() < dataDeadline) {
    await wait(500)
    scanned = await status()
  }
  assert.ok(scanned.coverage?.knownSubchunks >= 24, 'No decoded world data: ' + JSON.stringify(scanned.coverage))
  assert.ok(scanned.loadedChunks > 0)
  const idsResponse = await fetch(base + '/api/block-ids', { signal: deadline })
  assert.equal(idsResponse.status, 200)
  const { blockIds } = await idsResponse.json()
  assert.ok(blockIds.includes('minecraft:stone') && blockIds.includes('minecraft:diamond_ore'))
  assert.deepEqual(blockIds, [...new Set(blockIds)].sort())
  const mapResponse = await fetch(base + '/api/map', { signal: deadline })
  assert.equal(mapResponse.status, 200)
  const map = await mapResponse.json()
  assert.equal(map.cells.length, map.width * map.height)
  assert.ok(map.cells.some(cell => cell && Number.isInteger(cell[1])), 'Expected known terrain on the map')
  assert.ok(map.cells.every(cell => cell === null || typeof map.palette[cell[0]] === 'string'))
  const searchResponse = await fetch(base + '/api/blocks?block=minecraft:stone&limit=5', { signal: deadline })
  assert.equal(searchResponse.status, 200)
  const search = await searchResponse.json()
  assert.ok(search.hits.length > 0 && search.hits.length <= 5, 'Expected stone in the prepared server world')
  assert.ok(search.hits.every(hit => Number.isInteger(hit.x) && Number.isInteger(hit.y) && Number.isInteger(hit.z)))
  assert.ok(search.hits.every((hit, index) => index === 0 || hit.distance >= search.hits[index - 1].distance))
  const beforePreview = await status()
  const previewResponse = await fetch(base + '/api/preview', {
    method:'POST', headers:{'Content-Type':'application/json'}, signal:deadline,
    body:JSON.stringify({x:Math.floor(beforePreview.position.x),z:Math.floor(beforePreview.position.z)})
  })
  const preview = await previewResponse.json()
  assert.equal(previewResponse.status,200,JSON.stringify(preview))
  assert.ok(preview.path.length>0)
  const afterPreview=await status()
  assert.deepEqual(afterPreview.position,beforePreview.position,'Preview moved the bot')
  assert.equal(afterPreview.navigation.status,'idle')
  await command('disconnect')
  await wait(500)
  assert.equal((await status()).status, 'disconnected')
  // Leave the validated container connected for the user's manual endurance test.
  await command('connect')
  const final = await waitForSpawn()
  console.log(JSON.stringify({
    result: 'passed', health: true, web: true, sse: true,
    heartbeat: true, blockSearch: true, blockIds: blockIds.length, map: true, previewWithoutMovement:true, terrainTests: true, coverage: search.coverage, sampleHit: search.hits[0],
    disconnect: true, reconnect: true, leftConnected: true,
    position: final.position, dimension: final.dimension
  }))
}
main().catch(error => { console.error(error); process.exitCode = 1 })
