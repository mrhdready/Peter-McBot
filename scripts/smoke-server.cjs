const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
if (!process.env.BEDROCK_HOST) throw new Error('Set BEDROCK_HOST')
const seconds = Number(process.env.SMOKE_SECONDS || 60)
if (!Number.isInteger(seconds) || seconds < 1 || seconds > 7200) throw new Error('SMOKE_SECONDS must be 1..7200')
const child = spawn(process.execPath, ['dist/main.js'], {
  env: { ...process.env, WEB_HOST: '127.0.0.1', WEB_PORT: '0' },
  stdio: ['ignore', 'pipe', 'pipe']
})
const exited = once(child, 'exit')
child.stderr.on('data', data => process.stderr.write(data))
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const deadline = AbortSignal.timeout((seconds + 60) * 1000)
async function main () {
  let log = ''
  const base = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => reject(new Error(`Web process exited with ${code}`)))
    deadline.addEventListener('abort', () => reject(new Error('Web startup timed out')), { once: true })
    child.stdout.on('data', data => {
      process.stdout.write(data)
      log = (log + data).slice(-10000)
      const match = log.match(/web listening on 127\.0\.0\.1:(\d+)/)
      if (match) resolve(`http://127.0.0.1:${match[1]}`)
    })
  })
  const command = name => fetch(base + '/api/' + name, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: deadline })
  const status = () => fetch(base + '/api/status', { signal: deadline }).then(response => response.json())
  assert.equal((await command('connect')).status, 202)
  let state
  const spawnDeadline = Date.now() + 35000
  while (Date.now() < spawnDeadline) {
    state = await status()
    if (state.status === 'spawned') break
    assert.ok(!['dead', 'error'].includes(state.status), state.lastError)
    await wait(500)
  }
  assert.equal(state.status, 'spawned', state.lastError || 'No spawn within 35 s')
  const firstTick = state.tick
  console.log('Spawn confirmed through web API')
  for (let second = 0; second < seconds; second++) {
    await wait(1000)
    state = await status()
    assert.equal(state.status, 'spawned', state.lastError || 'AFK connection lost')
    if ((second + 1) % 30 === 0) console.log(`AFK connected: ${second + 1} s`)
  }
  assert.ok(state.tick > firstTick + seconds * 10, 'Application heartbeat stalled')
  assert.ok(state.position && Number.isFinite(state.position.y), 'No confirmed position')
  assert.ok(Math.abs(state.position.y) < 1000, `Spawn placeholder is still present: y=${state.position.y}`)
  const finalState = state
  assert.equal((await command('disconnect')).status, 202)
  await wait(250)
  assert.equal((await status()).status, 'disconnected')
  fs.mkdirSync('data', { recursive: true })
  const report = { checkedAt: new Date().toISOString(), host: process.env.BEDROCK_HOST, seconds, finalState, disconnect: 'passed' }
  fs.writeFileSync('data/smoke-result.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  child.kill('SIGTERM')
  const force = setTimeout(() => child.kill('SIGKILL'), 6000)
  await exited
  clearTimeout(force)
})
