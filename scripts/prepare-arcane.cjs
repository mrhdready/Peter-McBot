const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const target = path.join(root, 'deploy/arcane')
const host = process.env.BEDROCK_HOST
if (!host) throw new Error('BEDROCK_HOST is required; load config/arcane.env with node --env-file')
const mapWorldId = process.env.MAP_WORLD_ID || 'default'
if (!/^[a-zA-Z0-9_-]{1,80}$/.test(mapWorldId)) throw new Error('Invalid MAP_WORLD_ID')
const botName = process.env.BOT_NAME || 'MCBot'
if (!/^[a-zA-Z0-9.:-]+$/.test(host)) throw new Error('Invalid BEDROCK_HOST')
if (!/^[a-zA-Z0-9_ ]{1,16}$/.test(botName)) throw new Error('Invalid BOT_NAME')
fs.mkdirSync(target, { recursive: true })
for (const name of ['Dockerfile', '.dockerignore', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'src', 'patches']) {
  fs.cpSync(path.join(root, name), path.join(target, name), { recursive: true })
}
for (const name of ['arcane-mcp.json', 'container-test.cjs']) {
  fs.copyFileSync(path.join(root, 'deploy/arcane-template', name), path.join(target, name))
}
fs.mkdirSync(path.join(target, 'test'), { recursive: true })
fs.copyFileSync(path.join(root, 'test/terrain.test.cjs'), path.join(target, 'test/terrain.test.cjs'))
fs.writeFileSync(path.join(target, 'Dockerfile.test'), fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'deploy/arcane-template/Dockerfile.test'), 'utf8'))
// Arcane accepts explicit environment strings and allocates its own host port.
const compose = {
  services: {
    bot: {
      build: '.', cpus: 0.5, mem_limit: '256m', restart: 'unless-stopped',
      ports: [3000],
      environment: {
        BEDROCK_HOST: host, BEDROCK_PORT: process.env.BEDROCK_PORT || '19132', BEDROCK_VERSION: process.env.BEDROCK_VERSION || '1.26.60',
        BEDROCK_TRANSPORT: 'nethernet', BEDROCK_ICE_HOST: process.env.BEDROCK_ICE_HOST || host,
        BOT_NAME: botName, CHUNK_RADIUS: process.env.CHUNK_RADIUS || '4', MAP_WORLD_ID: mapWorldId,
        WEB_HOST: '0.0.0.0', WEB_PORT: '3000'
      },
      volumes: [{ type: 'volume', source: 'bot-identity', target: '/app/data' }],
      healthcheck: {
        test: ['CMD', 'node', 'dist/healthcheck.js'],
        interval: '5s', timeout: '3s', retries: 12
      }
    },
    test: { build: { context: '.', dockerfile: 'Dockerfile.test' }, cpus: 0.25, mem_limit: '128m' }
  },
  volumes: { 'bot-identity': {} }
}
// JSON is a YAML subset; this avoids another parser/serializer dependency.
fs.writeFileSync(path.join(target, 'compose.yaml'), JSON.stringify(compose, null, 2) + '\n')
console.log('Arcane project prepared: deploy/arcane')
