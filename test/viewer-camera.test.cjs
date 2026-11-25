const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { EventEmitter } = require('node:events')
const THREE = require('three')

async function cameraHarness (t) {
  let time = 0
  let nextFrame
  let camera
  let positionTweens = 0
  const requireViewer = createRequire(require.resolve('prismarine-viewer/viewer/lib/viewer'))
  // Use the real viewer camera methods and tween implementation with a deterministic clock.
  const tween = {}
  vm.runInNewContext(fs.readFileSync(requireViewer.resolve('@tweenjs/tween.js'), 'utf8'), {
    exports: tween, performance: { now: () => time }
  })
  const viewerModule = { exports: {} }
  vm.runInNewContext(fs.readFileSync(requireViewer.resolve('./viewer'), 'utf8'), {
    module: viewerModule,
    require: name => {
      if (name === '@tweenjs/tween.js') return tween
      if (['./worldrenderer', './entities', './primitives'].includes(name)) return {}
      return requireViewer(name)
    }
  })
  const realViewer = viewerModule.exports.Viewer.prototype
  class Viewer {
    constructor () {
      camera = this.camera = new THREE.PerspectiveCamera()
      this.world = { workers: [], material: { dispose () {} } }
      this.scene = new THREE.Scene()
    }
    resetAll () {}
    setVersion () { return true }
    setFirstPersonCamera (position, yaw, pitch) {
      if (position) positionTweens++
      return realViewer.setFirstPersonCamera.call(this, position, yaw, pitch)
    }
    update () { realViewer.update.call(this) }
  }
  class Canvas extends EventTarget {
    setAttribute () {}
    focus () {}
    setPointerCapture () {}
    remove () {}
  }
  const canvas = new Canvas()
  class Renderer {
    constructor () { this.domElement = canvas }
    setPixelRatio () {}
    setSize () {}
    render () {}
    dispose () {}
    forceContextLoss () {}
  }
  const socket = new EventEmitter()
  socket.connect = () => {}
  socket.disconnect = () => {}
  const window = new EventTarget()
  const context = vm.createContext({
    require: name => {
      if (name === 'three') return { ...THREE, WebGLRenderer: Renderer }
      if (name === 'socket.io-client') return { io: () => socket }
      if (name === 'prismarine-viewer/viewer/lib/viewer') return { Viewer }
      throw new Error('Unexpected import: ' + name)
    },
    window, AbortController, performance: { now: () => time },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    Image: class { async decode () {} },
    ResizeObserver: class { observe () {} disconnect () {} },
    requestAnimationFrame: callback => { nextFrame = callback; return 1 },
    cancelAnimationFrame: () => {}
  })
  vm.runInContext(fs.readFileSync(require.resolve('../src/ui/viewer.js'), 'utf8'), context)
  const reports = []
  const instance = await window.createBotViewer({ clientWidth: 800, clientHeight: 600, append () {} }, (...args) => reports.push(args))
  t.after(() => instance.dispose())
  socket.emit('reset', { session: 1, version: '1.21.4' })
  return {
    instance, camera, reports,
    get positionTweens () { return positionTweens },
    frame (at) { time = at; nextFrame(at) },
    pose (position, yaw = 0, pitch = 0, session = 1) {
      socket.emit('position', { position, yaw, pitch, session, status: 'spawned', coverage: { radius: 4 } })
    },
    pointer (type, x, y = 100) {
      canvas.dispatchEvent(Object.assign(new Event(type), { clientX: x, clientY: y, button: 0, pointerId: 1 }))
    }
  }
}

test('bot camera follows streamed movement and height without restarting position tweens', async t => {
  const h = await cameraHarness(t)
  h.pose({ x: 0, y: 65.62, z: 0 })
  h.instance.setMode('bot')
  h.frame(16)
  h.pose({ x: 10, y: 66.62, z: -4 }, .8, -.2)
  for (let time = 32; time <= 192; time += 16) h.frame(time)
  assert.deepEqual(h.camera.position.toArray(), [10, 66.62, -4])
  assert.equal(h.camera.rotation.y, .8)
  assert.equal(h.camera.rotation.x, -.2)
  h.pose({ x: 20, y: -10, z: 9 }, -.4, .1)
  h.frame(208)
  assert.deepEqual(h.camera.position.toArray(), [20, -10, 9])
  h.pose({ x: 999, y: 999, z: 999 }, 0, 0, 0)
  h.frame(224)
  assert.deepEqual(h.camera.position.toArray(), [20, -10, 9], 'stale-session poses cannot move the camera')
  assert.equal(h.positionTweens, 0)
  assert.equal(h.reports.some(([, failed]) => failed), false)
})

