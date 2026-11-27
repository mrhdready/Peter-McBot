const { test } = require('node:test')
const assert = require('node:assert/strict')
const { once } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { deflateRawSync } = require('node:zlib')
const { PNG } = require('pngjs')
const { openZip, buildViewerAssets, ViewerAssets, ASSET_VERSION, bundledAssetFiles } = require('../dist/viewer-assets.js')
const { createWebServer } = require('../dist/web.js')
const { WorldState } = require('../dist/state.js')

/** Writes a zip archive (deflate unless `stored`); CRCs are not checked by the reader. */
function zip (entries) {
  const locals = []; const central = []; let offset = 0
  for (const { name, data, stored, declaredSize } of entries) {
    const body = stored ? data : deflateRawSync(data)
    const nameBytes = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(stored ? 0 : 8, 8)
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(declaredSize ?? data.length, 22); local.writeUInt16LE(nameBytes.length, 26)
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(stored ? 0 : 8, 10)
    header.writeUInt32LE(body.length, 20); header.writeUInt32LE(declaredSize ?? data.length, 24); header.writeUInt16LE(nameBytes.length, 28)
    header.writeUInt32LE(offset, 42)
    locals.push(local, nameBytes, body); central.push(header, nameBytes)
    offset += 30 + nameBytes.length + body.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

function png (width, height, color) {
  const image = new PNG({ width, height })
  for (let i = 0; i < width * height; i++) image.data.set(typeof color === 'function' ? color(i % width, Math.floor(i / width)) : color, i * 4)
  return PNG.sync.write(image)
}

const json = value => Buffer.from(JSON.stringify(value))
const A = 'assets/minecraft/'
function miniJar () {
  return zip([
    { name: A + 'blockstates/stone.json', data: json({ variants: { '': { model: 'minecraft:block/stone' } } }) },
    { name: A + 'blockstates/water.json', data: json({ variants: { '': [{ model: 'minecraft:block/water' }, { model: 'minecraft:block/stone' }] } }) },
    { name: A + 'blockstates/oak_fence.json', data: json({ multipart: [{ apply: { model: 'minecraft:block/stone' } }, { when: { AND: [{ north: 'true' }, { up: 'false' }] }, apply: { model: 'minecraft:block/broken', y: 90 } }] }) },
    { name: A + 'blockstates/odd.json', data: json({ variants: { 'facing=up': { model: 'minecraft:block/odd' } } }) },
    { name: A + 'blockstates/chest.json', data: json({ variants: { '': { model: 'minecraft:block/chest' } } }) },
    { name: A + 'models/block/cube.json', data: json({ elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: { up: { texture: '#up', cullface: 'up', tintindex: 0 }, north: { texture: '#north', uv: [0, 0, 8, 8] } } }] }) },
    { name: A + 'models/block/cube_all.json', data: json({ parent: 'block/cube', textures: { particle: '#all', up: '#all', north: '#all' } }) },
    { name: A + 'models/block/stone.json', data: json({ parent: 'minecraft:block/cube_all', textures: { all: 'minecraft:block/stone' } }) },
    { name: A + 'models/block/water.json', data: json({ textures: { particle: 'minecraft:block/water_still' } }) },
    { name: A + 'models/block/odd.json', data: json({ parent: 'block/cube', textures: { up: 'minecraft:block/nope', north: '#unset' } }) },
    { name: A + 'models/block/chest.json', data: json({ textures: { particle: 'minecraft:block/oak_planks' } }) },
    { name: A + 'textures/block/stone.png', data: png(16, 16, [200, 10, 10, 255]) },
    // Animated strip: only the first (green) frame may reach the atlas.
    { name: A + 'textures/block/water_still.png', data: png(16, 32, (x, y) => y < 16 ? [0, 255, 0, 255] : [255, 255, 255, 255]), stored: true },
    { name: A + 'textures/entity/chest/normal.png', data: png(64, 64, (x, y) => [x * 4, y * 4, 0, 255]) },
    { name: '../outside.json', data: json({}) }
  ])
}

test('zip reader inflates stored and deflated entries and ignores traversal names', () => {
  const archive = openZip(zip([
    { name: 'a.txt', data: Buffer.from('alpha'), stored: true },
    { name: 'dir/b.txt', data: Buffer.from('beta'.repeat(100)) },
    { name: '../evil.txt', data: Buffer.from('x') },
    { name: 'dir/../../evil.txt', data: Buffer.from('x') }
  ]))
  assert.deepEqual(archive.names(), ['a.txt', 'dir/b.txt'])
  assert.equal(archive.read('a.txt').toString(), 'alpha')
  assert.equal(archive.read('dir/b.txt').toString(), 'beta'.repeat(100))
  assert.equal(archive.read('missing'), undefined)
  assert.throws(() => openZip(Buffer.from('not a zip at all, definitely not')), /Not a zip/)
})

