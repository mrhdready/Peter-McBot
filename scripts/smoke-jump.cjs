// Uses a separate player and natural terrain; never edits blocks or teleports.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const base = process.env.NAV_WEB_BASE
if (!base || process.env.TERRAIN_TEST_PLAYER !== 'MCBotTerrain') throw new Error('Set NAV_WEB_BASE and TERRAIN_TEST_PLAYER=MCBotTerrain for the dedicated test deployment')
const signal = AbortSignal.timeout(120000)
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const read = path => fetch(base + path, { signal }).then(async r => { assert.equal(r.status, 200); return r.json() })
const post = async (path, target) => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: target ? JSON.stringify(target) : undefined, signal })
  assert.equal(r.status, 202, await r.text())
}
async function until (predicate, ms = 35000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const s = await read('/api/status')
    assert.ok(!['error', 'dead'].includes(s.status), s.lastError)
    if (predicate(s)) return s
    await wait(100)
  }
  throw new Error('Timed out: ' + JSON.stringify(await read('/api/status')))
}
const report = { checkedAt: new Date().toISOString(), base, player: 'MCBotTerrain', result: 'failed' }
async function main () {
  const initial = await until(s => s.status === 'spawned' && s.coverage.complete)
  const start = report.start = initial.position
  const feet = Math.round((start.y - 1.62) * 2) / 2
  const map = await read('/api/map'); const candidates = []
  map.cells.forEach((cell, i) => {
    if (!cell?.[2] || cell[1] === null || Math.abs(cell[1] + 1 - (feet + 1)) > .001 ||
      !/^minecraft:(grass_block|dirt|stone|sand|gravel|cobblestone)$/.test(map.palette[cell[0]])) return
    const x = map.x + i % map.width; const z = map.z + Math.floor(i / map.width)
    const d = Math.hypot(x + .5 - start.x, z + .5 - start.z)
    if (d <= 8) candidates.push({ x, z, d })
  })
  candidates.sort((a, b) => a.d - b.d)
  assert.ok(candidates.length, 'No natural one-block higher target in known nearby terrain')
  for (const target of candidates.slice(0, 8)) {
    report.target = { x: target.x, z: target.z }
    await post('/api/navigate', report.target)
    const final = await until(s => ['arrived', 'error'].includes(s.navigation.status))
    if (final.navigation.status === 'error') {
      assert.ok(Math.hypot(final.position.x - start.x, final.position.z - start.z) < .1 && Math.abs(final.position.y - start.y) < .1,
        'A rejected candidate moved the player; stop further trials: ' + JSON.stringify(final.navigation))
      continue
    }
    report.predictedLanding = final.position
    report.corrections = final.navigation.corrections
    assert.ok(Math.abs(final.position.y - start.y - 1) < .01, 'Target did not finish one block higher')
    await post('/api/disconnect'); await wait(500); await post('/api/connect')
    const confirmed = await until(s => s.status === 'spawned' && s.position && Math.abs(s.position.y) < 1000)
    report.serverLanding = confirmed.position
    assert.ok(Math.abs(confirmed.position.y - start.y - 1) < .1, 'BDS did not confirm the one-block ascent')
    assert.ok(Math.hypot(confirmed.position.x - (target.x + .5), confirmed.position.z - (target.z + .5)) < .4,
      'BDS did not confirm the X/Z target')
    report.result = 'passed'; return
  }
  throw new Error('No candidate reachable')
}
main().catch(error => { report.error = error.stack || error.message; console.error(report.error); process.exitCode = 1 }).finally(async () => {
  await post('/api/stop_navigation').catch(() => {}); await post('/api/disconnect').catch(() => {})
  fs.mkdirSync('data', { recursive: true })
  fs.writeFileSync('data/jump-smoke-result.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
})
