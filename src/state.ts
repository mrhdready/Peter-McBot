import { ChunkWorld } from './world.js'

export type Position = { x: number; y: number; z: number }
export type Status = 'disconnected' | 'connecting' | 'spawned' | 'reconnecting' | 'dead' | 'error'
export type Player = { name: string; position: Position }
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
  resetWorld () {
    this.position = null
    this.lastServerPosition = null
    this.positionSource = 'server'
    this.dimension = null
    this.players.clear()
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
      lastError: this.lastError,
      tick: this.tick,
      worldRevision: this.worldRevision,
      loadedChunks: coverage.loadedChunks,
      coverage
    }
  }
}