test('zip reader rejects entries that inflate beyond their declared size or the entry limit', () => {
  const bomb = openZip(zip([{ name: 'bomb', data: Buffer.alloc(100000), declaredSize: 10 }]))
  assert.throws(() => bomb.read('bomb'))
  const huge = openZip(zip([{ name: 'huge', data: Buffer.alloc(16), declaredSize: 64 * 1024 * 1024 }]))
  assert.throws(() => huge.read('huge'), /too large/)
})

test('asset generator flattens models into the mesher format with missing tiles instead of failures', async () => {
  const result = await buildViewerAssets(openZip(miniJar()))
  const states = result.blockStates
  const atlas = PNG.sync.read(result.atlas)
  assert.equal(atlas.width, atlas.height)
  assert.equal(atlas.width % 16, 0)
  const pixel = (u, v) => { const i = (Math.round(v * atlas.height) * atlas.width + Math.round(u * atlas.width)) * 4; return [...atlas.data.subarray(i, i + 4)] }

  const stone = states.stone.variants[''].model
  assert.equal(stone.elements.length, 1)
  const up = stone.elements[0].faces.up
  assert.equal(up.cullface, 'up'); assert.equal(up.tintindex, 0)
  assert.deepEqual(Object.keys(up.texture).sort(), ['bu', 'bv', 'su', 'sv', 'u', 'v'])
  assert.deepEqual(pixel(up.texture.u, up.texture.v), [200, 10, 10, 255])
  const north = stone.elements[0].faces.north.texture
  assert.ok(Math.abs(north.su - up.texture.su / 2) < 1e-12, 'explicit UVs select a sub-rectangle')

  const water = states.water.variants[''].model
  assert.deepEqual(pixel(water.textures.particle.u, water.textures.particle.v + water.textures.particle.sv * 0.9), [0, 255, 0, 255])
  assert.equal(Array.isArray(states.water.variants['']), false, 'weighted variants keep the first entry')

  assert.deepEqual(states.oak_fence.multipart[1].when, { north: 'true', up: 'false' })
  assert.equal(states.oak_fence.multipart[1].apply.y, 90)
  assert.ok(result.missingModels.includes('minecraft:block/broken'))
  const odd = states.odd.variants['facing=up'].model.elements[0].faces
  assert.deepEqual(pixel(odd.up.texture.u, odd.up.texture.v), [248, 0, 248, 255])
  assert.ok(result.missingTextures.includes('block/nope'))
  assert.ok(result.missingTextures.includes('#north'), 'unresolvable references are reported by the face reference')
  assert.ok(states.missing_texture.variants[''].model.elements.length)
  assert.equal(JSON.stringify(states).includes('../'), false)
})

test('asset generator replaces block-entity models with boxes from entity textures', async () => {
  const { blockStates: states, missingTextures } = await buildViewerAssets(openZip(miniJar()))
  const south = states.chest.variants['facing=south,type=single']
  const north = states.chest.variants['facing=north,type=single']
  assert.equal('y' in south, false)
  assert.equal(north.y, 180)
  assert.equal(states.chest.variants['facing=west,type=left'].y, 90)
  assert.equal(south.model.elements.length, 3, 'base, lid and latch')
  assert.deepEqual(south.model.elements[2].from, [7, 7, 15])
  assert.ok(south.model.elements[0].faces.up.texture.su > 0)
  // Sheets missing from the jar (copper, beds, shulkers) fall back to the missing tile, not an exception.
  assert.ok(states.copper_chest.variants['facing=east,type=single'])
  assert.ok(states.red_bed.variants['facing=south,part=head'])
  assert.ok(states.shulker_box.variants[''])
  assert.ok(missingTextures.includes('entity/bed/red'))
  assert.equal(missingTextures.includes('entity/chest/normal'), false)
})

