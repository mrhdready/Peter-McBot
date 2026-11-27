const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const file = path.join(root, 'src/ui/version.txt')

// Only count local builds; Docker builds have no .git and keep the committed number.
if (!fs.existsSync(path.join(root, '.git'))) process.exit(0)

const version = fs.readFileSync(file, 'utf8').trim()
const match = /^(\d+\.\d+\.\d+)(?:\.(\d+))?$/.exec(version)
if (!match) throw new Error(`Unexpected version in src/ui/version.txt: ${version}`)
const next = `${match[1]}.${Number(match[2] ?? 0) + 1}`
fs.writeFileSync(file, next + '\n')
console.log(`version ${next}`)
