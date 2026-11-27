import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { setImmediate as yieldLoop } from 'node:timers/promises'
import { gzipSync, inflateRawSync } from 'node:zlib'
import { PNG } from 'pngjs'

export const ASSET_VERSION = '1.21.11'
/** Content-addressed Mojang download; SHA-1 and size come from the 1.21.11 version manifest. */
export const CLIENT_JAR = {
  url: 'https://piston-data.mojang.com/v1/objects/ba2df812c2d12e0219c489c4cd9a5e1f0760f5bd/client.jar',
  sha1: 'ba2df812c2d12e0219c489c4cd9a5e1f0760f5bd',
  size: 31152600
}
/** Bump when the generated output changes; existing caches are then rebuilt from the kept jar. */
export const GENERATOR_VERSION = 2
const ENTRY_MAX = 8 * 1024 * 1024

export type AssetFiles = { atlas: string; blockStates: string; source: 'mojang' | 'fallback' }

/** The 1.21.4 atlas shipped with prismarine-viewer; block states are keyed by name, so it works with the 1.21.11 palette. */
export function bundledAssetFiles (): AssetFiles {
  const root = path.join(__dirname, 'ui', 'viewer')
  return { atlas: path.join(root, 'textures', '1.21.4.png'), blockStates: path.join(root, 'blocksStates', '1.21.4.json'), source: 'fallback' }
}

/** Minimal zip reader (stored and deflate). Entry names are lookup keys only and never become file paths. */
export function openZip (zip: Buffer) {
  let eocd = -1
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  if (eocd < 0) throw new Error('Not a zip archive')
  const count = zip.readUInt16LE(eocd + 10)
  const size = zip.readUInt32LE(eocd + 12)
  const offset = zip.readUInt32LE(eocd + 16)
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) throw new Error('ZIP64 archives are not supported')
  if (offset + size > eocd) throw new Error('Corrupt zip directory')
  const entries = new Map<string, { flags: number; method: number; compressed: number; size: number; local: number }>()
  let p = offset
  for (let i = 0; i < count; i++) {
    if (p + 46 > eocd || zip.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt zip directory')
    const nameLength = zip.readUInt16LE(p + 28)
    const name = zip.toString('utf8', p + 46, p + 46 + nameLength)
    const entry = { flags: zip.readUInt16LE(p + 8), method: zip.readUInt16LE(p + 10), compressed: zip.readUInt32LE(p + 20), size: zip.readUInt32LE(p + 24), local: zip.readUInt32LE(p + 42) }
    p += 46 + nameLength + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32)
    if (!name.endsWith('/') && !name.startsWith('/') && !name.includes('\\') && !name.split('/').includes('..')) entries.set(name, entry)
  }
  return {
    names: () => [...entries.keys()],
    read (name: string): Buffer | undefined {
      const entry = entries.get(name)
      if (!entry) return undefined
      if (entry.flags & 1) throw new Error('Encrypted zip entry: ' + name)
      if (entry.size > ENTRY_MAX || entry.compressed > ENTRY_MAX) throw new Error('Zip entry too large: ' + name)
      const local = entry.local
      if (local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50) throw new Error('Corrupt zip entry: ' + name)
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
      if (start + entry.compressed > zip.length) throw new Error('Corrupt zip entry: ' + name)
      const data = zip.subarray(start, start + entry.compressed)
      let out: Buffer
      if (entry.method === 0) out = Buffer.from(data)
      else if (entry.method === 8) out = inflateRawSync(data, { maxOutputLength: Math.max(1, entry.size) })
      else throw new Error('Unsupported zip compression: ' + name)
      if (out.length !== entry.size) throw new Error('Corrupt zip entry: ' + name)
      return out
    }
  }
}

type Zip = ReturnType<typeof openZip>
type Image = { width: number; height: number; data: Buffer }
type Transform = '' | 'v' | 'r90' | 'r180' | 'r270'
type Region = { sheet: string; x: number; y: number; w: number; h: number; t: Transform }
type Face = { texture: string; uv: number[]; cullface?: string; tintindex?: number; rotation?: number }
type Element = { from: number[]; to: number[]; rotation?: { origin: number[]; axis: string; angle: number }; faces: Record<string, Face> }
type Model = { textures: Record<string, string>; elements: Element[]; ao: boolean }

