const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const { createServer } = require('node:http')
const { once, EventEmitter } = require('node:events')
const req = createRequire(require.resolve('bedrock-protocol'))
const JWT = req('jsonwebtoken')
const { attachIdentity } = req('nethernet/src/identity')
const { getWebRTC } = req('nethernet/src/webrtc')
const { Connection } = req('nethernet/src/connection')
const { HttpNethernetClient } = require('bedrock-protocol/src/nethernet/http')
const { verifyServerIdentity } = require('bedrock-protocol/src/nethernet/httpIdentity')
const { createClient } = require('bedrock-protocol')

test('explicit ICE override changes only UDP candidate addresses, preserving ports and fingerprints', () => {
  const { rewriteIceHost } = require('bedrock-protocol/src/nethernet/http')
  const sdp = 'v=0\r\na=fingerprint:sha-256 AA:BB\r\na=candidate:1 1 udp 100 172.18.0.2 19132 typ host\r\na=candidate:2 1 tcp 90 172.18.0.2 1234 typ host\r\n'
  assert.equal(rewriteIceHost(sdp), sdp)
  const rewritten = rewriteIceHost(sdp, '192.0.2.10')
  assert.match(rewritten, /192\.0\.2\.10 19132 typ host/)
  assert.match(rewritten, /tcp 90 172\.18\.0\.2 1234 typ host/)
  assert.match(rewritten, /a=fingerprint:sha-256 AA:BB/)
  assert.throws(() => rewriteIceHost(sdp, 'not-an-ip'), /IP address/)
})

function identity () {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' })
  const token = JWT.sign({ cpk: publicKey.export({ format: 'jwk' }) }, privateKey, { algorithm: 'ES384', expiresIn: 3600 })
  return { privateKey, token }
}
function temp (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-bot-nethernet-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return name => path.join(dir, name)
}

test('server identity verifies signatures, rejects changed fingerprints and pins operator keys', t => {
  const pin = temp(t)('server-key')
  const sdp = 'v=0\r\na=fingerprint:sha-256 AA:BB:CC\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n'
  const server = identity()
  const signed = attachIdentity(sdp, server)
  assert.match(verifyServerIdentity(signed, pin), /^[a-f0-9]{64}$/)
  assert.doesNotThrow(() => verifyServerIdentity(signed, pin))
  assert.throws(() => verifyServerIdentity(signed.replace('AA:BB:CC', 'AA:BB:CD'), pin), /signature/)
  assert.throws(() => verifyServerIdentity(attachIdentity(sdp, identity()), pin), /key changed/)
  assert.throws(() => verifyServerIdentity(sdp, pin), /identity assertion/)
  const expired = { privateKey: server.privateKey, token: JWT.sign({ cpk: crypto.createPublicKey(server.privateKey).export({ format: 'jwk' }) }, server.privateKey, { algorithm: 'ES384', expiresIn: -1 }) }
  assert.throws(() => verifyServerIdentity(attachIdentity(sdp, expired), pin), /expired/)
})

test('HTTP NetherNet gathers ICE, signs its offer, checks the answer and exchanges fragmented data', { timeout: 20000 }, async t => {
  const file = temp(t)
  const { RTCPeerConnection } = getWebRTC('werift')
  const peer = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle', iceUseIpv6: false })
  let transport
  const received = []
  let resolveReceived
  const serverReceived = new Promise(resolve => { resolveReceived = resolve })
  const emitter = new EventEmitter()
  const serverConnection = new Connection(emitter, 'test', peer)
  emitter.on('encapsulated', data => { received.push(data); resolveReceived(data) })
  peer.ondatachannel = event => {
    const channel = event.channel
    channel.binaryType = 'arraybuffer'
    if (channel.label === 'ReliableDataChannel') {
      serverConnection.setChannels(channel, null)
      const opened = channel.onopen
      channel.onopen = () => {
        opened?.()
        channel.send(Buffer.from([1, 65, 66]))
        channel.send(Buffer.from([0, 67, 68]))
      }
    } else {
      assert.equal(channel.label, 'UnreliableDataChannel')
      assert.equal(channel.ordered, false)
      assert.equal(channel.maxRetransmits, 0)
    }
  }
  const signingIdentity = identity()
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET') {
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify({ protocol: 2225, version: '1.26.65' }))
        return
      }
      assert.match(request.url, /^\/v1\/join\/\d+$/)
      assert.equal(request.headers['content-type'], 'application/sdp')
      let body = ''
      for await (const chunk of request) body += chunk
      assert.match(body, /a=candidate:/)
      verifyServerIdentity(body, file('client-key'))
      await peer.setRemoteDescription({ type: 'offer', sdp: body.replace(/^a=identity:.*\r?\n/gm, '') })
      await peer.setLocalDescription(await peer.createAnswer())
      response.setHeader('Content-Type', 'application/sdp')
      // Simulate a server advertising an unreachable Docker-private address.
      const advertised = peer.localDescription.sdp.replace(/^(a=candidate:\S+ \S+ udp \S+) \S+/gm, '$1 172.18.0.2')
      response.end(attachIdentity(advertised, signingIdentity))
    } catch (error) {
      response.writeHead(500)
      response.end(error.message)
    }
  })
  t.after(async () => {
    transport?.close()
    await peer.close()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const options = { host: '127.0.0.1', port: server.address().port, connectTimeout: 10000, nethernet: { webrtcBackend: 'werift', serverKeyPath: file('server-key'), iceHost: '127.0.0.1' } }
  assert.equal((await HttpNethernetClient.ping(options)).protocol, 2225)
  transport = new HttpNethernetClient(options)
  transport.nethernet.identity = identity()
  const connected = new Promise((resolve, reject) => { transport.onConnected = resolve; transport.onError = reject })
  const reply = new Promise((resolve, reject) => { transport.onEncapsulated = value => resolve(value.buffer); transport.onError = reject })
  await transport.connect()
  await connected
  const payload = Buffer.alloc(20001, 42)
  transport.sendReliable(payload)
  assert.deepEqual(await serverReceived, payload)
  assert.equal((await reply).toString(), 'ABCD')
  transport.close()
  transport.close()
  assert.equal(transport.connected, false)
})

test('public HTTP client rejects protocol mismatches without loading native RakNet', { timeout: 5000 }, async t => {
  const server = createServer((request, response) => response.end(JSON.stringify({ protocol: 999999, version: 'future' })))
  t.after(() => { server.closeAllConnections(); server.close() })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const client = createClient({ host: '127.0.0.1', port: server.address().port, username: 'Test', offline: true, version: '1.26.60', transport: 'nethernet', nethernet: { signalling: 'http', serverKeyPath: temp(t)('pin') }, conLog: null })
  const [error] = await once(client, 'error')
  assert.match(error.message, /does not match/)
  assert.equal(Object.keys(require.cache).some(name => /raknet-native.*binding/.test(name)), false)
})

test('closing during HTTP metadata lookup cancels setup without a later error or connection', { timeout: 5000 }, async t => {
  let arrived
  const requestArrived = new Promise(resolve => { arrived = resolve })
  const server = createServer(() => arrived())
  t.after(() => { server.closeAllConnections(); server.close() })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const client = createClient({ host: '127.0.0.1', port: server.address().port, username: 'Test', offline: true, version: '1.26.60', transport: 'nethernet', nethernet: { signalling: 'http', serverKeyPath: temp(t)('pin') }, conLog: null })
  let errors = 0
  client.on('error', () => { errors++ })
  await requestArrived
  const closed = once(client, 'close')
  client.close()
  await closed
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(errors, 0)
  assert.equal(client.connection, undefined)
})
