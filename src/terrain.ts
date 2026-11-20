export type Box = readonly [number, number, number, number, number, number]
export type Feet = { x: number; y: number; z: number }
export type CollisionCell = { boxes: readonly Box[]; support: boolean }
type Obstacle = { box: Box; support: boolean }
export type Motion = { position: Feet; onGround: boolean; velocityY: number; dx: number; dz: number }
export const STEP_HEIGHT = .5625
export const MAX_DROP = 1
export const JUMP_SPEED = .42
const EPS = 1e-4
const playerBox = (p: Feet): Box => [p.x - .3, p.y, p.z - .3, p.x + .3, p.y + 1.8, p.z + .3]
const overlap = (a: Box, b: Box, axis: number) => a[axis + 3] > b[axis] + EPS && a[axis] < b[axis + 3] - EPS
const collides = (a: Box, b: Box) => [0, 1, 2].every(axis => overlap(a, b, axis))

export class Terrain {
  constructor (private read: (x: number, y: number, z: number) => CollisionCell | null) {}

  private collect (area: Box): Obstacle[] | null {
    const result: Obstacle[] = []
    for (let x = Math.floor(area[0] + EPS); x <= Math.floor(area[3] - EPS); x++) {
      for (let y = Math.floor(area[1]); y <= Math.floor(area[4] - EPS); y++) {
        for (let z = Math.floor(area[2] + EPS); z <= Math.floor(area[5] - EPS); z++) {
          const cell = this.read(x, y, z)
          if (!cell) return null
          for (const b of cell.boxes) result.push({ support: cell.support, box: [x + b[0], y + b[1], z + b[2], x + b[3], y + b[4], z + b[5]] })
        }
      }
    }
    return result
  }

  canStandAt (x: number, z: number, y: number) {
    if (![x, y, z].every(Number.isFinite)) return false
    const box = playerBox({ x, y, z })
    const obstacles = this.collect([box[0], y - EPS, box[2], box[3], box[4], box[5]])
    return obstacles !== null && !obstacles.some(o => collides(box, o.box)) &&
      obstacles.some(o => o.support && Math.abs(o.box[4] - y) <= EPS && overlap(box, o.box, 0) && overlap(box, o.box, 2))
  }

  surfaceAt (x: number, z: number, maxY: number, minY: number): number | null {
    const candidates = new Set<number>()
    // Unknown blocks below a known surface do not invalidate that surface; canStandAt checks its actual body volume.
    for (let bx = Math.floor(x - .3 + EPS); bx <= Math.floor(x + .3 - EPS); bx++) {
      for (let bz = Math.floor(z - .3 + EPS); bz <= Math.floor(z + .3 - EPS); bz++) {
        for (let by = Math.ceil(minY) - 1; by <= Math.floor(maxY); by++) {
          const cell = this.read(bx, by, bz)
          if (!cell?.support) continue
          for (const b of cell.boxes) {
            const top = by + b[4]
            if (top >= minY - EPS && top <= maxY + EPS && x + .3 > bx + b[0] + EPS && x - .3 < bx + b[3] - EPS &&
              z + .3 > bz + b[2] + EPS && z - .3 < bz + b[5] - EPS) candidates.add(top)
          }
        }
      }
    }
    for (const y of [...candidates].sort((a, b) => b - a)) if (this.canStandAt(x, z, y)) return y
    return null
  }

  // True when walking from feet height y into block column (bx, bz) could drop the player by about one block or more,
  // or into unknown data. Walls and step-ups at body height are not drop hazards.
  dropHazard (bx: number, bz: number, y: number) {
    const foot = Math.floor(y + EPS)
    const body = this.read(bx, foot, bz)
    if (!body) return true
    if (body.boxes.some(b => foot + b[4] > y + EPS)) return false
    for (let by = foot; by >= Math.floor(y - STEP_HEIGHT); by--) {
      const cell = this.read(bx, by, bz)
      if (!cell) return true
      if (cell.support && cell.boxes.some(b => by + b[4] >= y - STEP_HEIGHT - EPS && by + b[4] <= y + EPS)) return false
    }
    return true
  }

  isKnownAt (x: number, z: number, y: number) {
    const box = playerBox({ x, y, z })
    return this.collect([box[0], y - EPS, box[2], box[3], box[4], box[5]]) !== null
  }

  private clip (obstacles: Obstacle[], p: Feet, amount: number, axis: number) {
    const a = playerBox(p)
    for (const { box: b } of obstacles) {
      if ([0, 1, 2].some(other => other !== axis && !overlap(a, b, other))) continue
      if (amount > 0 && a[axis + 3] <= b[axis] + EPS) amount = Math.min(amount, Math.max(0, b[axis] - a[axis + 3]))
      if (amount < 0 && a[axis] >= b[axis + 3] - EPS) amount = Math.max(amount, Math.min(0, b[axis + 3] - a[axis]))
    }
    return amount
  }

