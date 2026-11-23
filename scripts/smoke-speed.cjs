// Explicit live test: walks the connected bot along a straight, level line and back, measuring speed and server corrections.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const base = process.env.NAV_WEB_BASE
if (!base || !['http:', 'https:'].includes(new URL(base).protocol)) throw new Error('Set NAV_WEB_BASE to the bot web origin')
const deadline = AbortSignal.timeout(180000)
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const post = (name, target) => fetch(base + '/api/' + name, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: target ? JSON.stringify(target) : undefined, signal: deadline })
const status = () => fetch(base + '/api/status', { signal: deadline }).then(r => { assert.equal(r.status, 200); return r.json() })
const command = async (name, target) => { const r = await post(name, target); assert.equal(r.status, 202, await r.text()) }
const until = async (predicate, ms = 30000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const state = await status()
    assert.ok(!['dead', 'error'].includes(state.status), state.lastError)
    if (predicate(state)) return state
    await wait(50)
  }
  throw new Error('Wait timed out: ' + JSON.stringify(await status()))
}
const report = { checkedAt: new Date().toISOString(), result: 'failed', base, runs: [] }
async function reconnect () {
  await command('disconnect'); await wait(500); await command('connect')
  const state = await until(s => s.status === 'spawned' && s.position && Math.abs(s.position.y) < 1000)
  await until(s => s.coverage.complete)
  return state
}
// A straight preview: every waypoint at the same height on one axis line, one block apart.
async function straightTarget (x, z) {
  for (const distance of [8, 6, 4]) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const target = { x: x + dx * distance, z: z + dz * distance }
      const r = await post('preview', target)
      if (r.status !== 200) { await r.text(); continue }
      const { path } = await r.json()
      const straight = path.length === distance + 1 && path.every((p, i) => p.y === path[0].y &&
        p.x === x + .5 + dx * i && p.z === z + .5 + dz * i)
      console.log('candidate', JSON.stringify({ target, waypoints: path.length, straight }))
      if (straight) return { target, distance }
    }
  }
  return null
}
async function walk (target, distance) {
  const before = await status()
  const began = Date.now()
  await command('navigate', target)
  await until(s => s.navigation.status !== 'idle', 5000)
  const state = await until(s => !['planning', 'moving'].includes(s.navigation.status), 30000)
  const seconds = (Date.now() - began) / 1000
  const run = { target, distance, seconds, blocksPerSecond: +(distance / seconds).toFixed(2), navigation: state.navigation,
    predicted: state.position, startedFrom: before.position }
  report.runs.push(run)
  console.log('run', JSON.stringify(run))
  assert.equal(state.navigation.status, 'arrived', JSON.stringify(state.navigation))
  const server = run.serverArrival = (await reconnect()).position
  console.log('serverArrival', JSON.stringify(server))
  assert.ok(Math.hypot(server.x - target.x - .5, server.z - target.z - .5) < .4, 'Reconnect did not confirm the predicted target')
  assert.ok(Math.abs(server.y - before.position.y) < .15, 'Movement changed the height')
  return run
}
async function main () {
  let state = await status()
  if (state.status !== 'spawned') { await command('connect'); state = await until(s => s.status === 'spawned') }
  await until(s => s.coverage.complete)
  const start = report.start = { ...state.position }
  const x = Math.floor(start.x); const z = Math.floor(start.z)
  const found = await straightTarget(x, z)
  assert.ok(found, 'No straight, level line of 4 to 8 blocks from the current position; move the bot to open, flat ground')
  const out = await walk(found.target, found.distance)
  const back = await walk({ x, z }, found.distance)
  // The old movement managed about 1 block/s on straight lines; walking speed should at least double it.
  for (const run of [out, back]) assert.ok(run.blocksPerSecond > 2, `Only ${run.blocksPerSecond} blocks/s`)
  report.result = 'passed'; report.leftConnected = true
}
main().catch(error => { report.error = error.stack || error.message; console.error(report.error); process.exitCode = 1 }).finally(async () => {
  if (report.result !== 'passed') await command('stop_navigation').catch(() => {})
  fs.mkdirSync('data', { recursive: true })
  fs.writeFileSync('data/speed-smoke-result.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
})
