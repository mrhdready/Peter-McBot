// Explicit live test: moves the connected bot one safe block out and back using only its web API.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const base = process.env.NAV_WEB_BASE
if (!base || !['http:', 'https:'].includes(new URL(base).protocol)) throw new Error('Set NAV_WEB_BASE to the bot web origin')
const deadline = AbortSignal.timeout(100000)
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const status = () => fetch(base + '/api/status', { signal: deadline }).then(r => { assert.equal(r.status, 200); return r.json() })
const command = async (name, target) => {
  const r = await fetch(base + '/api/' + name, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: target ? JSON.stringify(target) : undefined, signal: deadline })
  assert.equal(r.status, 202, await r.text())
}
const until = async (predicate, ms = 30000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const state = await status()
    assert.ok(!['dead','error'].includes(state.status), state.lastError)
    if (predicate(state)) return state
    await wait(100)
  }
  throw new Error('Wait timed out: ' + JSON.stringify(await status()))
}
const report = { checkedAt: new Date().toISOString(), result: 'failed', base }
async function navigate (target) {
  await command('navigate', target)
  await wait(150)
  return until(s => !['idle','planning','moving'].includes(s.navigation.status), 15000)
}
async function reconnect () {
  await command('disconnect'); await wait(500); await command('connect')
  return until(s => s.status === 'spawned' && s.position && Math.abs(s.position.y) < 1000)
}
async function main () {
  let state = await status()
  if (state.status !== 'spawned') { await command('connect'); state = await until(s => s.status === 'spawned') }
  await until(s => s.coverage.complete)
  const start = report.start = { ...state.position }
  const x = Math.floor(start.x); const z = Math.floor(start.z)
  let target
  for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
    const candidate = { x: x + dx, z: z + dz }
    state = await navigate(candidate)
    console.log('candidate', JSON.stringify({ target: candidate, navigation: state.navigation, position: state.position }))
    if (state.navigation.status === 'arrived') { target = candidate; break }
    assert.ok(Math.hypot(state.position.x - start.x, state.position.z - start.z) < .1, 'A rejected route already moved the bot; abort further trials')
  }
  assert.ok(target, 'No safe neighbour could be reached on the current plane')
  report.target = target; report.predictedArrival = state.position; report.navigation = state.navigation
  state = await reconnect()
  const serverArrival = report.serverArrival = state.position
  console.log('serverArrival', JSON.stringify(serverArrival))
  assert.ok(Math.hypot(serverArrival.x - target.x - .5, serverArrival.z - target.z - .5) < .4, 'Reconnect did not confirm the predicted target')
  assert.ok(Math.abs(serverArrival.y - start.y) < .15, 'Movement changed the height')
  await until(s => s.coverage.complete)
  // Exercise a stop while returning, then explicitly resume the return.
  await command('navigate', { x, z }); await wait(350); await command('stop_navigation'); await wait(200)
  const stopped = await status(); await wait(350); const held = await status()
  assert.equal(stopped.navigation.status, 'stopped')
  assert.deepEqual(held.position, stopped.position, 'Position prediction continued after Stop')
  report.stop = true
  state = await navigate({ x, z })
  assert.equal(state.navigation.status, 'arrived', JSON.stringify(state.navigation))
  state = await reconnect()
  report.serverReturn = state.position
  assert.ok(Math.hypot(state.position.x - start.x, state.position.z - start.z) < .4, 'Reconnect did not confirm the return')
  report.result = 'passed'; report.leftConnected = true
}
main().catch(error => { report.error = error.stack || error.message; console.error(report.error); process.exitCode = 1 }).finally(async () => {
  if (report.result !== 'passed') await command('stop_navigation').catch(() => {})
  fs.mkdirSync('data', { recursive: true })
  fs.writeFileSync('data/navigation-smoke-result.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
})
