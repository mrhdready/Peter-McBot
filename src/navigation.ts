import type { WorldState, Position } from './state.js'
import { MAX_DROP, JUMP_SPEED, STEP_HEIGHT } from './terrain.js'

export { EYE_HEIGHT } from './pathfinder.js'
import { RoutePlanner, EYE_HEIGHT, type Target } from './pathfinder.js'
export type { Target } from './pathfinder.js'
type Send = (name: string, params: unknown) => void
const distance = (a: Target, b: Target) => Math.hypot(a.x - b.x, a.z - b.z)

export class Navigator {
  private planner: RoutePlanner | null = null
  private session = 0
  private revision = 0
  private tick = 0n
  private tickBase = 0n
  private lastCorrection = -1n
  private velocity = { x: 0, z: 0 }
  private velocityY = -.0784
  private grounded = true
  private fallFrom = 0
  private settling = false
  private neutral = false
  private inputActive = false
  private teleportPending = false
  private jumping = false
  private jumpReleased = false
  private startedAt = 0
  private progressAt = 0
  private bestDistance = Infinity
  private yaw = 0

  constructor (private world: WorldState) {}

  reset () {
    this.world.navigation.path = []; this.planner = null
    this.velocity = { x: 0, z: 0 }; this.neutral = false; this.inputActive = false; this.teleportPending = false; this.tick = 0n; this.tickBase = 0n; this.lastCorrection = -1n
    this.velocityY = -.0784; this.grounded = true; this.fallFrom = 0; this.settling = false
    this.jumping = false; this.jumpReleased = false
    this.world.navigation = { status: 'idle', target: null, feetY: null, path: [], remaining: 0, replans: 0, corrections: 0, message: null }
  }

  acknowledgeTeleport () { this.teleportPending = true }
  synchroniseTick (tick: bigint) { this.tickBase = tick - BigInt(this.world.tick); this.tick = tick }

  start (target: Target, now: number) {
    this.stop()
    this.world.navigation = { status: 'planning', target: { x: target.x, z: target.z }, feetY: null, path: [], remaining: 0, replans: 0, corrections: 0, message: null }
    const p = this.world.position
    if (this.world.status !== 'spawned' || !p) return this.fail('Bot ist nicht verbunden und gespawnt.')
    if (![target.x, target.z].every(n => Number.isInteger(n) && Math.abs(n) <= 30000000)) return this.fail('X und Z müssen ganzzahlige Blockkoordinaten sein.')
    const feetY = this.world.terrain.surfaceAt(p.x, p.z, p.y - EYE_HEIGHT + .08, p.y - EYE_HEIGHT - .08)
    if (feetY === null) return this.fail('Startposition hat keine bekannte, sichere Standfläche mit ausreichend Freiraum.')
    this.world.navigation.feetY = feetY
    this.grounded = true; this.velocityY = -.0784; this.fallFrom = feetY; this.settling = false
    if (!this.world.chunks.has(Math.floor(target.x / 16) + ':' + Math.floor(target.z / 16))) return this.fail('Ziel liegt außerhalb der geladenen Chunks.')
    this.session = this.world.worldSession
    this.startedAt = now; this.progressAt = now
    this.plan()
  }

  stop (message = 'Navigation gestoppt.') {
    const active = ['planning', 'moving'].includes(this.world.navigation.status)
    this.world.navigation.path = []; this.planner = null
    if (active) {
      this.world.navigation.status = 'stopped'; this.world.navigation.message = message
      const p = this.world.position
      const supported = p !== null && this.world.canStandAt(p.x, p.z, p.y - EYE_HEIGHT)
      this.world.navigation.remaining = 0; this.neutral = this.inputActive || !supported; this.settling = !supported
    }
    if (this.grounded) this.velocity = { x: 0, z: 0 }
  }

  private fail (message: string) {
    this.stop(message)
    this.world.navigation.status = 'error'; this.world.navigation.message = message
  }

  private plan () {
    this.world.navigation.path = []; this.world.navigation.remaining = 0
    try { this.planner = new RoutePlanner(this.world, this.world.position!, this.world.navigation.target!) }
    catch (error) { return this.fail(error instanceof Error ? error.message : String(error)) }
    this.revision = this.world.worldRevision
    this.world.navigation.status = 'planning'
  }

  private replan (message: string) {
    if (++this.world.navigation.replans > 3) return this.fail('Navigation nach wiederholten Änderungen abgebrochen: ' + message)
    this.world.navigation.message = message
    if (this.grounded) {
      this.velocity = { x: 0, z: 0 }; this.neutral = this.inputActive
      this.plan()
    } else {
      this.world.navigation.path = []; this.world.navigation.remaining = 0; this.world.navigation.status = 'planning'; this.settling = true
    }
  }