const MISSING = 'missing'
const FACINGS: Array<[string, number]> = [['south', 0], ['west', 90], ['north', 180], ['east', 270]]
const COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']
const CHESTS: Record<string, string> = { chest: 'normal', trapped_chest: 'trapped' }
for (const [prefix, sheet] of [['', 'copper'], ['exposed_', 'copper_exposed'], ['weathered_', 'copper_weathered'], ['oxidized_', 'copper_oxidized']]) {
  CHESTS[prefix + 'copper_chest'] = sheet
  CHESTS['waxed_' + prefix + 'copper_chest'] = sheet
}

function decode (png: Buffer): Image | null {
  if (png.length < 24 || png.readUInt32BE(12) !== 0x49484452) return null
  const width = png.readUInt32BE(16); const height = png.readUInt32BE(20)
  if (!width || !height || width > 1024 || height > 16384 || width * height > 4 * 1024 * 1024) return null
  try { return PNG.sync.read(png) } catch { return null }
}

function defaultUv (side: string, from: number[], to: number[]) {
  return ({
    north: [to[0], 16 - to[1], from[0], 16 - from[1]],
    east: [from[2], 16 - to[1], to[2], 16 - from[1]],
    south: [from[0], 16 - to[1], to[0], 16 - from[1]],
    west: [from[2], 16 - to[1], to[2], 16 - from[1]],
    up: [from[0], from[2], to[0], to[2]],
    down: [to[0], from[2], from[0], to[2]]
  } as Record<string, number[]>)[side] ?? [0, 0, 16, 16]
}

/**
 * Builds prismarine-viewer's atlas and `blocksStates` format from a Java client jar: models are flattened,
 * texture references resolved and UVs baked into atlas coordinates (16-px tiles, first animation frame).
 * Missing models or textures use a visible checkerboard tile instead of failing.
 */
