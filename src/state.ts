import { ChunkWorld } from './world.js'
import { Inventory } from './inventory.js'

export type Position = { x: number; y: number; z: number }
export type Status = 'disconnected' | 'connecting' | 'spawned' | 'reconnecting' | 'dead' | 'error'
export type Player = { name: string; position: Position; uniqueId: string; uuid: string }
export type ItemEntity = { uniqueId: string; name: string; count: number; position: Position }
export type NavigationState = {
  status: 'idle' | 'planning' | 'moving' | 'stopped' | 'arrived' | 'error';
  target: { x: number; z: number } | null; feetY: number | null;
  path: Position[]; remaining: number; replans: number; corrections: number; message: string | null
}

export class WorldState extends ChunkWorld {
  status: Status = 'disconnected'
  position: Position | null = null
  positionSource: 'server' | 'predicted' = 'server'
  lastServerPosition: Position | null = null
  navigation: NavigationState = { status: 'idle', target: null, feetY: null, path: [], remaining: 0, replans: 0, corrections: 0, message: null }
  dimension: number | string | null = null
  lastError: string | null = null
  tick = 0
  // Other players the server currently reports near the bot, keyed by runtime entity ID; memory only.
  players = new Map<string, Player>()
  // All players online on the server (from player_list) except the bot, keyed by UUID; memory only.
  roster = new Map<string, string>()
  // The bot's own inventory; memory only.
  inventory = new Inventory()
  // Dropped item entities the server reports near the bot, keyed by runtime entity ID; memory only.
  items = new Map<string, ItemEntity>()
  resetWorld () {
    this.position = null
    this.lastServerPosition = null
    this.positionSource = 'server'
    this.dimension = null
    this.players.clear()
    this.roster.clear()
    this.items.clear()
    this.inventory.reset()
    this.clearChunks()
  }

  snapshot () {
    const coverage = this.coverage()
    return {
      status: this.status,
      position: this.position ? { ...this.position } : null,
      positionSource: this.positionSource,
      lastServerPosition: this.lastServerPosition ? { ...this.lastServerPosition } : null,
      navigation: { ...this.navigation, path: this.navigation.path.map(point => ({ ...point })), target: this.navigation.target ? { ...this.navigation.target } : null },
      dimension: this.dimension,
      players: [...this.players].map(([id, player]) => ({ id, name: player.name, ...player.position })),
      // A roster entry carries the position only while that player is in entity range.
      roster: [...this.roster].map(([uuid, name]) => {
        const near = [...this.players.values()].find(player => player.uuid === uuid)
        return { name, position: near ? { ...near.position } : null }
      }),
      lastError: this.lastError,
      tick: this.tick,
      worldRevision: this.worldRevision,
      loadedChunks: coverage.loadedChunks,
      coverage
    }
  }
}
