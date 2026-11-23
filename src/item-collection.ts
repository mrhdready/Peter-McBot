import type { ItemEntity, WorldState } from './state.js'
import { shortName } from './inventory.js'
import { WorldError } from './world.js'

/** Empty means all drops; only Minecraft's namespace may be omitted. */
export function itemFilter (value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || value.length > 110 || !/^(?:[a-z0-9_.-]+:)?[a-z0-9_./-]+$/.test(value.trim().toLowerCase())) throw new WorldError('Ungültige Item-ID.', 400)
  return shortName(value.trim().toLowerCase())
}

/** Farm and collector use the same tracked drops and nearest-first pickup order. */
export function nearestDrop (state: WorldState, accepts: (id: string, item: ItemEntity) => boolean) {
  const p = state.position
  if (!p) return null
  const open = [...state.items].filter(([id, item]) => accepts(id, item))
  open.sort(([, a], [, b]) => Math.hypot(a.position.x - p.x, a.position.y - (p.y - 1.62), a.position.z - p.z) -
    Math.hypot(b.position.x - p.x, b.position.y - (p.y - 1.62), b.position.z - p.z))
  return open[0] ?? null
}

export const dropColumn = (item: ItemEntity) => ({ x: Math.floor(item.position.x), z: Math.floor(item.position.z) })
export const PICKUP_MS = 1500
