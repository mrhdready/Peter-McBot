import { parentPort } from 'node:worker_threads'

const port = parentPort!
let registry: any
let Chunk: any
port.on('message', async message => {
  try {
    if (message.type === 'init') {
      registry = require('prismarine-registry')('bedrock_' + message.version)
      registry.handleStartGame({ itemstates: [], block_network_ids_are_hashes: message.hashed })
      Chunk = require('prismarine-chunk')(registry)
      const runtimePairs = Uint32Array.from(Object.entries(registry.blocksByRuntimeId).flatMap(([id, block]: [string, any]) => [Number(id) >>> 0, block.stateId]))
      const blocks = Object.fromEntries(Object.entries(registry.blocksByName).map(([name, block]: [string, any]) => ['minecraft:' + name, { min: block.minStateId, max: block.maxStateId }]))
      const walkFlags = new Uint8Array(registry.blockStates.length)
      const collisionIds = new Int32Array(registry.blockStates.length).fill(-1)
      for (const block of Object.values(registry.blocksByName) as any[]) {
        if (/water|lava|fire|magma|cactus|campfire|berry|powder_snow|web|portal|bubble_column|wither_rose|soul_sand|soul_soil|ice|slime|honey/.test(block.name)) continue
        const shapes = registry.blockCollisionShapes
        const ids = shapes?.blocks[block.name]
        for (let id = block.minStateId; id <= block.maxStateId; id++) {
          const boxes = shapes?.shapes[Array.isArray(ids) ? ids[id - block.minStateId] : ids]
          if (!boxes) continue
          collisionIds[id] = Array.isArray(ids) ? ids[id - block.minStateId] : ids
          if (boxes.length === 0) walkFlags[id] = 1
          else if (boxes.length === 1 && boxes[0].every((v: number, i: number) => v === (i < 3 ? 0 : 1))) walkFlags[id] = 2
          else if (/(?:_slab|_stairs)$/.test(block.name)) walkFlags[id] = 2
        }
      }
      port.postMessage({ type: 'ready', blocks, air: registry.blocksByName.air.defaultState, runtimePairs, walkFlags, collisionIds, collisionShapes: registry.blockCollisionShapes.shapes }, [runtimePairs.buffer, walkFlags.buffer, collisionIds.buffer])
      return
    }
    const payload = Buffer.from(message.payload)
    if (!registry || payload.length < 3 || ![8, 9].includes(payload[0])) throw new Error('Unsupported or incomplete subchunk payload')
    if (payload[0] === 9 && payload.readInt8(2) !== message.y) throw new Error('Subchunk payload Y does not match its response')
    const column = new Chunk({ x: 0, z: 0 })
    await column.networkDecodeSubChunkNoCache(message.y, payload)
    const data = new Uint32Array(8192)
    for (let l = 0; l < 2; l++) for (let i = 0; i < 4096; i++) {
      data[l * 4096 + i] = column.getBlockStateId({ x: i >>> 8, y: message.y * 16 + ((i >>> 4) & 15), z: i & 15, l })
    }
    port.postMessage({ type: 'decoded', id: message.id, data }, [data.buffer])
  } catch (error) {
    port.postMessage({ type: 'error', id: message.id, error: error instanceof Error ? error.message : String(error) })
  }
})
