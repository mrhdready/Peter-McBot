const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')

test('UI build records the current Git commit automatically', () => {
  const root = path.resolve(__dirname, '..')
  const env = { ...process.env }
  delete env.BUILD_REVISION
  const actual = execFileSync(process.execPath, ['-e', "process.stdout.write(require('./scripts/build-ui.cjs').buildRevision())"], { cwd: root, env, encoding: 'utf8' })
  const expected = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim().slice(0, 7)
  assert.equal(actual, expected)
})

test('UI build accepts container metadata, rejects invalid hashes and handles missing Git', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-bot-ui-build-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'scripts'))
  fs.mkdirSync(path.join(root, 'src/ui'), { recursive: true })
  fs.copyFileSync(path.join(__dirname, '../scripts/build-ui.cjs'), path.join(root, 'scripts/build-ui.cjs'))
  fs.writeFileSync(path.join(root, 'src/ui/index.html'), '<h1>Bot</h1>')
  const env = { ...process.env, PATH: '' }
  delete env.BUILD_REVISION
  const run = revision => spawnSync(process.execPath, ['scripts/build-ui.cjs'], {
    cwd: root, encoding: 'utf8', env: { ...env, ...(revision ? { BUILD_REVISION: revision } : {}) }
  })
  for (const [revision, expected] of [[undefined, 'unknown'], ['ABCDEF1234567890', 'abcdef1'], ['unknown', 'unknown']]) {
    const result = run(revision)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(fs.readFileSync(path.join(root, 'dist/ui/version.txt'), 'utf8'), expected + '\n')
    assert.equal(fs.readFileSync(path.join(root, 'dist/ui/index.html'), 'utf8'), '<h1>Bot</h1>')
  }
  const invalid = run('<script>')
  assert.notEqual(invalid.status, 0)
  assert.match(invalid.stderr, /BUILD_REVISION must be a Git commit hash/)
})
