import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { WorldError, type CropKind } from './world.js'

export const FARM_GROUPS = ['field', 'blocks', 'cane', 'cocoa', 'berries'] as const
export type FarmGroup = typeof FARM_GROUPS[number]
export type FarmGroups = Record<FarmGroup, boolean>
export const DEFAULT_FARM_GROUPS: FarmGroups = { field: true, blocks: false, cane: false, cocoa: false, berries: false }
export const CROP_GROUP: Record<CropKind, FarmGroup> = {
  wheat: 'field', carrots: 'field', potatoes: 'field', beetroot: 'field',
  melon_block: 'blocks', pumpkin: 'blocks', reeds: 'cane', cocoa: 'cocoa', sweet_berry_bush: 'berries'
}

function validate (input: unknown): asserts input is FarmGroups {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
    Object.keys(input).length !== FARM_GROUPS.length || FARM_GROUPS.some(key => typeof (input as FarmGroups)[key] !== 'boolean')) {
    throw new WorldError('Provide boolean field, blocks, cane, cocoa and berries settings')
  }
}

/** Small shared preferences file; commit on disk before publishing the new selection. */
export class FarmSettings {
  groups = { ...DEFAULT_FARM_GROUPS }

  constructor (private file?: string) {
    if (!file) return
    try {
      const saved: unknown = JSON.parse(readFileSync(file, 'utf8'))
      validate(saved)
      this.groups = { ...saved }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  update (input: unknown) {
    validate(input)
    if (this.file) {
      mkdirSync(path.dirname(this.file), { recursive: true })
      const temporary = this.file + '.' + randomUUID() + '.tmp'
      writeFileSync(temporary, JSON.stringify(input), 'utf8')
      renameSync(temporary, this.file)
    }
    this.groups = { ...input }
  }
}
