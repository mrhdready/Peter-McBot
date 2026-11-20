// Explicit live test: walks the connected bot through a closed door or fence gate to DOOR_TARGET and back.
// Setup: the bot stands on one side of a wall whose only nearby passage is a closed wooden door or fence gate,
// DOOR_TARGET ("x,z") lies a few blocks behind it. Door and closing decisions appear as [nav] lines in the bot log.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const base = process.env.NAV_WEB_BASE
if (!base || !['http:', 'https:'].includes(new URL(base).protocol)) throw new Error('Set NAV_WEB_BASE to the bot web origin')
const match = /^(-?\d+),(-?\d+)$/.exec(process.env.DOOR_TARGET || '')
if (!match) throw new Error('Set DOOR_TARGET to "x,z", a block behind the closed door')
const deadline = AbortSignal.timeout(240000)
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
async function walk (label, target) {
  const preview = await post('preview', target)
  const route = preview.status === 200 ? (await preview.json()).path : { error: await preview.text() }
  const began = Date.now()
  await command('navigate', target)
  await until(s => s.navigation.status !== 'idle', 5000)
  const state = await until(s => !['planning', 'moving'].includes(s.navigation.status), 60000)
  const run = { label, target, seconds: (Date.now() - began) / 1000, previewWaypoints: Array.isArray(route) ? route.length : route,
    navigation: state.navigation, predicted: state.position }
  report.runs.push(run)
  console.log('run', JSON.stringify(run))
  assert.equal(state.navigation.status, 'arrived', JSON.stringify(state.navigation))
  const server = run.serverArrival = (await reconnect()).position
  console.log('serverArrival', JSON.stringify(server))
  assert.ok(Math.hypot(server.x - target.x - .5, server.z - target.z - .5) < .4, 'Reconnect did not confirm the predicted target')
}
async function main () {
  let state = await status()
  if (state.status !== 'spawned') { await command('connect'); state = await until(s => s.status === 'spawned') }
  await until(s => s.coverage.complete)
  const start = report.start = { ...state.position }
  const home = { x: Math.floor(start.x), z: Math.floor(start.z) }
  await walk('through', { x: Number(match[1]), z: Number(match[2]) })
  // The way back passes the same door again: closed by the bot in between, it must be opened a second time.
  await walk('back', home)
  report.result = 'passed'; report.leftConnected = true
}
main().catch(error => { report.error = error.stack || error.message; console.error(report.error); process.exitCode = 1 }).finally(async () => {
  if (report.result !== 'passed') await command('stop_navigation').catch(() => {})
  fs.mkdirSync('data', { recursive: true })
  fs.writeFileSync('data/door-smoke-result.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
})