  serverCorrection (position: Position, tick?: bigint, delta?: Position, onGround?: boolean) {
    if (tick !== undefined) {
      if (tick <= this.lastCorrection) return false
      this.lastCorrection = tick
      if (tick > this.tick) this.tick = tick
    }
    this.world.position = { ...position }; this.world.lastServerPosition = { ...position }; this.world.positionSource = 'server'
    this.world.setCenter(position)
    if (['planning', 'moving'].includes(this.world.navigation.status) || this.settling) {
      this.world.navigation.corrections++
      const feet = position.y - EYE_HEIGHT
      this.grounded = this.world.canStandAt(position.x, position.z, feet) && onGround !== false
      this.velocityY = delta?.y ?? (this.grounded ? -.0784 : this.velocityY)
      this.world.navigation.feetY = feet
      if (this.grounded) this.fallFrom = feet
      const landing = this.world.terrain.surfaceAt(position.x, position.z, feet + .0001, this.fallFrom - MAX_DROP)
      if ((this.velocityY > .0001 && !this.jumping) || this.velocityY > JUMP_SPEED + .0001 || feet > this.fallFrom + 1.26 || (!this.grounded && (feet < this.fallFrom - MAX_DROP - .0001 || landing === null))) {
        this.fail('Serverkorrektur verlässt den sicheren Bereich; Navigation gestoppt.')
        this.settling = false; this.neutral = false
      } else if (['planning', 'moving'].includes(this.world.navigation.status)) this.replan('Serverkorrektur übernommen; Weg wird neu geplant.')
    }
    return true
  }

  private move (send: Send, dx: number, dz: number, input: number, jump = false) {
    const p = this.world.position!
    const damping = this.grounded ? .546 : .91
    const motion = this.world.terrain.move({ x: p.x, y: p.y - EYE_HEIGHT, z: p.z }, dx, dz, jump ? JUMP_SPEED : this.velocityY, jump ? false : this.grounded, this.fallFrom)
    if (!motion || (input > 0 && Math.hypot(dx, dz) > .001 && Math.hypot(motion.dx, motion.dz) < .0001 && motion.onGround)) return false
    this.velocity = { x: motion.dx, z: motion.dz }; this.velocityY = motion.velocityY; this.grounded = motion.onGround
    if (jump) this.jumping = true
    if (this.grounded) { this.fallFrom = motion.position.y; this.jumping = false }
    const next = { ...motion.position, y: motion.position.y + EYE_HEIGHT }
    this.sendInput(send, next, { x: motion.dx * damping, y: motion.velocityY, z: motion.dz * damping }, input, motion.onGround, jump)
    this.world.navigation.feetY = motion.position.y
    this.world.position = next; this.world.positionSource = 'predicted'; this.world.setCenter(next)
    return true
  }

