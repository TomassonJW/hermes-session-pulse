import assert from 'node:assert/strict'
import test from 'node:test'

import { loadPlugin } from './helpers/load-plugin.mjs'

const registerHarness = () => {
  const contributions = []
  const listeners = []
  const disposed = []
  const sdk = {
    host: {
      state: {},
      request: async () => ({}),
      onEvent: (type, fn) => {
        listeners.push({ type, fn })
        return () => disposed.push(type)
      }
    }
  }
  const ctx = { register: contribution => contributions.push(contribution) }
  return { contributions, listeners, disposed, sdk, ctx }
}

test('the plugin identity matches its folder name', async () => {
  const plugin = await loadPlugin()

  assert.equal(plugin.default.id, 'hermes-session-pulse')
  assert.equal(typeof plugin.default.register, 'function')
})

test('the plugin contributes to a status bar area the SDK actually exposes', async () => {
  const { contributions, sdk, ctx } = registerHarness()
  const plugin = await loadPlugin({ sdk })

  plugin.default.register(ctx)

  assert.equal(contributions.length, 1)
  assert.equal(contributions[0].area, 'statusBar.right')
  assert.equal(typeof contributions[0].render, 'function')
})

test('registering subscribes to the gateway event stream', async () => {
  const { listeners, sdk, ctx } = registerHarness()
  const plugin = await loadPlugin({ sdk })

  plugin.default.register(ctx)

  // Subagent activity is only per-tab on the event stream, so a wildcard
  // subscription is required. There is deliberately NO 'session.closed'
  // subscription: that event does not exist in the gateway (verified against
  // the installed runtime), so the tracker self-bounds instead.
  assert.equal(listeners.length, 1)
  assert.equal(listeners[0].type, '*')
})

test('disposing the plugin releases every event subscription', async () => {
  const { listeners, disposed, sdk, ctx } = registerHarness()
  const plugin = await loadPlugin({ sdk })

  const dispose = plugin.default.register(ctx)
  assert.equal(typeof dispose, 'function')
  dispose()

  assert.equal(disposed.length, listeners.length)
})

test('a subagent event on one tab does not affect another tab', async () => {
  const { listeners, sdk, ctx } = registerHarness()
  const plugin = await loadPlugin({ sdk })

  plugin.default.register(ctx)
  const wildcard = listeners.find(entry => entry.type === '*')
  assert.ok(wildcard, 'expected a wildcard event subscription')

  // Feed real gateway frame shapes through the live listener, then assert the
  // isolation directly on a tracker driven the same way.
  wildcard.fn({
    type: 'subagent.start',
    session_id: 'tab-a',
    payload: { subagent_id: 's1' }
  })
  wildcard.fn({ type: 'message.delta', session_id: 'tab-b', payload: {} })

  const tracker = plugin.createSubagentTracker()
  tracker.observe('subagent.start', 'tab-a', { subagent_id: 's1' })
  tracker.observe('message.delta', 'tab-b', {})

  assert.equal(tracker.countFor('tab-a'), 1)
  assert.equal(tracker.countFor('tab-b'), null, 'a non-subagent event must not create a tab')
})

test('a malformed event frame never throws out of the listener', async () => {
  const { listeners, sdk, ctx } = registerHarness()
  const plugin = await loadPlugin({ sdk })

  plugin.default.register(ctx)
  const wildcard = listeners.find(entry => entry.type === '*')

  assert.doesNotThrow(() => wildcard.fn(undefined))
  assert.doesNotThrow(() => wildcard.fn({}))
  assert.doesNotThrow(() => wildcard.fn({ type: 'subagent.start' }))
  assert.doesNotThrow(() => wildcard.fn({ params: { type: 'subagent.start' } }))
})
