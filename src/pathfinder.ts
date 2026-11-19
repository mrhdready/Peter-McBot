import type { WorldState, Position } from './state.js'
import type { Feet } from './terrain.js'

export const EYE_HEIGHT = 1.62
export type Target = { x: number; z: number }
export type PreviewRoute = { target: Target; origin: Position; path: Feet[]; session: number; revision: number }
type Node = Feet & { g: number; f: number }
const key = (p: Feet) => p.x + ':' + p.y + ':' + p.z

class OpenSet {
  private nodes: Node[] = []
  push (node: Node) {
    let i = this.nodes.length
    this.nodes.push(node)
    while (i > 0) {
      const parent = (i - 1) >>> 1
      if (this.nodes[parent].f <= node.f) break
      this.nodes[i] = this.nodes[parent]; i = parent
    }
    this.nodes[i] = node
  }
  pop () {
    const first = this.nodes[0]; const last = this.nodes.pop()
    if (this.nodes.length && last) {
      let i = 0
      while (i * 2 + 1 < this.nodes.length) {
        let child = i * 2 + 1
        if (child + 1 < this.nodes.length && this.nodes[child + 1].f < this.nodes[child].f) child++
        if (last.f <= this.nodes[child].f) break
        this.nodes[i] = this.nodes[child]; i = child
      }
      this.nodes[i] = last
    }
    return first
  }
}

export class RoutePlanner {
  private open = new OpenSet()
  private costs = new Map<string, number>()
  private parents = new Map<string, Feet>()
  private closed = new Set<string>()

  constructor (private world: WorldState, position: Position, private target: Target) {
    if (![target.x, target.z].every(n => Number.isInteger(n) && Math.abs(n) <= 30000000)) throw new Error('X und Z müssen ganzzahlige Blockkoordinaten sein.')
    const feetY = world.terrain.surfaceAt(position.x, position.z, position.y - EYE_HEIGHT + .08, position.y - EYE_HEIGHT - .08)
    if (feetY === null) throw new Error('Startposition hat keine bekannte, sichere Standfläche mit ausreichend Freiraum.')
    if (!world.chunks.has(Math.floor(target.x / 16) + ':' + Math.floor(target.z / 16))) throw new Error('Ziel liegt außerhalb der geladenen Chunks.')
    const centre = world.terrain.transition({x:position.x, y:position.y - EYE_HEIGHT, z:position.z}, Math.floor(position.x) + .5, Math.floor(position.z) + .5)
    if (!centre) throw new Error('Die Mitte des aktuellen Blocks ist ohne Sprung nicht erreichbar.')
    const start = {x:Math.floor(position.x), y:Math.round(centre.y * 2) / 2, z:Math.floor(position.z)}
    this.open.push({...start,g:0,f:Math.abs(start.x-target.x)+Math.abs(start.z-target.z)})
    this.costs.set(key(start),0)
  }

  step (): Feet[] | null {
    const target = this.target
    const began = performance.now()
    for (let budget = 0; budget < 128 && performance.now() - began < 4; budget++) {
      const node = this.open.pop()
      if (!node) throw new Error('Kein Weg durch bekannte, sichere Blöcke gefunden.')
      const id = key(node)
      if (this.closed.has(id)) continue
      this.closed.add(id)
      if (this.closed.size > 8192) throw new Error('Suchlimit erreicht (8192 Wegpunkte).')
      if (node.x === target.x && node.z === target.z) {
        let cursor: Feet = node
        const path: Feet[] = [{ x: cursor.x + .5, y: cursor.y, z: cursor.z + .5 }]
        while (this.parents.has(key(cursor))) {
          cursor = this.parents.get(key(cursor))!
          path.push({ x: cursor.x + .5, y: cursor.y, z: cursor.z + .5 })
        }
        return path.reverse()
      }
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x = node.x + dx; const z = node.z + dz
        const from = { x: node.x + .5, y: node.y, z: node.z + .5 }
        const endpoint = this.world.terrain.transition(from, x + .5, z + .5) ?? this.world.terrain.jumpTransition(from, x + .5, z + .5)
        if (!endpoint) continue
        const next = { x, y: Math.round(endpoint.y * 2) / 2, z }; const nextId = key(next); const cost = node.g + 1
        if (this.closed.has(nextId) || (this.costs.get(nextId) ?? Infinity) <= cost) continue
        this.costs.set(nextId, cost); this.parents.set(nextId, node)
        this.open.push({ ...next, g: cost, f: cost + Math.abs(next.x - target.x) + Math.abs(next.z - target.z) })
      }
    }
    return null
  }
}
