import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { setImmediate as yieldLoop } from 'node:timers/promises'
import { Terrain, type Box, type CollisionCell } from './terrain.js'

type Position = { x: number; y: number; z: number }
type Section = { data: Uint32Array | null }
type Request = { id: number; at: number; phase: 'requested' | 'decoding' | 'retry'; updates: Map<number, number> }
export type WorldColumn = {
  x: number; z: number; announced: boolean; sections: Map<number, Section>;
  attempts: Map<number, number>; requests: Map<number, Request>
}
type BlockInfo = { min: number; max: number }
export type SurfaceCell = [string, number | null, boolean]
export type SurfaceTile = { x: number; z: number; dimension: number; cells: Array<SurfaceCell | null> }
type SurfaceMap = {
  x: number; z: number; width: number; height: number; dimension: number;
  palette: string[]; cells: Array<[number, number | null, boolean] | null>;
  coverage: ReturnType<ChunkWorld['coverage']>; stale: boolean
}
const doorKey = (p: Position) => p.x + ':' + p.y + ':' + p.z
export class WorldError extends Error {
  constructor (message: string, readonly status = 400) { super(message) }
}

export function dimensionId (dimension: number | string | null): number | null {
  if (typeof dimension === 'number' && [0, 1, 2].includes(dimension)) return dimension
  return ({ overworld: 0, nether: 1, end: 2 } as Record<string, number>)[String(dimension)] ?? null
}

export class ChunkWorld {
  onSurfaceTile: ((tile: SurfaceTile) => void) | null = null
  private dirtySurface = new Set<WorldColumn>()
  private surfaceCache = new WeakMap<object, { names: string[]; sections: Array<[number, Section]>; cells: Array<SurfaceCell | null> }>()
  readonly chunks = new Map<string, WorldColumn>()
  worldError: string | null = null
  private worker: Worker | null = null
  private generation = 0
  private revision = 0
  private center: { x: number; z: number } | null = null
  private worldDimension: number | null = null
  private blocks: Record<string, BlockInfo> | null = null
  private stateNames: string[] = []
  private walkFlags = new Uint8Array()
  private collisionIds = new Int32Array()
  private collisionShapes: Record<number, Box[]> = {}
  private doorToggle = new Int32Array()
  private doorOpen = new Uint8Array()
  private doorHalf = new Uint8Array()
  private runtimeIds = new Map<number, number>()
  readonly terrain = new Terrain((x, y, z) => this.collisionAt(x, y, z))
  // When true, routes may pass closed hand-openable doors and fence gates; navigation opens them on the way.
  openDoors = true
  // Doors that did not open during the current navigation ("x:y:z"); planning treats them as closed walls.
  readonly blockedDoors = new Set<string>()
  // Terrain for route planning: closed openable doors count as open unless disabled or blocked.
  readonly planningTerrain = new Terrain((x, y, z) => this.collisionAt(x, y, z, this.openDoors))
  private mapCache: { key: string; data: SurfaceMap } | null = null
  private mapping = false
  private runtime = new Map<number, number>()
  private air = 0
  private nextId = 0
  private jobs = new Set<number>()
  private searching = false
  private minY = -4
  private maxY = 19

  constructor (readonly radius = 4, private version = '1.26.60') {}

  clearChunks () {
    this.flushSurfaceChanges(Infinity)
    this.dirtySurface.clear()
    this.generation++
    const worker = this.worker
    this.worker = null
    if (worker) void worker.terminate().catch(() => {})
    this.chunks.clear()
    this.runtime.clear()
    this.jobs.clear()
    this.blocks = null
    this.stateNames = []
    this.walkFlags = new Uint8Array()
    this.collisionIds = new Int32Array()
    this.collisionShapes = {}
    this.doorToggle = new Int32Array()
    this.doorOpen = new Uint8Array()
    this.doorHalf = new Uint8Array()
    this.runtimeIds.clear()
    this.blockedDoors.clear()
    this.mapCache = null
    this.worldDimension = null
    this.center = null
    this.worldError = null
    this.revision++
  }

