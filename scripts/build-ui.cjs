const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')

function buildRevision () {
  let revision = process.env.BUILD_REVISION
  if (!revision) {
    try {
      revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {
      return 'unknown'
    }
  }
  if (revision === 'unknown') return revision
  if (!/^[a-f0-9]{7,64}$/i.test(revision)) throw new Error('BUILD_REVISION must be a Git commit hash')
  return revision.slice(0, 7).toLowerCase()
}

if (require.main === module) {
  const revision = buildRevision()
  fs.cpSync(path.join(root, 'src/ui'), path.join(root, 'dist/ui'), { recursive: true })
  fs.writeFileSync(path.join(root, 'dist/ui/version.txt'), revision + '\n')
}

module.exports = { buildRevision }