  move (from: Feet, dx: number, dz: number, velocityY: number, onGround: boolean, fallFrom: number): Motion | null {
    if (![from.x, from.y, from.z, dx, dz, velocityY, fallFrom].every(Number.isFinite) || Math.hypot(dx, dz) > .15 || velocityY > JUMP_SPEED + EPS || velocityY < -1) return null
    const a = playerBox(from)
    const obstacles = this.collect([a[0] + Math.min(0, dx), from.y + velocityY - EPS, a[2] + Math.min(0, dz),
      a[3] + Math.max(0, dx), a[4] + Math.max(velocityY, onGround ? STEP_HEIGHT : 0), a[5] + Math.max(0, dz)])
    if (!obstacles) return null
    const y = this.clip(obstacles, from, velocityY, 1)
    let p = { ...from, y: from.y + y }
    const x = this.clip(obstacles, p, dx, 0); p.x += x
    const z = this.clip(obstacles, p, dz, 2); p.z += z
    let grounded = velocityY < 0 && y > velocityY + EPS
    if (onGround && (Math.abs(x - dx) > EPS || Math.abs(z - dz) > EPS)) {
      const up = this.clip(obstacles, from, STEP_HEIGHT, 1)
      const raised = { ...from, y: from.y + up }
      raised.x += this.clip(obstacles, raised, dx, 0)
      raised.z += this.clip(obstacles, raised, dz, 2)
      raised.y += this.clip(obstacles, raised, -up, 1)
      if ((raised.x - from.x) ** 2 + (raised.z - from.z) ** 2 > x * x + z * z + EPS ** 2 &&
          raised.y > from.y + EPS && raised.y <= from.y + STEP_HEIGHT + EPS && this.canStandAt(raised.x, raised.z, raised.y)) {
        p = raised; grounded = true
      }
    }
    if (p.y < fallFrom - MAX_DROP - EPS || obstacles.some(o => collides(playerBox(p), o.box))) return null
    if (!this.canStandAt(p.x, p.z, p.y) && this.surfaceAt(p.x, p.z, p.y + EPS, fallFrom - MAX_DROP) === null) return null
    const clippedY = Math.abs(y - velocityY) > EPS
    return { position: p, onGround: grounded, velocityY: grounded || clippedY ? -.0784 : (velocityY - .08) * .98, dx: p.x - from.x, dz: p.z - from.z }
  }

  jumpTransition (from: Feet, x: number, z: number): Feet | null {
    const targetY = this.surfaceAt(x, z, from.y + 1, from.y + STEP_HEIGHT + EPS)
    if (targetY === null || Math.hypot(x - from.x, z - from.z) > 1.5 || !this.canStandAt(from.x, from.z, from.y)) return null
    let p = { ...from }; let onGround = false; let vy = JUMP_SPEED
    for (let i = 0; i < 50; i++) {
      const d = Math.hypot(x - p.x, z - p.z)
      if (d < EPS && onGround) return Math.abs(p.y - targetY) < EPS ? p : null
      const scale = d > EPS ? Math.min(.03, d) / d : 0
      const next = this.move(p, (x - p.x) * scale, (z - p.z) * scale, vy, onGround, from.y)
      if (!next || next.position.y > from.y + 1.26 || (next.onGround && next.position.y < targetY - EPS)) return null
      p = next.position; onGround = next.onGround; vy = next.velocityY
    }
    return null
  }

  transition (from: Feet, x: number, z: number): Feet | null {
    if (Math.hypot(x - from.x, z - from.z) > 1.5 || !this.canStandAt(from.x, from.z, from.y)) return null
    let p = { ...from }; let onGround = true; let vy = -.0784; let fallFrom = from.y
    for (let i = 0; i < 40; i++) {
      const d = Math.hypot(x - p.x, z - p.z)
      if (d < EPS && onGround && this.canStandAt(p.x, p.z, p.y)) return p
      const scale = d > EPS ? Math.min(.1, d) / d : 0
      const next = this.move(p, (x - p.x) * scale, (z - p.z) * scale, vy, onGround, fallFrom)
      if (!next || next.position.y < from.y - MAX_DROP - EPS) return null
      if (d > EPS && Math.hypot(x - next.position.x, z - next.position.z) >= d - EPS && next.onGround) return null
      p = next.position; onGround = next.onGround; vy = next.velocityY
      if (onGround) fallFrom = p.y
    }
    return null
  }
}