export async function buildViewerAssets (jar: Zip) {
  const images = new Map<string, Image | null>()
  const tiles = new Map<string, Buffer>()
  const missingTextures = new Set<string>()
  const missingModels = new Set<string>()
  const checker = Buffer.alloc(16 * 16 * 4)
  for (let i = 0; i < 256; i++) checker.set(((i >> 3) ^ (i >> 7)) & 1 ? [0, 0, 0, 255] : [248, 0, 248, 255], i * 4)
  tiles.set(MISSING, checker)

  const image = (sheet: string) => {
    if (!images.has(sheet)) {
      const file = jar.read('assets/minecraft/textures/' + sheet + '.png')
      images.set(sheet, file ? decode(file) : null)
    }
    return images.get(sheet)!
  }
  const render = ({ sheet, x, y, w, h, t }: Region) => {
    const img = image(sheet)
    if (!img || x + w > img.width || y + h > img.height) return null
    const [ow, oh] = t === 'r90' || t === 'r270' ? [h, w] : [w, h]
    if (ow > 16 || oh > 16) return null
    const out = Buffer.alloc(16 * 16 * 4)
    for (let dy = 0; dy < oh; dy++) for (let dx = 0; dx < ow; dx++) {
      const [sx, sy] = t === 'v' ? [dx, h - 1 - dy] : t === 'r180' ? [w - 1 - dx, h - 1 - dy] : t === 'r90' ? [dy, h - 1 - dx] : t === 'r270' ? [w - 1 - dy, dx] : [dx, dy]
      img.data.copy(out, (dy * 16 + dx) * 4, ((y + sy) * img.width + x + sx) * 4, ((y + sy) * img.width + x + sx) * 4 + 4)
    }
    return out
  }
  /** Registers a tile and returns its key, or the missing tile's key. */
  const use = (key: string, region: Region) => {
    if (!tiles.has(key)) {
      const pixels = render(region)
      if (!pixels) { missingTextures.add(region.sheet); return MISSING }
      tiles.set(key, pixels)
    }
    return key
  }
  const blockTexture = (name: string | null) => name ? use(name, { sheet: name, x: 0, y: 0, w: 16, h: 16, t: '' }) : MISSING
  const sheetFace = (sheet: string, x: number, y: number, w: number, h: number, t: Transform = '', cullface?: string): Face => {
    const texture = use(`${sheet}@${x},${y},${w},${h}${t}`, { sheet, x, y, w, h, t })
    return { texture, uv: t === 'r90' || t === 'r270' ? [0, 0, h, w] : [0, 0, w, h], ...(cullface ? { cullface } : {}) }
  }

  const raw = new Map<string, any>()
  const loadRaw = (ref: string) => {
    const name = ref.replace(/^minecraft:/, '')
    const key = name.includes('/') ? name : 'block/' + name
    if (!raw.has(key)) {
      let data = null
      try { const file = jar.read('assets/minecraft/models/' + key + '.json'); if (file) data = JSON.parse(file.toString('utf8')) } catch { data = null }
      raw.set(key, data)
    }
    return raw.get(key)
  }
  const flatten = (ref: string, depth = 0): { textures: Record<string, string>; elements: any[]; ao: boolean } | null => {
    const data = loadRaw(ref)
    if (!data || depth > 32) return null
    const parent = typeof data.parent === 'string' ? flatten(data.parent, depth + 1) : null
    return {
      textures: { ...parent?.textures, ...data.textures },
      elements: Array.isArray(data.elements) ? data.elements : parent?.elements ?? [],
      ao: data.ambientocclusion ?? parent?.ao ?? true
    }
  }
  const resolve = (textures: Record<string, string>, name: unknown) => {
    let value = name
    for (let i = 0; i < 16 && typeof value === 'string' && value.startsWith('#'); i++) value = textures[value.slice(1)]
    return typeof value === 'string' && !value.startsWith('#') ? value.replace(/^minecraft:/, '') : null
  }
  const rotation = (r: any) => {
    if (!r || typeof r !== 'object') return undefined
    const origin = Array.isArray(r.origin) ? r.origin : [8, 8, 8]
    if (typeof r.axis === 'string') return { origin, axis: r.axis, angle: Number(r.angle) || 0 }
    // Newer formats may give one angle per axis; the mesher supports a single axis only.
    const axes = ['x', 'y', 'z'].filter(axis => Number(r[axis]))
    return axes.length === 1 ? { origin, axis: axes[0], angle: Number(r[axes[0]]) } : undefined
  }
  const baked = new Map<string, Model>()
  const missingModel: Model = {
    textures: { particle: MISSING }, ao: true,
    elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: Object.fromEntries(['down', 'up', 'north', 'south', 'west', 'east'].map(side => [side, { texture: MISSING, uv: [0, 0, 16, 16], cullface: side }])) }]
  }
  const bake = (ref: string): Model => {
    if (baked.has(ref)) return baked.get(ref)!
    const model = flatten(ref)
    let result = missingModel
    if (!model) missingModels.add(ref)
    else {
      const texture = (name: unknown) => {
        const resolved = resolve(model.textures, name)
        if (!resolved) missingTextures.add(String(name))
        return blockTexture(resolved)
      }
      result = {
        textures: { particle: model.textures.particle ? texture(model.textures.particle) : MISSING }, ao: model.ao !== false,
        elements: model.elements.filter(e => Array.isArray(e?.from) && Array.isArray(e?.to)).map(e => {
          const r = rotation(e.rotation)
          return {
            from: e.from, to: e.to, ...(r ? { rotation: r } : {}),
            faces: Object.fromEntries(Object.entries(e.faces ?? {}).map(([side, f]: [string, any]) => [side, {
              texture: texture(f.texture), uv: Array.isArray(f.uv) ? f.uv : defaultUv(side, e.from, e.to),
              ...(f.cullface ? { cullface: f.cullface } : {}), ...(f.tintindex !== undefined ? { tintindex: f.tintindex } : {}), ...(f.rotation ? { rotation: f.rotation } : {})
            }]))
          }
        })
      }
    }
    baked.set(ref, result)
    return result
  }
  const condition = (when: any): any => {
    if (Array.isArray(when?.AND)) return Object.assign({}, ...when.AND.map(condition))
    if (Array.isArray(when?.OR)) return { OR: when.OR.map(condition) }
    return when
  }
  const variant = (value: any) => {
    const first = Array.isArray(value) ? value[0] : value
    return typeof first?.model === 'string' ? { ...first, model: bake(first.model) } : null
  }

  const states: Record<string, any> = {}
  const files = jar.names().filter(name => /^assets\/minecraft\/blockstates\/[^/]+\.json$/.test(name)).sort()
  for (let i = 0; i < files.length; i++) {
    if (i % 32 === 0) await yieldLoop()
    let data
    try { data = JSON.parse(jar.read(files[i])!.toString('utf8')) } catch { continue }
    const name = files[i].slice('assets/minecraft/blockstates/'.length, -'.json'.length)
    if (data?.variants && typeof data.variants === 'object') {
      states[name] = { variants: Object.fromEntries(Object.entries(data.variants).map(([key, value]) => [key, variant(value)]).filter(([, value]) => value)) }
    } else if (Array.isArray(data?.multipart)) {
      states[name] = { multipart: data.multipart.map((part: any) => ({ ...(part.when ? { when: condition(part.when) } : {}), apply: variant(part.apply) })).filter((part: any) => part.apply) }
    }
  }

  // Block entities have no block model in the jar; these boxes approximate their entity models.
  const entity = (elements: Element[]): Model => ({ textures: { particle: Object.values(elements[0].faces)[0].texture }, elements, ao: true })
  // Chest models are built Y-up while their textures are stored upside down (see ModelPart cube unwrapping).
  const chestBox = (sheet: string, u: number, v: number, w: number, h: number, d: number, from: number[], to: number[]): Element => ({
    from, to,
    faces: {
      up: sheetFace(sheet, u + d + w, v, w, d, 'v'), down: sheetFace(sheet, u + d, v, w, d),
      north: sheetFace(sheet, u + d, v + d, w, h, 'v'), south: sheetFace(sheet, u + 2 * d + w, v + d, w, h, 'v'),
      west: sheetFace(sheet, u, v + d, d, h, 'v'), east: sheetFace(sheet, u + d + w, v + d, d, h, 'v')
    }
  })
  const chest = (sheet: string, type: string) => {
    const [x0, x1, lock] = type === 'left' ? [0, 15, 0] : type === 'right' ? [1, 16, 15] : [1, 15, 7]
    const w = x1 - x0; const lw = type === 'single' ? 2 : 1
    return entity([
      chestBox(sheet, 0, 19, w, 10, 14, [x0, 0, 1], [x1, 10, 15]),
      chestBox(sheet, 0, 0, w, 5, 14, [x0, 10, 1], [x1, 14, 15]),
      chestBox(sheet, 0, 0, lw, 4, 1, [lock, 7, 15], [lock + lw, 11, 16])
    ])
  }
  for (const [block, sheet] of Object.entries(CHESTS)) {
    const variants: Record<string, any> = {}
    for (const [facing, y] of FACINGS) {
      for (const type of ['single', 'left', 'right']) {
        variants[`facing=${facing},type=${type}`] = { model: chest('entity/chest/' + sheet + (type === 'single' ? '' : '_' + type), type), ...(y ? { y } : {}) }
      }
    }
    states[block] = { variants }
  }
  states.ender_chest = { variants: Object.fromEntries(FACINGS.map(([facing, y]) => [`facing=${facing}`, { model: chest('entity/chest/ender', 'single'), ...(y ? { y } : {}) }])) }

  const leg = (sheet: string, v: number, x: number, z: number): Element => {
    const face = sheetFace(sheet, 50, v, 3, 3)
    return { from: [x, 0, z], to: [x + 3, 3, z + 3], faces: { north: face, south: face, west: face, east: face, down: face } }
  }
  // Built facing south: the head part's pillow end points south, the foot part connects to the north.
  // The entity box lies on its back: the sheet's front is the top, its +X strip the west side, and the strips'
  // edges next to the front are the mattress top edge, so sides and ends are rotated to keep the frame at the bottom.
  const bed = (sheet: string, part: string) => {
    const head = part === 'head'; const v = head ? 0 : 22
    const mattress: Element = {
      from: [0, 3, 0], to: [16, 9, 16],
      faces: {
        up: sheetFace(sheet, 6, v + 6, 16, 16, 'r180'), down: sheetFace(sheet, 28, v + 6, 16, 16, 'r180'),
        west: sheetFace(sheet, 22, v + 6, 6, 16, 'r90'), east: sheetFace(sheet, 0, v + 6, 6, 16, 'r270'),
        ...(head ? { south: sheetFace(sheet, 6, v, 16, 6, 'r180') } : { north: sheetFace(sheet, 22, v, 16, 6, 'v') })
      }
    }
    return entity(head
      ? [mattress, leg(sheet, 9, 0, 13), leg(sheet, 9, 13, 13)]
      : [mattress, leg(sheet, 3, 0, 0), leg(sheet, 3, 13, 0)])
  }
  for (const color of COLORS) {
    const variants: Record<string, any> = {}
    for (const [facing, y] of FACINGS) for (const part of ['head', 'foot']) variants[`facing=${facing},part=${part}`] = { model: bed('entity/bed/' + color, part), ...(y ? { y } : {}) }
    states[color + '_bed'] = { variants }
  }

  const shulker = (sheet: string) => entity([
    { from: [0, 0, 0], to: [16, 8, 16], faces: { down: sheetFace(sheet, 32, 28, 16, 16, '', 'down'), west: sheetFace(sheet, 0, 44, 16, 8, '', 'west'), north: sheetFace(sheet, 16, 44, 16, 8, '', 'north'), east: sheetFace(sheet, 32, 44, 16, 8, '', 'east'), south: sheetFace(sheet, 48, 44, 16, 8, '', 'south') } },
    { from: [0, 8, 0], to: [16, 16, 16], faces: { up: sheetFace(sheet, 16, 0, 16, 16, '', 'up'), west: sheetFace(sheet, 0, 16, 16, 8, '', 'west'), north: sheetFace(sheet, 16, 16, 16, 8, '', 'north'), east: sheetFace(sheet, 32, 16, 16, 8, '', 'east'), south: sheetFace(sheet, 48, 16, 16, 8, '', 'south') } }
  ])
  states.shulker_box = { variants: { '': { model: shulker('entity/shulker/shulker') } } }
  for (const color of COLORS) states[color + '_shulker_box'] = { variants: { '': { model: shulker('entity/shulker/shulker_' + color) } } }
  states.missing_texture = { variants: { '': { model: missingModel } } }

  // Lay out the atlas and convert tile keys into the UV records the mesher reads.
  const keys = [...tiles.keys()]
  let grid = 1
  while (grid * grid < keys.length) grid *= 2
  const size = grid * 16
  const atlas = new PNG({ width: size, height: size })
  const index = new Map<string, { u: number; v: number; su: number; sv: number }>()
  keys.forEach((key, i) => {
    const x = (i % grid) * 16; const y = Math.floor(i / grid) * 16
    const pixels = tiles.get(key)!
    for (let row = 0; row < 16; row++) pixels.copy(atlas.data, ((y + row) * size + x) * 4, row * 64, row * 64 + 64)
    index.set(key, { u: x / size, v: y / size, su: 16 / size, sv: 16 / size })
  })
  const converted = new Map<Model, unknown>()
  const convert = (model: Model) => {
    if (!converted.has(model)) {
      converted.set(model, {
        textures: { particle: index.get(model.textures.particle) ?? index.get(MISSING) }, ao: model.ao,
        elements: model.elements.map(element => ({
          ...element,
          faces: Object.fromEntries(Object.entries(element.faces).map(([side, { texture, uv, ...rest }]) => {
            const t = index.get(texture) ?? index.get(MISSING)!
            return [side, {
              ...rest,
              texture: { u: t.u + uv[0] * t.su / 16, v: t.v + uv[1] * t.sv / 16, su: (uv[2] - uv[0]) * t.su / 16, sv: (uv[3] - uv[1]) * t.sv / 16, bu: t.u + 0.5 * t.su, bv: t.v + 0.5 * t.sv }
            }]
          }))
        }))
      })
    }
    return converted.get(model)
  }
  for (const state of Object.values(states)) {
    for (const value of Object.values(state.variants ?? {}) as any[]) value.model = convert(value.model)
    for (const part of state.multipart ?? []) part.apply.model = convert(part.apply.model)
  }
  return { atlas: PNG.sync.write(atlas), blockStates: states, tiles: keys.length, missingTextures: [...missingTextures].sort(), missingModels: [...missingModels].sort() }
}

