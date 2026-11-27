import { isIP } from 'node:net'

export type Config = {
  host: string; port: number; version: string; transport: 'nethernet' | 'raknet';
  username: string; radius: number; webHost: string; webPort: number; iceHost?: string; mapWorldId: string
  chatCommands: boolean; openDoors: boolean; minecraftEula: boolean
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
  const mapWorldId = env.MAP_WORLD_ID?.trim() || 'default'
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(mapWorldId)) throw new Error('Invalid MAP_WORLD_ID (1..80 letters, digits, underscores or hyphens)')
  if (!/^[a-zA-Z0-9_ ]{1,16}$/.test(username)) throw new Error('Invalid BOT_NAME (1..16 letters, digits, spaces or underscores)')
  const chatCommands = env.CHAT_COMMANDS?.trim() || 'on'
  if (chatCommands !== 'on' && chatCommands !== 'off') throw new Error('Invalid CHAT_COMMANDS (on or off)')
  const openDoors = env.OPEN_DOORS?.trim() || 'on'
  if (openDoors !== 'on' && openDoors !== 'off') throw new Error('Invalid OPEN_DOORS (on or off)')
  // Accepting the Minecraft EULA allows downloading the client jar for the 3D viewer's textures.
  const minecraftEula = env.MINECRAFT_EULA?.trim().toLowerCase() || 'false'
  if (minecraftEula !== 'true' && minecraftEula !== 'false') throw new Error('Invalid MINECRAFT_EULA (true or false)')
  return {
    chatCommands: chatCommands === 'on', openDoors: openDoors === 'on', minecraftEula: minecraftEula === 'true',
    host, port: integer('BEDROCK_PORT', 19132, 1, 65535),
    version: env.BEDROCK_VERSION || '1.26.60', transport, username, iceHost, mapWorldId,
    radius: integer('CHUNK_RADIUS', 4, 4, 6),
    webHost: env.WEB_HOST || '127.0.0.1', webPort: integer('WEB_PORT', 3000, 0, 65535)
  }
}
