import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { WorldError } from './world.js'

export type SleepOptions = { enabled: boolean; onlyWithPlayers: boolean }
export class SleepSettings {
  value: SleepOptions = { enabled: false, onlyWithPlayers: false }
  constructor (private file?: string) {
    if (!file) return
    try { this.value = this.validate(JSON.parse(readFileSync(file, 'utf8'))) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  private validate (input: unknown): SleepOptions {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2 ||
      typeof (input as SleepOptions).enabled !== 'boolean' || typeof (input as SleepOptions).onlyWithPlayers !== 'boolean') throw new WorldError('Provide boolean enabled and onlyWithPlayers settings')
    return { ...(input as SleepOptions) }
  }
  update (input: unknown) {
    const value = this.validate(input)
    if (this.file) {
      mkdirSync(path.dirname(this.file), { recursive: true })
      const temporary = this.file + '.' + randomUUID() + '.tmp'
      writeFileSync(temporary, JSON.stringify(value), 'utf8'); renameSync(temporary, this.file)
    }
    this.value = value
  }
}
