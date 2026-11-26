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
      const blocks = Object.fromEntries(Object.entries(registry.blocksByName).map(([name, block]: [string, any]) => ['minecraft:' + name, { min: block.minStateId, max: block.maxStateId, emission: block.emitLight ?? 0, filter: block.filterLight ?? 15 }]))
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
          // Farmland and paths are 15/16 high; walking on them is safe (only falling tramples farmland).
          else if (/(?:_slab|_stairs)$|^(?:farmland|grass_path|bed)$/.test(block.name)) walkFlags[id] = 2
        }
      }
      // minecraft-data gives every door state the same west-side panel. Derive the vanilla panel from facing, open and hinge instead:
      // closed it lies on the face opposite its facing; open it swings to the side given by the hinge.
      const shapes: Record<number, number[][]> = { ...registry.blockCollisionShapes.shapes }
      const T = 3 / 16
      const panels: Record<string, number[][]> = {
        east: [[0, 0, 0, T, 1, 1]], west: [[1 - T, 0, 0, 1, 1, 1]], south: [[0, 0, 0, 1, 1, T]], north: [[0, 0, 1 - T, 1, 1, 1]]
      }
      const swing: Record<string, [string, string]> = { east: ['south', 'north'], south: ['west', 'east'], west: ['north', 'south'], north: ['east', 'west'] }
      const panelIds: Record<string, number> = {}
      let nextShape = Math.max(0, ...Object.keys(shapes).map(Number)) + 1
      for (const side of Object.keys(panels)) { panelIds[side] = nextShape; shapes[nextShape++] = panels[side] }
      const stateValue = (states: any, name: string) => states?.[name]?.value ?? states?.[name]
      const cropGrowth = new Int8Array(registry.blockStates.length).fill(-1)
      const cropDirection = new Int8Array(registry.blockStates.length).fill(-1)
      for (let id = 0; id < registry.blockStates.length; id++) {
        const states = registry.blockStates[id]?.states
        const growth = stateValue(states, 'growth') ?? stateValue(states, 'age')
        if (typeof growth === 'number') cropGrowth[id] = growth
        const direction = stateValue(states, 'direction')
        if (typeof direction === 'number') cropDirection[id] = direction
      }
      // 1 lower, 2 upper door half. Bedrock keeps facing and open state on the lower half; the world model resolves upper halves to it.
      const doorHalf = new Uint8Array(registry.blockStates.length)
      for (const block of Object.values(registry.blocksByName) as any[]) {
        if (!/(?:^|_)door$/.test(block.name)) continue
        for (let id = block.minStateId; id <= block.maxStateId; id++) {
          const states = registry.blockStates[id]?.states
          doorHalf[id] = Number(stateValue(states, 'upper_block_bit')) === 1 ? 2 : 1
          // Door cardinal_direction keeps the legacy door direction (0 = east) under the generic names (0 = south),
          // so it is a quarter turn off: a live door reported as "south" blocks walking along X like a vanilla east-facing door.
          const facing = ({ south: 'east', west: 'south', north: 'west', east: 'north' } as Record<string, string>)[stateValue(states, 'minecraft:cardinal_direction')]
          if (!facing) continue
          const side = Number(stateValue(states, 'open_bit')) === 1 ? swing[facing][Number(stateValue(states, 'door_hinge_bit')) === 1 ? 1 : 0] : facing
          collisionIds[id] = panelIds[side]; walkFlags[id] = 0
        }
      }
      // Hand-openable doors (all but iron) and fence gates: pair each closed state with the open state that has the same other properties.
      const doorToggle = new Int32Array(registry.blockStates.length).fill(-1)
      const doorOpen = new Uint8Array(registry.blockStates.length)
      for (const block of Object.values(registry.blocksByName) as any[]) {
        if (!/(?:^|_)door$|fence_gate$/.test(block.name) || block.name === 'iron_door') continue
        const pairs = new Map<string, [number, number]>()
        for (let id = block.minStateId; id <= block.maxStateId; id++) {
          const states = registry.blockStates[id]?.states
          if (!states || !('open_bit' in states)) continue
          const open = Number(states.open_bit?.value ?? states.open_bit) === 1
          const key = JSON.stringify(Object.entries(states).filter(([name]) => name !== 'open_bit').sort(([a], [b]) => a < b ? -1 : 1))
          const pair = pairs.get(key) ?? [-1, -1]
          pair[open ? 1 : 0] = id; pairs.set(key, pair)
        }
        for (const [closed, open] of pairs.values()) {
          if (closed < 0 || open < 0) continue
          doorToggle[closed] = open; doorToggle[open] = closed; doorOpen[open] = 1
        }
      }
      port.postMessage({ type: 'ready', blocks, air: registry.blocksByName.air.defaultState, runtimePairs, walkFlags, collisionIds, collisionShapes: shapes, doorToggle, doorOpen, doorHalf, cropGrowth, cropDirection },
        [runtimePairs.buffer, walkFlags.buffer, collisionIds.buffer, doorToggle.buffer, doorOpen.buffer, doorHalf.buffer, cropGrowth.buffer, cropDirection.buffer])
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