  beginWorld (dimension: number | string, hashed: boolean) {
    this.clearChunks()
    this.worldDimension = dimensionId(dimension)
    if (this.worldDimension === null) { this.worldError = 'Unsupported dimension'; return }
    this.minY = this.worldDimension === 0 ? -4 : 0
    this.maxY = this.worldDimension === 0 ? 19 : this.worldDimension === 1 ? 7 : 15
    const worker = this.worker = new Worker(path.join(__dirname, 'chunk-worker.js'))
    worker.unref()
    worker.on('message', message => {
      if (this.worker !== worker) return
      if (message.type === 'ready') {
        this.blocks = message.blocks
        this.walkFlags = message.walkFlags
        this.collisionIds = message.collisionIds
        this.collisionShapes = message.collisionShapes
        this.doorToggle = message.doorToggle
        this.doorOpen = message.doorOpen
        this.doorHalf = message.doorHalf
        for (const [name, block] of Object.entries(this.blocks!)) {
          for (let id = block.min; id <= block.max; id++) this.stateNames[id] = name
        }
        this.air = message.air
        const pairs = message.runtimePairs as Uint32Array
        for (let i = 0; i < pairs.length; i += 2) { this.runtime.set(pairs[i], pairs[i + 1]); this.runtimeIds.set(pairs[i + 1], pairs[i]) }
      } else {
        this.jobs.delete(message.id)
        for (const column of this.chunks.values()) for (const [y, request] of column.requests) {
          if (request.id !== message.id) continue
          column.requests.delete(y)
          if (message.type === 'error') {
            this.flushSurfaceColumn(column)
            column.sections.delete(y)
            this.worldError = message.error
          } else {
            const data = message.data as Uint32Array
            for (const [index, stateId] of request.updates) data[index] = stateId
            column.sections.set(y, { data })
            this.dirtySurface.add(column)
            this.revision++
          }
          return
        }
        if (message.type === 'error' && message.id === undefined) this.worldError = message.error
      }
    })
    worker.on('error', error => {
      if (this.worker !== worker) return
      this.flushSurfaceChanges(Infinity)
      this.worldError = 'Chunk worker: ' + error.message
      this.blocks = null
      this.jobs.clear()
      for (const column of this.chunks.values()) { column.sections.clear(); column.requests.clear() }
      this.revision++
    })
    worker.on('exit', code => {
      if (this.worker === worker && code !== 0) {
        this.flushSurfaceChanges(Infinity)
        this.worldError = 'Chunk worker exited: ' + code
        this.blocks = null
        this.jobs.clear()
        for (const column of this.chunks.values()) { column.sections.clear(); column.requests.clear() }
        this.revision++
      }
    })
    worker.postMessage({ type: 'init', version: this.version, hashed })
  }

  setCenter (position: Position) {
    this.center = { x: Math.floor(position.x / 16), z: Math.floor(position.z / 16) }
    for (const [key, column] of this.chunks) if (!this.inRange(column.x, column.z)) {
      this.flushSurfaceColumn(column)
      this.chunks.delete(key)
      this.revision++
    }
  }

  private inRange (x: number, z: number) {
    return this.center !== null && (x - this.center.x) ** 2 + (z - this.center.z) ** 2 <= this.radius ** 2
  }

  receiveColumn (packet: { x: number; z: number; dimension: number; cache_enabled: boolean; client_biome_update?: boolean }) {
    if (!this.worker || packet.dimension !== this.worldDimension || !Number.isInteger(packet.x) || !Number.isInteger(packet.z) || !this.inRange(packet.x, packet.z)) return
    if (packet.cache_enabled) { this.worldError = 'Server enabled blob cache despite client_cache_status=false'; return }
    const key = packet.x + ':' + packet.z
    if (!this.chunks.has(key)) {
      this.chunks.set(key, { x: packet.x, z: packet.z, announced: true, sections: new Map(), attempts: new Map(), requests: new Map() })
      this.revision++
    } else if (!this.chunks.get(key)!.announced) {
      const column = this.chunks.get(key)!
      column.announced = true; column.attempts.clear(); this.revision++
    } else if (!packet.client_biome_update) {
      const column = this.chunks.get(key)!
      this.flushSurfaceColumn(column)
      column.sections.clear(); column.requests.clear(); column.attempts.clear()
      this.revision++
    }
    // LevelChunk may contain biomes only, even with sub_chunk_count=0. Request block data explicitly.
  }

