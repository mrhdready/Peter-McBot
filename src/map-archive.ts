import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { WorldError, type SurfaceCell, type SurfaceTile } from './world.js'

type Entry = { tile: SurfaceTile; dirty: boolean; saving?: Promise<void> }
export type ArchivedTile = SurfaceTile & { live: boolean[]; hash: string }
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const sameCell = (a: SurfaceCell | null | undefined, b: SurfaceCell | null | undefined) =>
  a === b || Boolean(a && b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2])

export class MapArchive {
  private cache = new Map<string, Entry>()
  private missing = new Set<string>()
  private pending = new Map<string, SurfaceTile>()
  private work: Promise<void> | null = null
  private writing: Promise<void> | null = null
  private directory: string
  private overflow = false
  private drainFailed = false
  private presentations = new WeakMap<SurfaceTile, { observation: Array<SurfaceCell | null> | null; data: ArchivedTile }>()
  error: string | null = null

  constructor (root: string, server: string, worldId: string) {
    this.directory = path.join(root, fingerprint([server, worldId]))
  }

  private key (dimension: number, x: number, z: number) { return `${dimension}/${x},${z}` }
  private filename (key: string) { return path.join(this.directory, key + '.json') }

  observe (tile: SurfaceTile) {
    const key = this.key(tile.dimension, tile.x, tile.z)
    if (!this.pending.has(key) && this.pending.size >= 256) {
      this.overflow = true
      this.error = 'Map persistence backlog is full; new observations could not be recorded'
      return
    }
    const previous = this.pending.get(key)
    if (previous) tile = { ...tile, cells: this.merge(previous.cells, tile.cells) }
    this.pending.set(key, tile)
    this.drain()
  }

  private merge (old: Array<SurfaceCell | null>, fresh: Array<SurfaceCell | null>) {
    return fresh.map((cell, i) => !cell || (old[i]?.[2] && !cell[2]) || sameCell(old[i], cell) ? old[i] : cell)
  }

  private drain () {
    if (this.work) return
    this.drainFailed = false
    this.work = (async () => {
      for (const [key, tile] of this.pending) {
        this.pending.delete(key)
        try {
          const loaded = await this.load(tile.dimension, tile.x, tile.z)
          const entry = this.cache.get(key) ?? loaded
          this.cache.delete(key); this.cache.set(key, entry)
          const cells = this.merge(entry.tile.cells, tile.cells)
          if (cells.some((cell, i) => cell !== entry.tile.cells[i])) {
            entry.tile = { ...tile, cells }; entry.dirty = true
          }
          if (this.cache.size > 128) await this.trim()
        } catch (error) {
          // Keep the observation for retry; never overwrite an unreadable archive.
          const newer = this.pending.get(key)
          this.pending.set(key, newer ? { ...tile, cells: this.merge(tile.cells, newer.cells) } : tile)
          this.error = String(error); this.drainFailed = true; break
        }
      }
    })().finally(() => { this.work = null })
  }

  private async load (dimension: number, x: number, z: number) {
    const key = this.key(dimension, x, z)
    let entry = this.cache.get(key)
    if (!entry) {
      let tile: SurfaceTile = { dimension, x, z, cells: Array(256).fill(null) }
      if (!this.missing.has(key)) {
        try {
          const data = JSON.parse(await readFile(this.filename(key), 'utf8')) as SurfaceTile
          if (data.dimension !== dimension || data.x !== x || data.z !== z || !Array.isArray(data.cells) || data.cells.length !== 256 ||
            !data.cells.every(cell => cell === null || (Array.isArray(cell) && cell.length === 3 && typeof cell[0] === 'string' && /^minecraft:[a-z0-9_]+$/.test(cell[0]) &&
              (cell[1] === null || (Number.isInteger(cell[1]) && cell[1] >= -64 && cell[1] <= 319)) && typeof cell[2] === 'boolean'))) throw new Error('Invalid map tile: ' + key)
          tile = data
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          if (this.missing.size >= 2048) this.missing.delete(this.missing.values().next().value!)
          this.missing.add(key)
        }
      }
      // A concurrent reader may have loaded and updated this tile while readFile yielded.
      entry = this.cache.get(key) ?? { tile, dirty: false }
    }
    this.cache.delete(key); this.cache.set(key, entry)
    return entry
  }

  private async save (key: string, entry: Entry): Promise<void> {
    if (entry.saving) { await entry.saving; return this.save(key, entry) }
    if (!entry.dirty) return
    entry.saving = (async () => {
      const tile = entry.tile
      const filename = this.filename(key)
      await mkdir(path.dirname(filename), { recursive: true })
      const temporary = filename + '.' + randomUUID() + '.tmp'
      await writeFile(temporary, JSON.stringify(tile), 'utf8')
      await rename(temporary, filename)
      this.missing.delete(key)
      if (entry.tile === tile) entry.dirty = false
    })()
    try { await entry.saving } finally { entry.saving = undefined }
  }

  private async trim () {
    for (const [key, entry] of this.cache) {
      if (this.cache.size <= 128) break
      await this.save(key, entry)
      if (!entry.dirty && this.cache.get(key) === entry) this.cache.delete(key)
    }
  }

  async flush (): Promise<void> {
    if (this.writing) { await this.writing; return this.flush() }
    this.writing = (async () => {
      do {
        this.drain(); await this.work
        if (this.drainFailed) throw new Error(this.error || 'Map observations could not be processed')
        for (const [key, entry] of this.cache) await this.save(key, entry)
        await this.trim()
      } while (this.work || this.pending.size || [...this.cache.values()].some(entry => entry.dirty))
      if (this.overflow) throw new Error(this.error || 'Map persistence backlog overflowed; some observations were not recorded')
      this.error = null
    })().catch(error => { this.error = String(error); throw error }).finally(() => { this.writing = null })
    return this.writing
  }

  async tile (dimension: number, x: number, z: number, observation: Array<SurfaceCell | null> | null): Promise<ArchivedTile> {
    if (![0, 1, 2].includes(dimension) || ![x, z].every(n => Number.isInteger(n) && Math.abs(n) <= 1875000)) throw new WorldError('Invalid map tile')
    await this.work
    const entry = await this.load(dimension, x, z)
    const cached = this.presentations.get(entry.tile)
    if (cached?.observation === observation) { await this.trim(); return cached.data }
    const cells = observation ? this.merge(entry.tile.cells, observation) : entry.tile.cells
    const live = cells.map((cell, i) => Boolean(cell && observation?.[i] && sameCell(cell, observation[i])))
    const tile = { ...entry.tile, cells, live, hash: fingerprint([cells, live]) }
    this.presentations.set(entry.tile, { observation, data: tile })
    await this.trim()
    return tile
  }
}
