import type { Server as HttpServer } from 'node:http'
import { Server } from 'socket.io'
import { Worker } from 'node:worker_threads'
import path from 'node:path'
import type { WorldState } from './state.js'
import type { WorldColumn } from './world.js'
import { VIEWER_VERSION, viewerPose } from './viewer-mapping.js'
import { bundledAssetFiles, type AssetFiles } from './viewer-assets.js'

export type ViewerSelf = { name: string; sleeping: boolean }

/** Independent viewer feed: subscriptions never request chunks or control the bot. */
export function createViewerStream (server: HttpServer, world: WorldState, assets: () => AssetFiles = bundledAssetFiles,
  self: () => ViewerSelf = () => ({ name: '', sleeping: false })) {
  const io = new Server(server, {
    path: '/api/viewer/socket', serveClient: false, maxHttpBufferSize: 1024,
    allowRequest: (request, accept) => {
      const origin = request.headers.origin
      accept(null, !origin || origin === 'http://' + request.headers.host || origin === 'https://' + request.headers.host)
    }
  })
  let worker: Worker | null = null
  let nextId = 0
  let cache = new WeakMap<WorldColumn, { sections: Array<[number, object]>; chunk: string }>()
  const pending = new Map<number, { resolve: (value: string) => void; reject: (error: Error) => void }>()
  const stopWorker = () => {
    if (worker) void worker.terminate()
    worker = null
    for (const request of pending.values()) request.reject(new Error('Viewer stopped'))
    pending.clear()
    cache = new WeakMap()
  }
  const convert = (column: WorldColumn, sections: Array<[number, object]>) => new Promise<string>((resolve, reject) => {
    if (!worker) {
      worker = new Worker(path.join(__dirname, 'viewer-worker.js'))
      const current = worker
      worker.unref()
      worker.on('message', ({ id, chunk, error }) => {
        const request = pending.get(id)
        pending.delete(id)
        if (error) request?.reject(new Error(error))
        else request?.resolve(chunk)
      })
      worker.on('error', () => { if (worker === current) stopWorker() })
      worker.on('exit', () => { if (worker === current) stopWorker() })
    }
    const id = ++nextId
    pending.set(id, { resolve, reject })
    worker.postMessage({ id, version: world.blockVersion, assets: assets(), x: column.x, z: column.z, sections })
  })
  io.on('connection', socket => {
    if (io.engine.clientsCount > 4) { socket.disconnect(true); return }
    const sent = new Map<string, string>()
    let session = -1
    let busy = false
    let awaiting = false
    let ackTimer: ReturnType<typeof setTimeout> | null = null
    let closed = false
    const send = async () => {
      if (busy || closed) return
      busy = true
      try {
        if (session !== world.worldSession) {
          session = world.worldSession
          sent.clear()
          socket.emit('reset', { session, version: VIEWER_VERSION, radius: world.radius })
        }
        const generation = session
        // Entities ride in the same volatile packet: a second volatile emit right after this one would be
        // dropped while the transport is still writing. Player positions are eye heights like the bot's.
        socket.volatile.emit('position', { ...viewerPose(world.position, world.yaw, world.pitch), session, status: world.status, coverage: world.coverage(),
          self: self(), players: [...world.players].map(([id, player]) =>
            ({ id, name: player.name, ...viewerPose({ ...player.position }, player.yaw ?? 0, player.pitch ?? 0) })) })
        if (awaiting) return
        for (const key of sent.keys()) if (!world.chunks.has(key)) {
          const [x, z] = key.split(':').map(Number)
          socket.emit('unloadChunk', { x: x * 16, z: z * 16, session })
          sent.delete(key)
        }
        if (!world.coverage().ready) return
        const p = world.position
        const columns = [...world.chunks.entries()].sort(([, a], [, b]) => !p ? 0 :
          (a.x * 16 - p.x) ** 2 + (a.z * 16 - p.z) ** 2 - (b.x * 16 - p.x) ** 2 - (b.z * 16 - p.z) ** 2)
        for (const [key, column] of columns) {
          const cancelled = () => closed || generation !== world.worldSession || world.chunks.get(key) !== column
          let entry = cache.get(column)
          if (!entry || entry.sections.length !== column.sections.size || entry.sections.some(([y, section]) => column.sections.get(y) !== section)) {
            const sections = [...column.sections]
            const chunk = await convert(column, sections)
            if (cancelled()) return
            entry = { sections, chunk }
            cache.set(column, entry)
          }
          if (sent.get(key) === entry.chunk) continue
          if (cancelled()) return
          sent.set(key, entry.chunk)
          awaiting = true
          ackTimer = setTimeout(() => socket.disconnect(true), 15000)
          socket.emit('loadChunk', { x: column.x * 16, z: column.z * 16, chunk: entry.chunk, session }, () => {
            if (ackTimer) clearTimeout(ackTimer)
            ackTimer = null
            awaiting = false
          })
          break // One acknowledged column at a time bounds slow-client buffering.
        }
      } catch (error) {
        if (!closed) {
          socket.emit('viewerError', error instanceof Error ? error.message : '3D stream failed')
          socket.disconnect(true)
        }
      } finally { busy = false }
    }
    const timer = setInterval(() => { void send() }, 100)
    timer.unref()
    socket.once('disconnect', () => {
      closed = true
      clearInterval(timer)
      if (ackTimer) clearTimeout(ackTimer)
      sent.clear()
      if (io.of('/').sockets.size === 0) stopWorker()
    })
    void send()
  })
  return () => { io.disconnectSockets(true); stopWorker(); void io.close() }
}
