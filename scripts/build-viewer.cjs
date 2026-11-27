const fs = require('node:fs')
const path = require('node:path')
const esbuild = require('esbuild')
const viewer = path.dirname(require.resolve('prismarine-viewer/package.json'))
const dataRoot = path.dirname(require.resolve('minecraft-data/package.json'))
const out = path.resolve('dist/ui/viewer')
fs.mkdirSync(out, { recursive: true })
for (const file of ['textures/1.21.4.png', 'blocksStates/1.21.4.json']) {
  fs.mkdirSync(path.dirname(path.join(out, file)), { recursive: true })
  fs.copyFileSync(path.join(viewer, 'public', file), path.join(out, file))
}

// Bundle only the target palette and the tint data requested by upstream models.js.
const raw = require('minecraft-data/data.js')
const selected = { pc: {}, bedrock: {} }
// The palette is Java 1.21.11; the copied 1.21.4 atlas/block states are only the fallback without Mojang assets.
for (const version of ['1.21.11', '1.16.2']) {
  selected.pc[version] = Object.fromEntries(['blocks', 'blockCollisionShapes', 'biomes', 'version', 'tints'].map(key => [key, raw.pc[version][key]]))
}
const browserModules = {
  name: 'viewer-browser',
  setup (build) {
    build.onLoad({ filter: /minecraft-data[/\\]data\.js$/ }, () => ({ contents: 'module.exports = ' + JSON.stringify(selected), loader: 'js' }))
    build.onResolve({ filter: /^(\.\.?\/utils|\.\.?\/utils\.electron\.js)$/ }, args => args.importer.includes('prismarine-viewer') ? { path: path.join(viewer, 'viewer/lib/utils.web.js') } : undefined)
    build.onResolve({ filter: /^prismarine-chunk$/ }, () => ({ path: 'chunk', namespace: 'viewer' }))
    build.onLoad({ filter: /^chunk$/, namespace: 'viewer' }, () => ({ contents: `module.exports = version => require(${JSON.stringify(require.resolve('prismarine-chunk/src/pc/1.18/chunk'))})(require('prismarine-registry')(version))`, resolveDir: process.cwd() }))
    build.onResolve({ filter: /^canvas$/ }, () => ({ path: 'canvas', namespace: 'viewer' }))
    build.onLoad({ filter: /^canvas$/, namespace: 'viewer' }, () => ({ contents: 'exports.createCanvas = (width, height) => Object.assign(document.createElement("canvas"), { width, height })' }))
    build.onResolve({ filter: /^zlib$/ }, () => ({ path: 'zlib', namespace: 'viewer' }))
    build.onLoad({ filter: /^zlib$/, namespace: 'viewer' }, () => ({ contents: 'module.exports = {}' }))
  }
}
const common = {
  bundle: true, minify: true, platform: 'browser', target: 'es2022',
  define: { global: 'globalThis', 'globalThis.isElectron': 'false' },
  inject: [path.resolve('scripts/viewer-globals.js')],
  plugins: [browserModules], logLevel: 'info'
}
Promise.all([
  esbuild.build({ ...common, entryPoints: ['src/ui/viewer.js'], outfile: path.join(out, 'index.js') }),
  esbuild.build({ ...common, entryPoints: [path.join(viewer, 'viewer/lib/worker.js')], outfile: path.join(out, 'worker.js') })
]).then(() => {
  const { gzipSync } = require('node:zlib')
  for (const file of ['index.js', 'worker.js', 'blocksStates/1.21.4.json']) {
    fs.writeFileSync(path.join(out, file + '.gz'), gzipSync(fs.readFileSync(path.join(out, file))))
  }
}).catch(() => { process.exitCode = 1 })
