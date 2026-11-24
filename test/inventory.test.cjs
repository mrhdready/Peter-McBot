const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Inventory, playerContainer } = require('../dist/inventory.js')

function setup () {
  const inventory = new Inventory()
  inventory.setRegistry([{ name: 'minecraft:wheat_seeds', runtime_id: 300 }, { name: 'minecraft:dirt', runtime_id: 302 }])
  const seed = { network_id: 300, count: 5, has_stack_id: true, stack_id: 10, metadata: 2, extra: { nbt: { value: 42n } } }
  const dirt = { network_id: 302, count: 64, has_stack_id: true, stack_id: 20, metadata: 0 }
  const slots = Array(36).fill(null)
  slots[35] = seed; slots[0] = dirt
  inventory.setContent(slots)
  const move = { name: 'minecraft:wheat_seeds', count: 5,
    from: { container: playerContainer(35), slot: 35, stackId: 10 }, to: { container: playerContainer(0), slot: 0, stackId: 20 } }
  let request
  const send = (name, packet) => { assert.equal(name, 'item_stack_request'); request = packet.requests[0] }
  const respond = (status, entries = []) => inventory.response([{ status, request_id: request.request_id,
    containers: [{ slot_type: { container_id: 12 }, slots: entries.map(([slot, count, item_stack_id]) => ({ slot, count, item_stack_id })) }] }])
  return { inventory, move, seed, dirt, send, respond, request: () => request }
}

test('swap applies both confirmed items with their metadata and accepts combined numeric container IDs', async () => {
  const { inventory, move, seed, dirt, send, respond, request } = setup()
  const pending = inventory.swap(send, move, 0)
  assert.deepEqual(request().actions[0], { type_id: 'swap', legacy_type_id: 2,
    source: { slot_type: { container_id: 'hotbar_and_inventory', dynamic_container_id: undefined }, slot: 35, stack_id: 10 },
    destination: { slot_type: { container_id: 'hotbar', dynamic_container_id: undefined }, slot: 0, stack_id: 20 } })
  assert.equal(inventory.packetItem(0).network_id, 302, 'No optimistic mutation')
  respond('ok', [[35, 64, 21], [0, 5, 11]])
  await pending
  assert.deepEqual(inventory.packetItem(0), { ...seed, stack_id: 11 })
  assert.deepEqual(inventory.packetItem(35), { ...dirt, stack_id: 21 })
})

test('a full stack moved into an empty slot retains raw metadata after the source is cleared', async () => {
  const { inventory, move, seed, send, respond } = setup()
  inventory.setSlot(0, null)
  move.to.stackId = 0
  const pending = inventory.place(send, move, 0)
  respond(0, [[35, 0, 0], [0, 5, 31]])
  await pending
  assert.deepEqual(inventory.packetItem(0), { ...seed, stack_id: 31 })
  assert.equal(inventory.slotList()[35], null)
})

test('rejected, expired and disconnected swaps preserve inventory until the server confirms', async () => {
  const { inventory, move, send, respond } = setup()
  const before = inventory.slotList()
  const rejected = inventory.swap(send, move, 0)
  respond('error')
  assert.equal((await rejected).status, 'error')
  assert.deepEqual(inventory.slotList(), before)
  const expired = inventory.swap(send, move, 0)
  inventory.expire(3000)
  await assert.rejects(expired, /nicht geantwortet/)
  assert.deepEqual(inventory.slotList(), before)
  const lost = inventory.swap(send, move, 3000)
  inventory.reset()
  await assert.rejects(lost, /getrennt/)
})