  requestSubchunks (send: (name: string, params: unknown) => void, now = Date.now()) {
    if (!this.blocks || this.worldDimension === null || !this.center) return
    // BDS may already have announced a column we previously discarded outside our cache radius.
    let complete = true
    for (let dx = -this.radius; dx <= this.radius; dx++) for (let dz = -this.radius; dz <= this.radius; dz++) {
      if (dx * dx + dz * dz > this.radius ** 2) continue
      const x = this.center.x + dx; const z = this.center.z + dz; const key = x + ':' + z
      if (!this.chunks.has(key)) this.chunks.set(key, {x, z, announced:false, sections:new Map(), attempts:new Map(), requests:new Map()})
      if (this.chunks.get(key)!.sections.size !== this.maxY-this.minY+1) complete = false
    }
    if (complete) return
    let pending = 0
    for (const column of this.chunks.values()) for (const [y, request] of column.requests) {
      if ((request.phase === 'requested' && now - request.at > 5000) ||
          (request.phase === 'retry' && now - request.at >= 500 * 2 ** ((column.attempts.get(y) || 1) - 1))) column.requests.delete(y)
      else if (request.phase !== 'retry') pending++
    }
    let budget = Math.min(8, 32 - pending)
    if (budget <= 0) return
    const columns = [...this.chunks.values()].sort((a, b) => Number(b.announced) - Number(a.announced) ||
      (a.x - this.center!.x) ** 2 + (a.z - this.center!.z) ** 2 - ((b.x - this.center!.x) ** 2 + (b.z - this.center!.z) ** 2))
    for (const column of columns) {
      const requests = []
      for (let y = this.minY; y <= this.maxY && budget > 0; y++) {
        if (column.sections.has(y) || column.requests.has(y) || (column.attempts.get(y) || 0) >= 3) continue
        column.attempts.set(y, (column.attempts.get(y) || 0) + 1)
        column.requests.set(y, { id: ++this.nextId, at: now, phase: 'requested', updates: new Map() })
        requests.push({ x: 0, y: y - this.minY, z: 0 })
        budget--
      }
      if (requests.length) send('subchunk_request', { dimension: this.worldDimension, origin: { x: column.x, y: this.minY, z: column.z }, requests })
      if (budget === 0) break
    }
  }

  receiveSubchunks (packet: { dimension: number; cache_enabled: boolean; origin: Position; entries: Array<{ dx: number; dy: number; dz: number; result: string | number; payload?: Uint8Array }> }) {
    if (packet.dimension !== this.worldDimension || !this.worker || !this.blocks) return
    for (const entry of packet.entries.slice(0, 256)) {
      const x = packet.origin.x + entry.dx; const y = packet.origin.y + entry.dy; const z = packet.origin.z + entry.dz
      const column = this.chunks.get(x + ':' + z)
      const request = column?.requests.get(y)
      if (!column || !request || request.phase !== 'requested') continue
      if (packet.cache_enabled) { column.requests.delete(y); this.worldError = 'Cached subchunks are unsupported'; continue }
      if (entry.result === 'success_all_air' || entry.result === 6) {
        column.sections.set(y, { data: null }); column.requests.delete(y); this.revision++
        this.dirtySurface.add(column)
      } else if ((entry.result === 'success' || entry.result === 1) && entry.payload?.length && entry.payload.length <= 1024 * 1024 && this.jobs.size < 32) {
        request.phase = 'decoding'
        const payload = Uint8Array.from(entry.payload)
        this.jobs.add(request.id)
        this.worker.postMessage({ type: 'decode', id: request.id, y, payload }, [payload.buffer])
      } else {
        request.phase = 'retry'
        this.worldError = 'Subchunk unavailable: ' + entry.result
      }
    }
  }

