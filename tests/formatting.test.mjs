import assert from 'node:assert/strict'
import test from 'node:test'

import { loadPlugin } from './helpers/load-plugin.mjs'

test('formatTokenCount renders a compact whole-thousand value', async () => {
  const plugin = await loadPlugin()

  assert.equal(plugin.formatTokenCount(42_000), '42k')
})

test('loadSessionPulse scopes its session read to the focused runtime', async () => {
  const plugin = await loadPlugin()
  const calls = []
  const request = async (method, params) => {
    calls.push([method, params])
    if (method === 'process.list') {
      return { processes: [{ status: 'running' }, { status: 'exited' }] }
    }
    // La configuration est globale au profil, pas propre à une session.
    if (method === 'config.get') return { config: {} }
    throw new Error(`unexpected RPC ${method}`)
  }

  const snapshot = await plugin.loadSessionPulse({
    request,
    sessionId: 'runtime-tab-b',
    usage: {
      context_used: 42_000,
      context_max: 128_000,
      compressions: 3,
      model: 'claude-opus-5'
    },
    subagents: 2
  })

  // La seule lecture portant une identité de session doit être scopée.
  const sessionScoped = calls.filter(([method]) => method === 'process.list')
  assert.deepEqual(JSON.parse(JSON.stringify(sessionScoped)), [
    ['process.list', { session_id: 'runtime-tab-b' }]
  ])
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), {
    activeTokens: 42_000,
    // The runtime reports no threshold, and it cannot be honestly derived.
    thresholdTokens: null,
    maxTokens: 128_000,
    compactions: 3,
    subagents: 2,
    processes: 1
  })
})

test('loadSessionPulse never queries a global subagent RPC', async () => {
  const plugin = await loadPlugin()
  const calls = []
  const request = async method => {
    calls.push(method)
    if (method === 'process.list') return { processes: [] }
    throw new Error(`unexpected RPC ${method}`)
  }

  await plugin.loadSessionPulse({
    request,
    sessionId: 'runtime-tab-a',
    usage: { context_used: 1_000, context_max: 128_000 },
    subagents: null
  })

  assert.ok(!calls.includes('delegation.status'))
  assert.ok(!calls.includes('delegation.async_status'))
})

test('loadSessionPulse never dispatches a slash command', async () => {
  const plugin = await loadPlugin()
  const calls = []
  const request = async method => {
    calls.push(method)
    if (method === 'process.list') return { processes: [] }
    throw new Error(`unexpected RPC ${method}`)
  }

  await plugin.loadSessionPulse({
    request,
    sessionId: 'runtime-tab-a',
    usage: { context_used: 1_000, context_max: 128_000 },
    subagents: null
  })

  assert.ok(!calls.includes('slash.exec'))
})

test('loadSessionPulse preserves reliable categories when one RPC is unavailable', async () => {
  const plugin = await loadPlugin()
  const request = async method => {
    if (method === 'process.list') throw new Error('method unavailable')
    throw new Error(`unexpected RPC ${method}`)
  }

  const snapshot = await plugin.loadSessionPulse({
    request,
    sessionId: 'runtime-tab-a',
    usage: { context_used: 42_000, context_max: 128_000, compressions: 1 },
    subagents: 0
  })

  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), {
    activeTokens: 42_000,
    // The runtime reports no threshold; it is never guessed from config.
    thresholdTokens: null,
    maxTokens: 128_000,
    compactions: 1,
    subagents: 0,
    processes: null
  })
})

test('a stale threshold field of zero reads as unknown, not as zero', async () => {
  const plugin = await loadPlugin()
  const request = async method => {
    if (method === 'process.list') return { processes: [] }
    throw new Error(`unexpected RPC ${method}`)
  }

  const snapshot = await plugin.loadSessionPulse({
    request,
    sessionId: 'runtime-tab-a',
    usage: { context_used: 42_000, context_max: 128_000, threshold_tokens: 0 },
    subagents: null
  })

  // A threshold of zero is not a real compaction point.
  assert.equal(snapshot.thresholdTokens, null)
  assert.equal(snapshot.activeTokens, 42_000)
})

test('loadSessionPulse reports everything unknown without a focused session', async () => {
  const plugin = await loadPlugin()
  const request = async () => {
    throw new Error('no RPC should be issued without a focused session')
  }

  const snapshot = await plugin.loadSessionPulse({
    request,
    sessionId: null,
    usage: null,
    subagents: null
  })

  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), {
    activeTokens: null,
    thresholdTokens: null,
    maxTokens: null,
    compactions: null,
    subagents: null,
    processes: null
  })
})

test('a compression sentinel of minus one reads as unknown, not as zero', async () => {
  const plugin = await loadPlugin()
  const request = async method => {
    if (method === 'process.list') return { processes: [] }
    throw new Error(`unexpected RPC ${method}`)
  }

  const snapshot = await plugin.loadSessionPulse({
    request,
    sessionId: 'runtime-tab-a',
    usage: { context_used: -1, context_max: 128_000, compressions: 2 },
    subagents: null
  })

  assert.equal(snapshot.activeTokens, null)
  assert.equal(snapshot.compactions, 2)
})
