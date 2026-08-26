import assert from 'node:assert/strict'
import test from 'node:test'

import { loadPlugin } from './helpers/load-plugin.mjs'

/**
 * The compaction threshold CANNOT be derived from config.
 *
 * Verified in agent/context_compressor.py, the runtime resolves it as:
 *   1. threshold_percent = config `threshold`, then per-model override,
 *      then RAISED to 0.75 for any window < 512_000 (_effective_threshold_percent);
 *   2. effective_window = context_length - max_tokens  (the provider's output
 *      reservation, which no plugin-reachable read exposes);
 *   3. tokens = effective_window * threshold_percent, floored at
 *      MINIMUM_CONTEXT_LENGTH, with an 85% degenerate-window fallback;
 *   4. threshold_tokens is applied as a CAP via min(), not as a winner
 *      (_apply_threshold_tokens_cap).
 *
 * Reproducing that from `config.get` alone yields a wrong number, so the
 * honest answer is unknown until the runtime exposes the effective value.
 */

test('the threshold is unknown even when the config is fully readable', async () => {
  const plugin = await loadPlugin()

  const request = async method => {
    if (method === 'process.list') return { processes: [] }
    // A config read would still not be enough, so it must not be attempted.
    throw new Error(`unexpected RPC ${method}`)
  }

  const snapshot = await plugin.loadSessionPulse({
    request,
    sessionId: 'tab-a',
    usage: {
      context_used: 42_000,
      context_max: 200_000,
      compressions: 1,
      model: 'claude-opus-5'
    },
    subagents: null
  })

  assert.equal(snapshot.thresholdTokens, null)
  // The values that ARE trustworthy must survive.
  assert.equal(snapshot.activeTokens, 42_000)
  assert.equal(snapshot.maxTokens, 200_000)
  assert.equal(snapshot.compactions, 1)
})

test('no config read is issued at all', async () => {
  const plugin = await loadPlugin()
  const calls = []
  const request = async method => {
    calls.push(method)
    if (method === 'process.list') return { processes: [] }
    throw new Error(`unexpected RPC ${method}`)
  }

  await plugin.loadSessionPulse({
    request,
    sessionId: 'tab-a',
    usage: { context_used: 1, context_max: 200_000 },
    subagents: null
  })

  assert.deepEqual(calls, ['process.list'])
  assert.ok(!calls.includes('config.get'), 'config must not be read at all')
})

test('the runtime threshold is preferred when the runtime ever reports it', async () => {
  const plugin = await loadPlugin()
  const request = async method => {
    if (method === 'process.list') return { processes: [] }
    throw new Error(`unexpected RPC ${method}`)
  }

  // Forward-compatible: if a future runtime adds the effective threshold to the
  // streamed usage payload, use it verbatim rather than deriving anything.
  const snapshot = await plugin.loadSessionPulse({
    request,
    sessionId: 'tab-a',
    usage: {
      context_used: 42_000,
      context_max: 200_000,
      threshold_tokens: 171_000
    },
    subagents: null
  })

  assert.equal(snapshot.thresholdTokens, 171_000)
})

test('a reported threshold is still clamped to the window', async () => {
  const plugin = await loadPlugin()
  const request = async method => {
    if (method === 'process.list') return { processes: [] }
    throw new Error(`unexpected RPC ${method}`)
  }

  const snapshot = await plugin.loadSessionPulse({
    request,
    sessionId: 'tab-a',
    usage: {
      context_used: 1_000,
      context_max: 128_000,
      context_threshold: 999_000
    },
    subagents: null
  })

  assert.equal(snapshot.thresholdTokens, 128_000)
})
