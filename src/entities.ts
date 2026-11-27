import type { Position } from './state.js'

/**
 * A non-player, non-item entity near the bot (mobs, vehicles, knots …), keyed by runtime ID in `WorldState.entities`.
 * Angles are Bedrock degrees; width/height come from the server's bounding-box metadata when it sends them.
 * `flags` holds the set names of the `flags` metadata entry (e.g. baby, tamed, inlove); memory only.
 */
export type Entity = {
  uniqueId: string; type: string; position: Position; yaw: number; headYaw: number; pitch: number
  living: boolean; name: string; flags: Set<string>; width?: number; height?: number; scale?: number
}

type Metadata = { key: string; value: unknown }

/** move_entity_delta carries rotations as raw bytes (256 steps per turn); returns degrees in [-180, 180). */
export function byteAngle (value: number) {
  const degrees = value * 360 / 256
  return degrees >= 180 ? degrees - 360 : degrees
}

/**
 * Applies the metadata entries the viewer and later jobs use. Only the plain `flags` entry is read by name:
 * minecraft-data 3.119.0 shifts the named `flags_extended` bits (see `sleepingFlag`).
 */
export function applyMetadata (entity: Entity, entries: Metadata[]) {
  for (const { key, value } of entries) {
    if (key === 'flags' && value && typeof value === 'object') {
      entity.flags = new Set(Object.entries(value).filter(([name, set]) => name !== '_value' && set === true).map(([name]) => name))
    } else if (key === 'nametag' && typeof value === 'string') entity.name = value.replace(/§./g, '')
    else if (key === 'boundingbox_width' && typeof value === 'number' && value > 0) entity.width = value
    else if (key === 'boundingbox_height' && typeof value === 'number' && value > 0) entity.height = value
    else if (key === 'scale' && typeof value === 'number' && value > 0) entity.scale = value
  }
}

export type ViewerCategory = 'passive' | 'hostile' | 'other'
export type ViewerEntity = { category: ViewerCategory; width: number; height: number }

const FALLBACK_SIZE = 0.8
// minecraft-data 3.119.0 serves the 1.21.80 entity list for 1.26.60; these living types are missing there.
const CATEGORY_OVERRIDES: Record<string, ViewerCategory> = { trader_llama: 'passive', nautilus: 'passive' }
const VEHICLE = /^(chest_)?boat$|minecart$/

let entitiesByName: Record<string, { category?: string; width?: number | null; height?: number | null }> | null = null
const reported = new Set<string>()

/** How the 3D viewer draws an entity, or null when it is not drawn (projectiles, XP orbs, knots, frames …). */
export function viewerEntity (entity: Entity, version = '1.26.60'): ViewerEntity | null {
  entitiesByName ??= require('minecraft-data')('bedrock_' + version).entitiesByName
  const data = entitiesByName![entity.type]
  const known = data && data.category !== 'UNKNOWN' ? data.category : null
  const category: ViewerCategory = CATEGORY_OVERRIDES[entity.type] ?? (known === 'Passive mobs' ? 'passive' : known === 'Hostile mobs' ? 'hostile' : 'other')
  const drawn = known === 'Passive mobs' || known === 'Hostile mobs' || known === 'Vehicles' || VEHICLE.test(entity.type) ||
    (!known && entity.living)
  if (!drawn) return null
  if (!data && !reported.has(entity.type)) {
    reported.add(entity.type)
    console.log(`[viewer] unknown entity type minecraft:${entity.type}`)
  }
  const baby = entity.flags.has('baby')
  if (baby && !reported.has('baby:' + entity.type)) {
    reported.add('baby:' + entity.type)
    console.log(`[viewer] baby ${entity.type} bounding box ${entity.width ?? '-'}×${entity.height ?? '-'} scale ${entity.scale ?? '-'}`)
  }
  // Live: a baby chicken reports the adult bounding box (0.6×0.8), so the server's scale applies on top;
  // without one, babies are halved.
  const scale = entity.scale ?? (baby ? 0.5 : 1)
  return {
    category,
    width: (entity.width ?? data?.width ?? FALLBACK_SIZE) * scale,
    height: (entity.height ?? data?.height ?? FALLBACK_SIZE) * scale
  }
}