const writeAtomic = (file: string, data: Buffer | string) => {
  writeFileSync(file + '.tmp', data)
  renameSync(file + '.tmp', file)
}

/**
 * Cache of Mojang-derived viewer assets under `data/`. Nothing from the jar is shipped with the image;
 * the jar is downloaded only after MINECRAFT_EULA=true and kept, so newer generators rebuild offline.
 */
export class ViewerAssets {
  readonly dir: string
  constructor (root: string) { this.dir = path.join(root, ASSET_VERSION) }

  /** Generated files if the cache matches this generator, otherwise the bundled 1.21.4 fallback. */
  files (): AssetFiles {
    try {
      const meta = JSON.parse(readFileSync(path.join(this.dir, 'meta.json'), 'utf8'))
      if (meta.version === ASSET_VERSION && meta.generator === GENERATOR_VERSION) {
        return { atlas: path.join(this.dir, 'atlas.png'), blockStates: path.join(this.dir, 'blocksStates.json'), source: 'mojang' }
      }
    } catch { /* No usable cache yet. */ }
    return bundledAssetFiles()
  }

  async prepare ({ fetch = globalThis.fetch, jar = CLIENT_JAR, log = console.log }: { fetch?: typeof globalThis.fetch; jar?: typeof CLIENT_JAR; log?: (message: string) => void } = {}) {
    if (this.files().source === 'mojang') return
    mkdirSync(this.dir, { recursive: true })
    const jarPath = path.join(this.dir, 'client.jar')
    const sha1 = (data: Buffer) => createHash('sha1').update(data).digest('hex')
    let data = existsSync(jarPath) ? readFileSync(jarPath) : null
    if (data && (data.length !== jar.size || sha1(data) !== jar.sha1)) {
      log('[viewer] cached client.jar does not match the pinned SHA-1; downloading again')
      data = null
    }
    if (!data) {
      log(`[viewer] downloading the Minecraft ${ASSET_VERSION} client jar (${Math.round(jar.size / 1048576)} MB, MINECRAFT_EULA=true)`)
      const response = await fetch(jar.url, { signal: AbortSignal.timeout(300000) })
      if (!response.ok) throw new Error('Download failed with HTTP ' + response.status)
      if (Number(response.headers.get('content-length') || jar.size) !== jar.size) throw new Error('Unexpected client.jar size')
      data = Buffer.from(await response.arrayBuffer())
      if (data.length !== jar.size || sha1(data) !== jar.sha1) throw new Error('client.jar does not match the pinned SHA-1')
      writeAtomic(jarPath, data)
    }
    const result = await buildViewerAssets(openZip(data))
    const states = JSON.stringify(result.blockStates)
    writeAtomic(path.join(this.dir, 'atlas.png'), result.atlas)
    writeAtomic(path.join(this.dir, 'blocksStates.json'), states)
    writeAtomic(path.join(this.dir, 'blocksStates.json.gz'), gzipSync(states))
    // meta.json is written last: it marks the cache as complete.
    writeAtomic(path.join(this.dir, 'meta.json'), JSON.stringify({ version: ASSET_VERSION, generator: GENERATOR_VERSION, sha1: jar.sha1 }))
    log(`[viewer] Minecraft ${ASSET_VERSION} assets ready: ${Object.keys(result.blockStates).length} block states, ${result.tiles} tiles` +
      (result.missingModels.length ? `, missing models: ${result.missingModels.slice(0, 10).join(' ')}` : '') +
      (result.missingTextures.length ? `, missing textures: ${result.missingTextures.slice(0, 10).join(' ')}` : '') +
      '. Reopen the 3D view to use them.')
  }
}
