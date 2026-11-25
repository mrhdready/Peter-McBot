import { setImmediate as yieldLoop } from 'node:timers/promises'
import type { WorldColumn } from './world.js'

export const VIEWER_VERSION = '1.21.4'
const canonical = (name: string, properties: Record<string, unknown>) => name.replace(/^minecraft:/, '') + '[' +
  Object.keys(properties).sort().map(key => key + '=' + properties[key]).join(',') + ']'

/** Both palettes are fixed: never pass a Bedrock state ID to the Java mesher. */
export class ViewerMapping {
  readonly java = require('minecraft-data')(VIEWER_VERSION)
  private Block = require('prismarine-block')(VIEWER_VERSION)
  private Chunk = require('prismarine-chunk')(VIEWER_VERSION)
  private ids: Uint32Array
  private wet: Uint32Array
  readonly fallback = this.java.blocksByName.magenta_wool.defaultState
  readonly air: number
  readonly missing: number

  constructor (version: string) {
    const bedrock = require('prismarine-registry')('bedrock_' + version)
    // minecraft-data exposes the translation table as raw data, not on its indexed API.
    const data = require('minecraft-data/data.js')
    const table = data.bedrock[version]?.blocksB2J
    if (!table) throw new Error('No Bedrock-to-Java block mapping for ' + version)
    const translations = new Map<string, string>()
    const byName = new Map<string, Array<{ properties: Record<string, string>; target: string }>>()
    const parse = (text: string) => {
      const match = /^([^[]+)\[(.*)\]$/.exec(text)
      if (!match) throw new Error('Invalid block translation: ' + text)
      return { name: match[1], properties: Object.fromEntries(match[2] ? match[2].split(',').map(p => p.split('=')) : []) }
    }
    for (const [from, to] of Object.entries(table)) {
      const block = parse(from)
      translations.set(canonical(block.name, block.properties), to as string)
      const name = block.name.replace(/^minecraft:/, '')
      if (!byName.has(name)) byName.set(name, [])
      byName.get(name)!.push({ properties: block.properties, target: to as string })
    }
    this.ids = new Uint32Array(bedrock.blockStates.length).fill(this.fallback)
    this.wet = new Uint32Array(this.ids.length)
    let missing = 0
    for (let id = 0; id < this.ids.length; id++) {
      const state = bedrock.blockStates[id]
      const properties = Object.fromEntries(Object.entries(state.states).map(([key, value]: [string, any]) => [key, value.value ?? value]))
      // New Bedrock properties can refine an older mapping (e.g. stair corners).
      const translated = translations.get(canonical(state.name, properties)) ?? byName.get(state.name)?.find(entry =>
        Object.entries(entry.properties).every(([key, value]) => String(properties[key]) === value))?.target
      if (translated) {
        const target = parse(translated)
        const name = target.name.replace(/^minecraft:/, '')
        if (name.endsWith('_stairs') && 'minecraft:corner' in properties) {
          target.properties.shape = properties['minecraft:corner'] === 'none' ? 'straight' : String(properties['minecraft:corner'])
        }
        try {
          if (this.java.blocksByName[name]) {
            const defaults = this.Block.fromStateId(this.java.blocksByName[name].defaultState, 1).getProperties()
            const block = this.Block.fromProperties(name, { ...defaults, ...target.properties }, 1)
            const actual = block.getProperties()
            if (block.name === name && Number.isInteger(block.stateId) &&
              Object.entries(target.properties).every(([key, value]) => String(actual[key]) === value)) this.ids[id] = block.stateId
          }
        } catch { /* Unrepresentable properties use the visible fallback. */ }
      }
      if (this.ids[id] === this.fallback && state.name !== 'magenta_wool') missing++
      const block = this.Block.fromStateId(this.ids[id], 1)
      const props = block.getProperties()
      this.wet[id] = 'waterlogged' in props
        ? this.Block.fromProperties(block.name, { ...props, waterlogged: true }, 1).stateId
        : this.ids[id]
    }
    this.air = bedrock.blocksByName.air.defaultState
    this.missing = missing
  }

  stateId (primary: number, secondary = this.air) {
    const base = this.ids[primary] ?? this.fallback
    const extra = this.ids[secondary] ?? this.fallback
    if (base === this.java.blocksByName.air.defaultState) return extra
    if (extra >= this.java.blocksByName.water.minStateId && extra <= this.java.blocksByName.water.maxStateId) return this.wet[primary] ?? this.fallback
    return base
  }

  async column (column: WorldColumn, cancelled: () => boolean) {
    const chunk = new this.Chunk()
    const sections = [...column.sections]
    for (const [sectionY, section] of sections) {
      if (cancelled()) return null
      if (section.data) {
        const data = section.data
        for (let x = 0; x < 16; x++) for (let y = 0; y < 16; y++) for (let z = 0; z < 16; z++) {
          const index = (x << 8) | (y << 4) | z
          const id = this.stateId(data[index], data[4096 + index])
          if (id) chunk.setBlockStateId({ x, y: sectionY * 16 + y, z }, id)
        }
      }
      await yieldLoop()
    }
    return { chunk: chunk.toJson(), sections }
  }
}

/** Bedrock yaw 0 faces +Z, Three camera yaw 0 faces -Z. Position is already eye height. */
export function viewerPose (position: { x: number; y: number; z: number } | null, yaw: number, pitch: number) {
  return { position, yaw: Math.PI - yaw * Math.PI / 180, pitch: -pitch * Math.PI / 180 }
}