  updateBlock (position: Position, runtimeId: number, layer = 0) {
    if (!this.blocks) return
    if (![position?.x, position?.y, position?.z, runtimeId, layer].every(Number.isSafeInteger) || ![0, 1].includes(layer)) return
    const x = Math.floor(position.x / 16); const z = Math.floor(position.z / 16); const y = Math.floor(position.y / 16)
    const column = this.chunks.get(x + ':' + z)
    if (!column || y < this.minY || y > this.maxY) return
    const stateId = this.runtime.get(runtimeId >>> 0)
    if (stateId === undefined) {
      this.flushSurfaceColumn(column)
      column.sections.delete(y)
      const request = column.requests.get(y)
      if (request) column.requests.delete(y)
      this.worldError = 'Unknown block runtime ID ' + runtimeId
      this.revision++
      return
    }
    const index = layer * 4096 + ((position.x & 15) << 8) + ((position.y & 15) << 4) + (position.z & 15)
    const request = column.requests.get(y)
    if (request?.phase === 'decoding') request.updates.set(index, stateId)
    const section = column.sections.get(y)
    if (!section) return
    if ((section.data?.[index] ?? this.air) === stateId) return
    const data = section.data ? section.data.slice() : new Uint32Array(8192).fill(this.air)
    data[index] = stateId
    column.sections.set(y, { data })
    this.dirtySurface.add(column)
    this.revision++
  }

  coverage () {
    let expectedChunks = 0; let known = 0; let completeChunks = 0; let loadedChunks = 0; let pending = 0; let failed = 0
    for (let x = -this.radius; x <= this.radius; x++) for (let z = -this.radius; z <= this.radius; z++) if (x * x + z * z <= this.radius ** 2) expectedChunks++
    const height = this.maxY - this.minY + 1
    for (const column of this.chunks.values()) {
      known += column.sections.size; pending += [...column.requests.values()].filter(r => r.phase !== 'retry').length
      if (column.sections.size > 0) loadedChunks++
      if (column.sections.size === height) completeChunks++
      for (const [y, attempts] of column.attempts) if (attempts >= 3 && !column.sections.has(y) && (!column.requests.has(y) || column.requests.get(y)!.phase === 'retry')) failed++
    }
    const total = expectedChunks * height
    return { session: this.generation, ready: this.blocks !== null, radius: this.radius, expectedChunks, receivedChunks: [...this.chunks.values()].filter(c => c.announced).length, loadedChunks, completeChunks,
      knownSubchunks: known, totalSubchunks: total, pendingSubchunks: pending, failedSubchunks: failed,
      complete: this.blocks !== null && known === total, error: this.worldError }
  }

  blockIds () {
    return Object.keys(this.blocks ?? {}).sort()
  }

  get worldRevision () { return this.revision }
  get worldSession () { return this.generation }

  flushSurfaceChanges (limit = 2) {
    if (!this.onSurfaceTile) { this.dirtySurface.clear(); return }
    for (const column of this.dirtySurface) {
      if (limit-- <= 0) break
      this.flushSurfaceColumn(column)
    }
  }

  private flushSurfaceColumn (column: WorldColumn) {
    if (!this.dirtySurface.delete(column) || !this.onSurfaceTile || this.worldDimension === null) return
    this.onSurfaceTile({ x: column.x, z: column.z, dimension: this.worldDimension, cells: this.surfaceCells(column) })
  }