test('free camera uses the corrected horizontal drag direction and does not follow bot movement', async t => {
  const h = await cameraHarness(t)
  h.pose({ x: 1, y: 65.62, z: 2 })
  h.frame(16)
  h.pointer('pointerdown', 100)
  h.pointer('pointermove', 150)
  h.frame(32)
  assert.equal(h.camera.rotation.y, -.2, 'dragging right decreases yaw by default')
  h.pointer('pointermove', 50)
  h.frame(48)
  assert.equal(h.camera.rotation.y, .2, 'dragging left increases yaw by default')
  h.pointer('pointerup', 50)
  h.pose({ x: 20, y: 80, z: 30 })
  h.frame(64)
  assert.deepEqual(h.camera.position.toArray(), [1, 65.62, 2])
  h.instance.home()
  assert.deepEqual(h.camera.position.toArray(), [20, 80, 30])
})

test('mouse inversion switches control each axis independently without changing bot orientation', async t => {
  const h = await cameraHarness(t)
  h.pose({ x: 0, y: 65, z: 0 })
  for (const horizontal of [false, true]) for (const vertical of [false, true]) {
    h.instance.home()
    h.instance.setMouseInversion(horizontal, vertical)
    h.pointer('pointerdown', 100, 100)
    h.pointer('pointermove', 150, 150)
    h.frame(16)
    assert.equal(h.camera.rotation.y, horizontal ? .2 : -.2)
    assert.equal(h.camera.rotation.x, vertical ? .2 : -.2)
    h.pointer('pointerup', 150, 150)
  }
  h.pose({ x: 1, y: 65, z: 1 }, .5, -.3)
  h.instance.setMode('bot')
  h.frame(32)
  assert.equal(h.camera.rotation.y, .5)
  assert.equal(h.camera.rotation.x, -.3)
})

test('bot camera smooths position and look between updates and stops without overshooting', async t => {
  const h = await cameraHarness(t)
  h.pose({ x: 0, y: 65, z: 0 })
  h.instance.setMode('bot')
  h.frame(0)
  h.pose({ x: 2, y: 66, z: -1 }, .8, -.2)
  h.frame(16)
  assert.ok(h.camera.position.x > 0 && h.camera.position.x < 2)
  assert.ok(h.camera.rotation.y > 0 && h.camera.rotation.y < .8)
  const first = h.camera.position.x
  h.frame(32)
  assert.ok(h.camera.position.x > first && h.camera.position.x < 2)
  for (let time = 48; time <= 1008; time += 16) h.frame(time)
  assert.ok(Math.abs(h.camera.position.x - 2) < 1e-6)
  assert.ok(Math.abs(h.camera.position.y - 66) < 1e-6)
  assert.ok(Math.abs(h.camera.rotation.y - .8) < 1e-6)
  assert.ok(Math.abs(h.camera.rotation.x + .2) < 1e-6)
  assert.equal(h.positionTweens, 0)
})

test('bot camera smoothing is frame-rate independent and turns across the yaw boundary by the short route', async t => {
  const positions = []
  for (const fps of [30, 60, 120]) {
    const h = await cameraHarness(t)
    h.pose({ x: 0, y: 65, z: 0 }, Math.PI - .02)
    h.instance.setMode('bot')
    h.frame(0)
    h.pose({ x: 4, y: 65, z: 0 }, -Math.PI + .02)
    for (let frame = 1; frame <= fps / 5; frame++) h.frame(frame * 1000 / fps)
    positions.push(h.camera.position.x)
    assert.ok(h.camera.rotation.y > Math.PI - .02 && h.camera.rotation.y < Math.PI + .02)
  }
  assert.ok(Math.abs(positions[0] - positions[1]) < 1e-10)
  assert.ok(Math.abs(positions[1] - positions[2]) < 1e-10)
})
