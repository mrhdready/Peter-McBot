/*
 * Saved places (POIs) and the recent navigation targets, persisted per server/world like the map archive.
 * One JSON file per server/world under data/places/; writes go to a temp file and are renamed atomically.
 * Every operation runs exclusively and commits in memory only after the write succeeded.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { WorldError } from './world.js'

export const POI_ICONS = ['home', 'mine', 'portal', 'farm', 'storage', 'star'] as const
export type PoiIcon = typeof POI_ICONS[number]
export type Poi = { id: string; name: string; x: number; z: number; dimension: number; icon: PoiIcon; createdAt: number }
export type HistoryEntry = { x: number; z: number; dimension: number; at: number }
type Places = { pois: Poi[]; history: HistoryEntry[] }

export const POI_NAME_MAX = 40
export const POI_MAX = 200
export const HISTORY_MAX = 10
const COORDINATE_MAX = 30000000
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const isCoordinate = (n: unknown): n is number => Number.isInteger(n) && Math.abs(n as number) <= COORDINATE_MAX
const isDimension = (n: unknown): n is number => n === 0 || n === 1 || n === 2
const cleanName = (name: unknown) => typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : ''

function validPoi (poi: Poi) {
  return poi && typeof poi.id === 'string' && /^[0-9a-f-]{36}$/.test(poi.id) && typeof poi.name === 'string' &&
    poi.name.length >= 1 && poi.name.length <= POI_NAME_MAX && isCoordinate(poi.x) && isCoordinate(poi.z) &&
    isDimension(poi.dimension) && POI_ICONS.includes(poi.icon) && Number.isFinite(poi.createdAt)
}
function validEntry (entry: HistoryEntry) {
  return entry && isCoordinate(entry.x) && isCoordinate(entry.z) && isDimension(entry.dimension) && Number.isFinite(entry.at)
}

export class PlaceStore {
  private file: string
  private data: Places | null = null
  private lock: Promise<unknown> = Promise.resolve()
  /** Increases after every committed change; clients refetch when it differs. */
  revision = 0

  constructor (root: string, server: string, worldId: string, private now = () => Date.now()) {
    this.file = path.join(root, fingerprint([server, worldId]) + '.json')
  }

  private exclusive<T> (work: () => Promise<T>): Promise<T> {
    const result = this.lock.then(work)
    this.lock = result.catch(() => {})
    return result
  }

  private async load (): Promise<Places> {
    if (this.data) return this.data
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8')) as Places
      // Never overwrite an unreadable file; the error surfaces until it is fixed by hand.
      if (!data || !Array.isArray(data.pois) || !Array.isArray(data.history) || !data.pois.every(validPoi) || !data.history.every(validEntry)) throw new Error('Invalid places file: ' + this.file)
      this.data = data
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.data = { pois: [], history: [] }
    }
    return this.data
  }

  private async commit (next: Places) {
    await mkdir(path.dirname(this.file), { recursive: true })
    const temporary = this.file + '.' + randomUUID() + '.tmp'
    await writeFile(temporary, JSON.stringify(next), 'utf8')
    await rename(temporary, this.file)
    this.data = next
    this.revision++
  }

  list (dimension: number) {
    if (!isDimension(dimension)) return Promise.reject(new WorldError('Invalid dimension'))
    return this.exclusive(async () => {
      const data = await this.load()
      return { pois: data.pois.filter(poi => poi.dimension === dimension), history: data.history.filter(entry => entry.dimension === dimension) }
    })
  }

  add (input: { name: unknown; icon: unknown; x: unknown; z: unknown; dimension: unknown }) {
    const name = cleanName(input.name)
    const { x, z, dimension, icon } = input
    if (!name || name.length > POI_NAME_MAX) return Promise.reject(new WorldError(`Name must have 1 to ${POI_NAME_MAX} characters`))
    if (!POI_ICONS.includes(icon as PoiIcon)) return Promise.reject(new WorldError('Unknown icon'))
    if (!isCoordinate(x) || !isCoordinate(z)) return Promise.reject(new WorldError(`Provide integer x and z (-${COORDINATE_MAX}..${COORDINATE_MAX})`))
    if (!isDimension(dimension)) return Promise.reject(new WorldError('Invalid dimension'))
    return this.exclusive(async () => {
      const data = await this.load()
      if (data.pois.filter(poi => poi.dimension === dimension).length >= POI_MAX) throw new WorldError(`At most ${POI_MAX} places per dimension`, 409)
      const poi: Poi = { id: randomUUID(), name, x, z, dimension, icon: icon as PoiIcon, createdAt: this.now() }
      await this.commit({ ...data, pois: [...data.pois, poi] })
      return poi
    })
  }

  remove (id: unknown) {
    if (typeof id !== 'string') return Promise.reject(new WorldError('Provide the place id'))
    return this.exclusive(async () => {
      const data = await this.load()
      if (!data.pois.some(poi => poi.id === id)) throw new WorldError('Place not found', 404)
      await this.commit({ ...data, pois: data.pois.filter(poi => poi.id !== id) })
    })
  }

  /** Moves an existing X/Z to the top instead of repeating it; keeps the newest HISTORY_MAX per dimension. */
  recordNavigation (dimension: number, x: number, z: number) {
    if (!isDimension(dimension) || !isCoordinate(x) || !isCoordinate(z)) return Promise.reject(new WorldError('Invalid navigation target'))
    return this.exclusive(async () => {
      const data = await this.load()
      const others = data.history.filter(entry => entry.dimension !== dimension)
      const same = data.history.filter(entry => entry.dimension === dimension && (entry.x !== x || entry.z !== z))
      await this.commit({ ...data, history: [{ x, z, dimension, at: this.now() }, ...same].slice(0, HISTORY_MAX).concat(others) })
    })
  }
}