  private surfaceCells (column: Pick<WorldColumn, 'sections'>): Array<SurfaceCell | null> {
    const cached = this.surfaceCache.get(column)
    if (cached?.names === this.stateNames && cached.sections.length === column.sections.size &&
      cached.sections.every(([y, section]) => column.sections.get(y) === section)) return cached.cells
    const cells: Array<SurfaceCell | null> = Array(256).fill(null)
    for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
      let confirmed = true; let name = 'minecraft:air'; let height: number | null = null
      scan: for (let y = this.maxY; y >= this.minY; y--) {
        const section = column.sections.get(y)
        if (!section) { confirmed = false; continue }
        if (!section.data) continue
        for (let localY = 15; localY >= 0; localY--) {
          const i = (x << 8) | (localY << 4) | z
          const state = section.data[i] !== this.air ? section.data[i] : section.data[4096 + i]
          if (state === this.air) continue
          name = this.stateNames[state]; height = y * 16 + localY; break scan
        }
      }
      if (height !== null || confirmed) cells[z * 16 + x] = [name, height, confirmed]
    }
    this.surfaceCache.set(column, { names: this.stateNames, sections: [...column.sections], cells })
    return cells
  }

  surfaceObservation (x: number, z: number, dimension: number) {
    if (!this.blocks || dimension !== this.worldDimension) return null
    const column = this.chunks.get(x + ':' + z)
    return column ? this.surfaceCells(column) : null
  }

  private stateAt (x: number, y: number, z: number, layer = 0): number | null {
    if (!this.blocks) return null
    const section = this.chunks.get(Math.floor(x / 16) + ':' + Math.floor(z / 16))?.sections.get(Math.floor(y / 16))
    if (!section) return null
    return section.data?.[layer * 4096 + ((x & 15) << 8) + ((y & 15) << 4) + (z & 15)] ?? this.air
  }

  // Block state at (x, y, z), with an upper door half replaced by the lower half below it, which holds facing and open state.
  private doorBase (x: number, y: number, z: number): { y: number; id: number } | null {
    const id = this.stateAt(x, y, z)
    if (id === null || this.doorHalf[id] !== 2) return id === null ? null : { y, id }
    const below = this.stateAt(x, y - 1, z)
    return below !== null && this.doorHalf[below] === 1 ? { y: y - 1, id: below } : { y, id }
  }

  /** Network runtime ID of the block state at (x, y, z), or null while unknown. */
  blockRuntimeIdAt (x: number, y: number, z: number): number | null {
    const id = this.stateAt(x, y, z)
    return id === null ? null : this.runtimeIds.get(id) ?? null
  }

  // A hand-openable door or fence gate in block (x, y, z), resolved to its lower half: position, open state and network runtime ID.
  doorAt (x: number, y: number, z: number): { position: Position; open: boolean; runtimeId: number } | null {
    const base = this.doorBase(x, y, z)
    if (!base || !(this.doorToggle[base.id] >= 0)) return null
    const runtimeId = this.runtimeIds.get(base.id)
    return runtimeId === undefined ? null : { position: { x, y: base.y, z }, open: this.doorOpen[base.id] === 1, runtimeId }
  }

  // The closed, openable door or gate a player standing at (x, feetY, z) would occupy (feet first, then head),
  // or null. Disabled door opening and doors blocked for this navigation count as none.
  closedDoorAt (x: number, z: number, feetY: number): Position | null {
    if (!this.openDoors) return null
    const bx = Math.floor(x); const bz = Math.floor(z); const foot = Math.floor(feetY + 1e-4)
    for (const by of [foot, foot + 1]) {
      const door = this.doorAt(bx, by, bz)
      if (!door) continue
      return !door.open && !this.blockedDoors.has(doorKey(door.position)) ? door.position : null
    }
    return null
  }

  // Diagnostics: every door or fence gate block within `radius` columns and feet-1..feet+2, with state ID,
  // door flags and collision boxes as walked (real) and as planned (doors assumed open).
  describeDoors (x: number, z: number, feetY: number, radius = 8): string[] {
    const lines: string[] = []; const foot = Math.floor(feetY + 1e-4)
    for (let bx = Math.floor(x) - radius; bx <= Math.floor(x) + radius; bx++) for (let bz = Math.floor(z) - radius; bz <= Math.floor(z) + radius; bz++) {
      for (let by = foot - 1; by <= foot + 2; by++) {
        const id = this.stateAt(bx, by, bz)
        if (id === null || !/door$|fence_gate$/.test(this.stateNames[id] ?? '')) continue
        const boxes = (cell: CollisionCell | null) => cell ? JSON.stringify(cell.boxes.map(b => b.map(n => +n.toFixed(3)))) : 'unbekannt'
        lines.push(`${this.stateNames[id]} #${id} (${bx}, ${by}, ${bz}) Hälfte ${this.doorHalf[id]} Gegenstück ${this.doorToggle[id]} offen ${this.doorOpen[id]} ` +
          `Laufen ${boxes(this.collisionAt(bx, by, bz))} Planung ${boxes(this.collisionAt(bx, by, bz, this.openDoors))} gesperrt ${this.blockedDoors.has(bx + ':' + by + ':' + bz)}`)
      }
    }
    return lines
  }

  private collisionAt (x: number, y: number, z: number, assumeOpen = false): CollisionCell | null {
    if (!this.blocks) return null
    const section = this.chunks.get(Math.floor(x / 16) + ':' + Math.floor(z / 16))?.sections.get(Math.floor(y / 16))
    if (!section) return null
    const index = ((x & 15) << 8) + ((y & 15) << 4) + (z & 15)
    const boxes: Box[] = []; let support = false
    for (let layer = 0; layer < 2; layer++) {
      let id = section.data?.[layer * 4096 + index] ?? this.air
      let baseY = y
      if (layer === 0 && this.doorHalf[id] === 2) {
        const base = this.doorBase(x, y, z)
        if (base) { id = base.id; baseY = base.y }
      }
      if (assumeOpen && layer === 0 && this.doorToggle[id] >= 0 && !this.doorOpen[id] && !this.blockedDoors.has(x + ':' + baseY + ':' + z)) id = this.doorToggle[id]
      const shape = this.collisionIds[id]
      if (shape === undefined || shape < 0 || !this.collisionShapes[shape]) return null
      boxes.push(...this.collisionShapes[shape])
      support ||= this.walkFlags[id] === 2
    }
    return { boxes, support }
  }

  canStandAt (x: number, z: number, feetY: number) {
    return this.terrain.canStandAt(x, z, feetY)
  }

  async surfaceMap (signal?: AbortSignal): Promise<SurfaceMap> {
    if (!this.blocks || !this.center || this.worldDimension === null) throw new WorldError('World data is not ready', 409)
    const generation = this.generation; const revision = this.revision
    const center = { ...this.center }
    const key = [generation, revision, center.x, center.z].join(':')
    if (this.mapCache?.key === key) return this.mapCache.data
    if (this.mapping) throw new WorldError('Map is already being generated', 429)
    const width = (this.radius * 2 + 1) * 16
    const x = (center.x - this.radius) * 16; const z = (center.z - this.radius) * 16
    const palette = ['minecraft:air']; const indices = new Map([[palette[0], 0]])
    const cells: SurfaceMap['cells'] = Array(width * width).fill(null)
    // Block updates replace section arrays, so this snapshot stays consistent while yielding.
    const columns = [...this.chunks.values()].map(column => ({ x: column.x, z: column.z, sections: new Map(column.sections) }))
    const result: SurfaceMap = { x, z, width, height: width, dimension: this.worldDimension, palette, cells, coverage: this.coverage(), stale: false }
    this.mapping = true
    try {
      for (const column of columns) {
        if (generation !== this.generation) throw new WorldError('World changed; reload map', 409)
        const surface = this.surfaceCells(column)
        for (let localZ = 0; localZ < 16; localZ++) {
          await yieldLoop()
          if (signal?.aborted) throw new WorldError('Map cancelled', 499)
          if (generation !== this.generation) throw new WorldError('World changed; reload map', 409)
          for (let localX = 0; localX < 16; localX++) {
            const cell = surface[localZ * 16 + localX]
            if (!cell) continue
            const [name, height, confirmed] = cell
            let index = indices.get(name)
            if (index === undefined) { index = palette.length; indices.set(name, index); palette.push(name) }
            const offset = (column.z * 16 + localZ - z) * width + column.x * 16 + localX - x
            cells[offset] = [index, height, confirmed]
          }
        }
      }
      result.stale = revision !== this.revision || center.x !== this.center?.x || center.z !== this.center?.z
      if (!result.stale) this.mapCache = { key, data: result }
      return result
    } finally { this.mapping = false }
  }

  // One block ID or a list of them; a hit is any block whose state belongs to one of the IDs.
  async searchBlocks<T extends string | string[]> (blockId: T, limit: number, position: Position | null, signal?: AbortSignal) {
    const ids = ([] as string[]).concat(blockId)
    if (!ids.length || ids.some(id => !/^(minecraft:)?[a-z0-9_]{1,100}$/.test(id))) throw new WorldError('Invalid block ID')
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new WorldError('Limit must be 1..100')
    if (!this.blocks || !position) throw new WorldError('World data is not ready', 409)
    if (this.searching) throw new WorldError('A search is already running', 429)
    const canonicals = ids.map(id => id.startsWith('minecraft:') ? id : 'minecraft:' + id)
    const ranges: BlockInfo[] = []
    for (const name of canonicals) {
      const block = this.blocks[name]
      if (!block) throw new WorldError('Unknown block ID: ' + name)
      ranges.push(block)
    }
    // The result names the IDs as given: one canonical string, or the canonical list.
    const canonical = (Array.isArray(blockId) ? canonicals : canonicals[0]) as T
    const matches = (id: number) => ranges.some(range => id >= range.min && id <= range.max)
    const origin = { ...position }; const generation = this.generation; const revision = this.revision
    const coverage = this.coverage()
    const sections = [...this.chunks.values()].flatMap(column => [...column.sections].map(([y, section]) => ({ x: column.x, z: column.z, y, ...section })))
    const distanceToSection = (s: { x: number; y: number; z: number }) => {
      const d = (v: number, start: number) => Math.max(start - v, 0, v - (start + 15))
      return d(origin.x, s.x * 16) ** 2 + d(origin.y, s.y * 16) ** 2 + d(origin.z, s.z * 16) ** 2
    }
    sections.sort((a, b) => distanceToSection(a) - distanceToSection(b))
    const hits: Array<Position & { distance: number }> = []
    let found = 0
    const compare = (a: Position & { distance: number }, b: Position & { distance: number }) => a.distance - b.distance || a.x - b.x || a.y - b.y || a.z - b.z
    this.searching = true
    try {
      for (const section of sections) {
        if (hits.length === limit && distanceToSection(section) > hits[limit - 1].distance ** 2 + 1e-8) continue
        if (section.data === null && !matches(this.air)) continue
        for (let i = 0; i < 4096; i++) {
          if ((i & 511) === 0) {
            await yieldLoop()
            if (signal?.aborted) throw new WorldError('Search cancelled', 499)
            if (this.generation !== generation) throw new WorldError('World changed; repeat search', 409)
          }
          const a = section.data?.[i] ?? this.air; const b = section.data?.[4096 + i] ?? this.air
          if (!(matches(a) || (b !== this.air && matches(b)))) continue
          found++
          const x = section.x * 16 + (i >>> 8); const y = section.y * 16 + ((i >>> 4) & 15); const z = section.z * 16 + (i & 15)
          const hit = { x, y, z, distance: Math.hypot(x - origin.x, y - origin.y, z - origin.z) }
          if (hits.length === limit && compare(hit, hits[limit - 1]) >= 0) continue
          hits.push(hit); hits.sort(compare)
          if (hits.length > limit) hits.pop()
        }
      }
      return { blockId: canonical, origin, hits, limit, limitReached: found >= limit, coverage, stale: this.revision !== revision,
        outcome: hits.length ? 'found' : coverage.complete ? 'not_found' : 'unknown' }
    } finally { this.searching = false }
  }
}
