/*
 * Custom player skin, sent once in the login chain (bedrock-protocol `skinData`); a change applies on the next connect.
 * One JSON file (data/skin.json) holds the model and the normalised 64x64 PNG; writes go to a temp file and are renamed atomically.
 * An unreadable file is reported and the bot connects with the default skin; only an upload or delete replaces it.
 */
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { PNG } from 'pngjs'
import { WorldError } from './world.js'

export const SKIN_MODELS = ['classic', 'slim'] as const
export type SkinModel = typeof SKIN_MODELS[number]
export const SKIN_PNG_MAX = 48 * 1024
type StoredSkin = { model: SkinModel; png: string; sha256: string }
type LoadedSkin = StoredSkin & { rgba: Buffer }

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex')

/** Java's legacy conversion: the left arm and leg of a 64x32 skin are mirrored copies of the right ones. */
function expandLegacy (source: Buffer) {
  const target = Buffer.alloc(64 * 64 * 4)
  source.copy(target, 0, 0, 64 * 32 * 4)
  const copyMirrored = (x: number, y: number, dx: number, dy: number, width: number, height: number) => {
    for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
      const from = ((y + j) * 64 + x + i) * 4
      const to = ((y + dy + j) * 64 + x + dx + width - 1 - i) * 4
      target.copy(target, to, from, from + 4)
    }
  }
  copyMirrored(4, 16, 16, 32, 4, 4); copyMirrored(8, 16, 16, 32, 4, 4)
  copyMirrored(0, 20, 24, 32, 4, 12); copyMirrored(4, 20, 16, 32, 4, 12); copyMirrored(8, 20, 8, 32, 4, 12); copyMirrored(12, 20, 16, 32, 4, 12)
  copyMirrored(44, 16, -8, 32, 4, 4); copyMirrored(48, 16, -8, 32, 4, 4)
  copyMirrored(40, 20, 0, 32, 4, 12); copyMirrored(44, 20, -8, 32, 4, 12); copyMirrored(48, 20, -16, 32, 4, 12); copyMirrored(52, 20, -8, 32, 4, 12)
  return target
}

/** Validates an uploaded PNG and returns the 64x64 RGBA pixels; a 64x32 skin is expanded. */
export function normaliseSkin (png: Buffer): Buffer {
  if (png.length > SKIN_PNG_MAX) throw new WorldError(`PNG exceeds ${SKIN_PNG_MAX} bytes`, 413)
  // Check the header before decoding, so a tiny file cannot declare a huge image.
  if (png.length < 24 || !png.subarray(0, 8).equals(PNG_SIGNATURE) || png.toString('latin1', 12, 16) !== 'IHDR') throw new WorldError('Not a PNG file')
  const width = png.readUInt32BE(16); const height = png.readUInt32BE(20)
  if (width !== 64 || (height !== 64 && height !== 32)) throw new WorldError(`Skin must be 64x64 or 64x32 pixels, not ${width}x${height}`)
  let image: PNG
  try { image = PNG.sync.read(png) } catch { throw new WorldError('PNG cannot be decoded') }
  return height === 32 ? expandLegacy(image.data) : Buffer.from(image.data)
}

function encodePng (rgba: Buffer) {
  const image = new PNG({ width: 64, height: 64 })
  rgba.copy(image.data)
  return PNG.sync.write(image)
}

export class SkinStore {
  private skin: LoadedSkin | null = null
  private lock: Promise<unknown> = Promise.resolve()
  /** Hash of the skin sent at the last connect (null: default skin). */
  private active: string | null = null
  error: string | null = null

  constructor (private file: string) {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as StoredSkin
      if (!data || !SKIN_MODELS.includes(data.model) || typeof data.png !== 'string' || typeof data.sha256 !== 'string') throw new Error('missing fields')
      const png = Buffer.from(data.png, 'base64')
      if (sha256(png) !== data.sha256) throw new Error('checksum mismatch')
      this.skin = { ...data, rgba: normaliseSkin(png) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.error = `Invalid skin file ${file}: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  private exclusive<T> (work: () => Promise<T>): Promise<T> {
    const result = this.lock.then(work)
    this.lock = result.catch(() => {})
    return result
  }

  private async commit (next: LoadedSkin | null) {
    if (next) {
      await mkdir(path.dirname(this.file), { recursive: true })
      const temporary = this.file + '.' + randomUUID() + '.tmp'
      await writeFile(temporary, JSON.stringify({ model: next.model, png: next.png, sha256: next.sha256 }), 'utf8')
      await rename(temporary, this.file)
    } else await rm(this.file, { force: true })
    this.skin = next
    this.error = null
  }

  /** The saved PNG, served to the UI preview. */
  png () { return this.skin ? Buffer.from(this.skin.png, 'base64') : null }

  status () {
    return { saved: this.skin?.sha256 ?? null, model: this.skin?.model ?? null, active: this.active, error: this.error }
  }

  save (pngBase64: unknown, model: unknown) {
    if (!SKIN_MODELS.includes(model as SkinModel)) return Promise.reject(new WorldError('Model must be classic or slim'))
    if (typeof pngBase64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(pngBase64)) return Promise.reject(new WorldError('Provide the PNG as base64'))
    let rgba: Buffer
    try { rgba = normaliseSkin(Buffer.from(pngBase64, 'base64')) } catch (error) { return Promise.reject(error) }
    const png = encodePng(rgba)
    const skin: LoadedSkin = { model: model as SkinModel, png: png.toString('base64'), sha256: sha256(png), rgba }
    return this.exclusive(async () => { await this.commit(skin); return this.status() })
  }

  remove () { return this.exclusive(async () => { await this.commit(null); return this.status() }) }

  /** Login fields for bedrock-protocol's `skinData`; records which skin the new connection uses. */
  connectSkinData (): Record<string, unknown> {
    if (this.error) console.error('Skin:', this.error, '- connecting with the default skin')
    const skin = this.skin
    this.active = skin?.sha256 ?? null
    if (!skin) return {}
    const slim = skin.model === 'slim'
    // Replaces bedrock-protocol's default persona skin with a classic skin on the built-in humanoid geometry.
    return {
      SkinId: 'Custom_' + skin.sha256.slice(0, 16),
      SkinData: skin.rgba.toString('base64'),
      SkinImageWidth: 64,
      SkinImageHeight: 64,
      SkinResourcePatch: Buffer.from(JSON.stringify({ geometry: { default: slim ? 'geometry.humanoid.customSlim' : 'geometry.humanoid.custom' } })).toString('base64'),
      ArmSize: slim ? 'slim' : 'wide',
      PersonaSkin: false,
      PersonaPieces: [],
      PieceTintColors: [],
      AnimatedImageData: [],
      SkinAnimationData: '',
      PremiumSkin: false,
      CapeOnClassicSkin: false
    }
  }
}
