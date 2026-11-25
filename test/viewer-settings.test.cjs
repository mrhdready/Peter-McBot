const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')

function settingsPage (storage) {
  const elements = new Map()
  const element = id => {
    if (!elements.has(id)) elements.set(id, { checked: false, hidden: false, value: 'map' })
    return elements.get(id)
  }
  const applied = []
  const context = vm.createContext({
    document: { getElementById: element, querySelector: element }, AbortController,
    localStorage: storage,
    window: { createBotViewer: async () => ({
      dispose () {}, setMode () {}, setMouseInversion: (...values) => applied.push(values)
    }) }
  })
  // Exercise the actual view controls without starting unrelated map/chat subscriptions.
  const script = fs.readFileSync(require.resolve('../src/ui/app.js'), 'utf8').split('const archiveEnabled = false;')[0]
  vm.runInContext(script, context)
  return { element, applied, async open () { element('world-view').value = '3d'; await element('world-view').onchange() } }
}

test('mouse inversion switches default to off and saved selections survive a page reload', async () => {
  const saved = new Map()
  const storage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) }
  const page = settingsPage(storage)
  assert.equal(page.element('viewer-invert-x').checked, false)
  assert.equal(page.element('viewer-invert-y').checked, false)
  await page.open()
  assert.deepEqual(page.applied.at(-1), [false, false])
  page.element('viewer-invert-x').checked = true
  page.element('viewer-invert-x').onchange()
  page.element('viewer-invert-y').checked = true
  page.element('viewer-invert-y').onchange()
  assert.deepEqual(page.applied.at(-1), [true, true])
  assert.equal(saved.get('mc-bot.viewer-invert-x'), 'true')
  assert.equal(saved.get('mc-bot.viewer-invert-y'), 'true')
  const reloaded = settingsPage(storage)
  await reloaded.open()
  assert.deepEqual(reloaded.applied.at(-1), [true, true])
  reloaded.element('world-view').value = 'map'
  await reloaded.element('world-view').onchange()
  await reloaded.open()
  assert.deepEqual(reloaded.applied.at(-1), [true, true])
})

test('blocked or invalid storage keeps mouse settings usable with safe defaults', async () => {
  for (const storage of [undefined, { getItem () { throw new Error('blocked') }, setItem () { throw new Error('blocked') } },
    { getItem: () => 'invalid', setItem () {} }]) {
    const page = settingsPage(storage)
    await page.open()
    assert.deepEqual(page.applied.at(-1), [false, false])
    page.element('viewer-invert-y').checked = true
    assert.doesNotThrow(() => page.element('viewer-invert-y').onchange())
    assert.deepEqual(page.applied.at(-1), [false, true])
  }
})
