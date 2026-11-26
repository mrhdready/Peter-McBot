type Cell = { emission: number; filter: number }
type Point = { x: number; y: number; z: number }

/** Inverse light propagation through known blocks. Unknown cells contribute an upper bound, never a fabricated measurement. */
export function estimateLight (position: Point, sky: number, minY: number, maxY: number, cellAt: (x: number, y: number, z: number) => Cell | null): number | null {
  const origin = { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) }
  if (origin.y < minY || origin.y > maxY || !cellAt(origin.x, origin.y, origin.z)) return null
  const columns = new Map<string, Array<number | null>>()
  const skyAt = (x: number, y: number, z: number) => {
    const key = x + ':' + z
    let column = columns.get(key)
    if (!column) {
      column = []; let value: number | null = sky
      for (let by = maxY; by >= minY; by--) {
        const cell = cellAt(x, by, z)
        value = !cell ? null : cell.filter >= 15 ? 0 : value === null ? null : Math.max(0, value - cell.filter)
        column[by - minY] = value
      }
      columns.set(key, column)
    }
    return column[y - minY] ?? null
  }
  const key = (p: Point) => p.x + ':' + p.y + ':' + p.z
  const costs = new Map<string, number>([[key(origin), 0]])
  const queue = [{ ...origin, cost: 0 }]
  let light = 0; let unknown = 0
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i]
    if (costs.get(key(p)) !== p.cost) continue
    const cell = cellAt(p.x, p.y, p.z)
    if (!cell) { unknown = Math.max(unknown, 15 - p.cost); continue }
    light = Math.max(light, cell.emission - p.cost)
    const daylight = skyAt(p.x, p.y, p.z)
    if (daylight === null) unknown = Math.max(unknown, sky - p.cost)
    else light = Math.max(light, daylight - p.cost)
    if (light === 15) return 15
    const cost = p.cost + Math.max(1, cell.filter)
    if (cost >= 15 || 15 - cost <= light) continue
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const next = { x: p.x + dx, y: p.y + dy, z: p.z + dz, cost }
      if (next.y < minY || next.y > maxY) continue
      const id = key(next)
      if ((costs.get(id) ?? Infinity) <= cost) continue
      costs.set(id, cost); queue.push(next)
    }
  }
  return unknown > light ? null : Math.max(0, light)
}