  step (send: Send, now: number) {
    if (this.teleportPending && ['planning', 'moving'].includes(this.world.navigation.status) && this.world.position) {
      this.sendInput(send, this.world.position, { x: 0, y: -.0784, z: 0 }, 0, true)
      return
    }
    if ((this.neutral || this.settling) && this.world.position) {
      this.neutral = false
      if (this.settling) {
        if (!this.move(send, this.velocity.x * .91, this.velocity.z * .91, 0)) {
          this.fail('Keine sichere Landung innerhalb eines Blocks; manuell prüfen.')
          this.neutral = false; this.settling = false; return
        }
        if (this.grounded && this.world.canStandAt(this.world.position.x, this.world.position.z, this.world.position.y - EYE_HEIGHT)) {
          this.settling = false; this.velocity = { x: 0, z: 0 }
          if (this.world.navigation.status === 'planning') this.plan()
        }
      } else this.sendInput(send, this.world.position, { x: 0, y: -.0784, z: 0 }, 0, true)
      return
    }
    const nav = this.world.navigation; const p = this.world.position
    if (!['planning', 'moving'].includes(nav.status) || !p) return
    if (this.world.worldSession !== this.session) return this.fail('Weltsitzung geändert; Navigation gestoppt.')
    if (now - this.startedAt > 120000) return this.fail('Zeitlimit der Navigation erreicht (120 Sekunden).')
    if (nav.status === 'planning') {
      try {
        const path = this.planner!.step()
        if (!path) return
        if (this.world.worldRevision !== this.revision && path.some(p => !this.world.canStandAt(p.x, p.z, p.y))) return this.replan('Weg während der Suche blockiert.')
        nav.path = path; nav.remaining = path.length; nav.status = 'moving'; this.planner = null
        this.bestDistance = Infinity; this.progressAt = now
      } catch (error) { this.fail(error instanceof Error ? error.message : String(error)) }
      return
    }
    const waypoint = this.world.navigation.path[0]
    if (!waypoint) return
    if (!this.world.canStandAt(p.x, p.z, p.y - EYE_HEIGHT) && this.world.terrain.surfaceAt(p.x, p.z, p.y - EYE_HEIGHT + .0001, this.fallFrom - MAX_DROP) === null) return this.fail('Aktuelle Position ist nicht mehr sicher begehbar; Navigation gestoppt.')
    if (!this.world.canStandAt(waypoint.x, waypoint.z, waypoint.y)) return this.replan('Weg blockiert oder Weltdaten nicht mehr verfügbar.')
    const d = distance(p, waypoint)
    if (d < .08 && this.grounded && Math.abs(p.y - EYE_HEIGHT - waypoint.y) < .08) {
      this.world.navigation.path.shift(); nav.remaining = this.world.navigation.path.length
      this.bestDistance = Infinity; this.progressAt = now
      if (!this.world.navigation.path.length) {
        this.stop('Ziel laut Client-Prognose erreicht.'); nav.status = 'arrived'
      }
      return
    }
    const remaining = d + Math.abs(p.y - EYE_HEIGHT - waypoint.y)
    if (remaining < this.bestDistance - .025) { this.bestDistance = remaining; this.progressAt = now }
    if (now - this.progressAt > 5000) return this.fail('Kein ausreichender Fortschritt; Navigation gestoppt.')
    const speed = Math.min(.06, d * .35)
    const damping = this.grounded ? .546 : .91
    const factor = this.grounded ? .098 : .0196
    let ax = (d > .0001 ? (waypoint.x - p.x) / d * speed : 0) - this.velocity.x * damping
    let az = (d > .0001 ? (waypoint.z - p.z) / d * speed : 0) - this.velocity.z * damping
    const acceleration = Math.hypot(ax, az)
    if (acceleration > factor * .3) { ax *= factor * .3 / acceleration; az *= factor * .3 / acceleration }
    const velocity = { x: this.velocity.x * damping + ax, z: this.velocity.z * damping + az }
    this.yaw = Math.atan2(-ax, az) * 180 / Math.PI
    const needsJump = this.grounded && d <= 1.01 && waypoint.y > p.y - EYE_HEIGHT + STEP_HEIGHT + .0001 &&
      this.world.terrain.transition({ x: p.x, y: p.y - EYE_HEIGHT, z: p.z }, waypoint.x, waypoint.z) === null
    if (needsJump && !this.world.terrain.jumpTransition({ x: p.x, y: p.y - EYE_HEIGHT, z: p.z }, waypoint.x, waypoint.z)) return this.replan('Sprungbahn oder Landefläche ist nicht mehr frei.')
    if (!this.move(send, velocity.x, velocity.z, Math.hypot(ax, az) / factor, needsJump)) this.replan('Nächster Schritt oder Landebereich ist nicht sicher begehbar.')
  }

  private sendInput (send: Send, position: Position, velocity: Position, input: number, grounded: boolean, jump = false) {
    this.inputActive = input > 0
    const yaw = this.yaw * Math.PI / 180
    // A jump is a one-tick press; release on the next input prevents repeated jumps.
    const flags: string[] = jump ? ['jump_down', 'jumping'] : []
    if (input > 0) flags.push('up')
    if (jump) flags.push('start_jumping')
    if (this.teleportPending) { flags.push('handled_teleport'); this.teleportPending = false }
    if (grounded) flags.push('vertical_collision')
    if (!jump && this.jumpReleased) flags.push('jump_released_raw')
    if (jump) flags.push('jump_pressed_raw', 'jump_current_raw')
    this.jumpReleased = jump
    const clockTick = this.tickBase + BigInt(this.world.tick)
    this.tick = clockTick > this.tick ? clockTick : this.tick + 1n
    send('player_auth_input', {
      pitch: 0, yaw: this.yaw, head_yaw: this.yaw, position: { ...position },
      move_vector: { x: 0, z: input }, analogue_move_vector: { x: 0, z: input }, raw_move_vector: { x: 0, z: input },
      input_data: flags,
      input_mode: 'game_pad', play_mode: 'normal', interaction_model: 'crosshair', interact_rotation: { x: 0, z: this.yaw },
      tick: this.tick, delta: { ...velocity },
      transaction: undefined, item_stack_request: undefined, block_action: undefined, vehicle_rotation: undefined, predicted_vehicle: undefined,
      camera_orientation: { x: -Math.sin(yaw), y: 0, z: Math.cos(yaw) }
    })
  }
}
