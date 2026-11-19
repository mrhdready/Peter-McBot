import { isIP } from 'node:net'

export type Config = {
  host: string; port: number; version: string; transport: 'nethernet' | 'raknet';
  username: string; radius: number; webHost: string; webPort: number; iceHost?: string
}

export function readConfig (env: NodeJS.ProcessEnv = process.env): Config {
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const raw = env[name]
    const value = raw === undefined ? fallback : Number(raw)
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}: expected ${min}..${max}`)
    return value
  }
  const host = env.BEDROCK_HOST?.trim()
  if (!host || /[\s/]/.test(host)) throw new Error('BEDROCK_HOST must be a hostname or IP address')
  const transport = env.BEDROCK_TRANSPORT || 'nethernet'
  if (transport !== 'nethernet' && transport !== 'raknet') throw new Error('Invalid BEDROCK_TRANSPORT')
  const iceHost = env.BEDROCK_ICE_HOST?.trim() || undefined
  if (iceHost && !isIP(iceHost)) throw new Error('BEDROCK_ICE_HOST must be an IP address')
  const username = env.BOT_NAME || 'MCBot'
  if (!/^[a-zA-Z0-9_ ]{1,16}$/.test(username)) throw new Error('Invalid BOT_NAME (1..16 letters, digits, spaces or underscores)')
  return {
    host, port: integer('BEDROCK_PORT', 19132, 1, 65535),
    version: env.BEDROCK_VERSION || '1.26.60', transport, username, iceHost,
    radius: integer('CHUNK_RADIUS', 4, 4, 6),
    webHost: env.WEB_HOST || '127.0.0.1', webPort: integer('WEB_PORT', 3000, 0, 65535)
  }
}