test('bed faces keep the frame at the bottom and the pillow end outside', async () => {
  const jar = zip([{ name: A + 'textures/entity/bed/red.png', data: png(64, 64, (x, y) => [x * 4, y * 4, 0, 255]) }])
  const { blockStates: states, atlas: data } = await buildViewerAssets(openZip(jar))
  const atlas = PNG.sync.read(data)
  // Top-left pixel of a face, as sheet coordinates (the sheet encodes x and y in red and green).
  const corner = face => {
    const i = (Math.round(face.texture.v * atlas.height) * atlas.width + Math.round(face.texture.u * atlas.width)) * 4
    return [atlas.data[i] / 4, atlas.data[i + 1] / 4]
  }
  const head = states.red_bed.variants['facing=south,part=head'].model.elements[0].faces
  const foot = states.red_bed.variants['facing=south,part=foot'].model.elements[0].faces
  assert.deepEqual(corner(head.up), [21, 21], 'north-west corner of the top is the foot side of the front')
  assert.deepEqual(corner(head.west), [22, 21], 'west side: top edge next to the front, north end towards the foot')
  assert.deepEqual(corner(head.east), [5, 6], 'east side: top edge next to the front, south end at the pillow')
  assert.deepEqual(corner(head.south), [21, 5], 'pillow end: top edge next to the front')
  assert.deepEqual(corner(foot.north), [22, 27], 'foot end: top edge next to the front')
})

test('asset cache downloads only with a matching hash, keeps the jar and rebuilds offline', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-assets-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const data = miniJar()
  const jar = { url: 'https://example.invalid/client.jar', sha1: createHash('sha1').update(data).digest('hex'), size: data.length }
  let downloads = 0
  const fetch = async url => { downloads++; assert.equal(url, jar.url); return new Response(data) }
  const assets = new ViewerAssets(root)
  const log = () => {}
  assert.equal(assets.files().source, 'fallback')
  assert.deepEqual(assets.files(), bundledAssetFiles())

  await assert.rejects(new ViewerAssets(path.join(root, 'bad')).prepare({ fetch, jar: { ...jar, sha1: '0'.repeat(40) }, log }), /SHA-1/)
  assert.equal(fs.existsSync(path.join(root, 'bad', ASSET_VERSION, 'client.jar')), false)
  await assert.rejects(new ViewerAssets(path.join(root, 'http')).prepare({ fetch: async () => new Response('', { status: 503 }), jar, log }), /HTTP 503/)

  await assets.prepare({ fetch, jar, log })
  assert.equal(downloads, 2)
  const files = assets.files()
  assert.equal(files.source, 'mojang')
  assert.ok(JSON.parse(fs.readFileSync(files.blockStates, 'utf8')).stone)
  assert.ok(fs.existsSync(files.blockStates + '.gz'))
  assert.ok(fs.existsSync(path.join(root, ASSET_VERSION, 'client.jar')))

  await assets.prepare({ fetch, jar, log })
  assert.equal(downloads, 2, 'a complete cache is reused')
  fs.rmSync(path.join(root, ASSET_VERSION, 'meta.json'))
  assert.equal(assets.files().source, 'fallback', 'an incomplete cache is never served')
  await assets.prepare({ fetch: async () => { throw new Error('offline') }, jar, log })
  assert.equal(assets.files().source, 'mojang', 'the kept jar rebuilds without network')
})

test('viewer routes serve generated assets when cached and the bundled fallback otherwise', { timeout: 15000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-routes-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const assets = new ViewerAssets(root)
  const world = new WorldState()
  const web = createWebServer({ state: world }, undefined, undefined, undefined, assets)
  t.after(() => web.close())
  web.server.listen(0, '127.0.0.1'); await once(web.server, 'listening')
  const base = `http://127.0.0.1:${web.server.address().port}`
  const fallback = await fetch(base + '/viewer/blocksStates.json')
  assert.equal(fallback.status, 200)
  assert.equal(fallback.headers.get('content-type'), 'application/json')
  assert.ok((await fallback.json()).stone)
  const fallbackAtlas = Buffer.from(await (await fetch(base + '/viewer/atlas.png')).arrayBuffer())
  assert.deepEqual(fallbackAtlas, fs.readFileSync(bundledAssetFiles().atlas))

  const data = miniJar()
  await assets.prepare({ fetch: async () => new Response(data), jar: { url: 'x', sha1: createHash('sha1').update(data).digest('hex'), size: data.length }, log: () => {} })
  const generated = await fetch(base + '/viewer/blocksStates.json', { headers: { 'accept-encoding': 'gzip' } })
  assert.equal(generated.headers.get('content-encoding'), 'gzip')
  assert.ok((await generated.json()).missing_texture)
  const atlas = Buffer.from(await (await fetch(base + '/viewer/atlas.png')).arrayBuffer())
  assert.deepEqual(atlas, fs.readFileSync(assets.files().atlas))
  assert.equal((await fetch(base + '/viewer/textures/1.21.4.png')).status, 404)
})
