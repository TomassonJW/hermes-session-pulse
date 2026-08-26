import assert from 'node:assert/strict'
import test from 'node:test'

import { loadPlugin } from './helpers/load-plugin.mjs'

test('an absolute threshold_tokens ceiling wins over any percentage', async () => {
  const plugin = await loadPlugin()

  const threshold = plugin.deriveThreshold({
    config: { compression: { threshold_tokens: 90_000, threshold: 0.5 } },
    contextMax: 128_000,
    model: 'claude-opus-5'
  })

  assert.equal(threshold, 90_000)
})

test('a per-model threshold overrides the default percentage', async () => {
  const plugin = await loadPlugin()

  const threshold = plugin.deriveThreshold({
    config: {
      compression: {
        threshold: 0.75,
        model_thresholds: { 'claude-opus': 0.5 }
      }
    },
    contextMax: 128_000,
    model: 'claude-opus-5'
  })

  assert.equal(threshold, 64_000)
})

test('the longest matching model key wins, mirroring resolve_model_threshold', async () => {
  const plugin = await loadPlugin()

  const threshold = plugin.deriveThreshold({
    config: {
      compression: {
        model_thresholds: { claude: 0.5, 'claude-opus-5': 0.25 }
      }
    },
    contextMax: 128_000,
    model: 'claude-opus-5'
  })

  assert.equal(threshold, 32_000)
})

test('the configured default percentage applies when no model key matches', async () => {
  const plugin = await loadPlugin()

  const threshold = plugin.deriveThreshold({
    config: {
      compression: { threshold: 0.6, model_thresholds: { 'gpt-5': 0.5 } }
    },
    contextMax: 200_000,
    model: 'claude-opus-5'
  })

  assert.equal(threshold, 120_000)
})

// The runtime reads `compression.threshold` (agent_init.py), NOT
// `threshold_percent`, and its default is 0.50 — not 0.75.
test('the runtime key is compression.threshold', async () => {
  const plugin = await loadPlugin()

  const threshold = plugin.deriveThreshold({
    config: { compression: { threshold: 0.9 } },
    contextMax: 200_000,
    model: 'claude-opus-5'
  })

  assert.equal(threshold, 180_000)
})

test('the runtime default of 50 percent applies with no compression config', async () => {
  const plugin = await loadPlugin()

  const threshold = plugin.deriveThreshold({
    config: {},
    contextMax: 128_000,
    model: 'claude-opus-5'
  })

  assert.equal(threshold, 64_000)
})

test('the live configuration shape resolves to its absolute ceiling', async () => {
  const plugin = await loadPlugin()

  // Exactly the block found in the running profile's config.yaml.
  const threshold = plugin.deriveThreshold({
    config: {
      compression: {
        enabled: true,
        threshold: 0.9,
        threshold_tokens: 250_000,
        target_ratio: 0.15
      }
    },
    contextMax: 200_000,
    model: 'claude-opus-5'
  })

  // threshold_tokens is an absolute cap, clamped to the window.
  assert.equal(threshold, 200_000)
})

test('a threshold of exactly 1 is read as the whole window, not one percent', async () => {
  const plugin = await loadPlugin()

  const threshold = plugin.deriveThreshold({
    config: { compression: { threshold: 1 } },
    contextMax: 128_000,
    model: 'claude-opus-5'
  })

  assert.equal(threshold, 128_000)
})

test('a nonsensical threshold falls back to the runtime default', async () => {
  const plugin = await loadPlugin()

  for (const bad of [0, -1, 'x', null, Number.NaN, Infinity, 250]) {
    assert.equal(
      plugin.deriveThreshold({
        config: { compression: { threshold: bad } },
        contextMax: 128_000,
        model: 'claude-opus-5'
      }),
      64_000,
      `threshold ${String(bad)} should fall back to 50%`
    )
  }
})

test('a disabled compressor has no compaction point at all', async () => {
  const plugin = await loadPlugin()

  // compression.enabled: false means the runtime never auto-compacts, so
  // presenting any threshold would be a fabricated expectation.
  const threshold = plugin.deriveThreshold({
    config: {
      compression: { enabled: false, threshold: 0.9, threshold_tokens: 250_000 }
    },
    contextMax: 200_000,
    model: 'claude-opus-5'
  })

  assert.equal(threshold, null)
})

test('compression enabled by omission still yields a threshold', async () => {
  const plugin = await loadPlugin()

  // The runtime default is enabled=True, so an absent key must not disable it.
  const threshold = plugin.deriveThreshold({
    config: { compression: { threshold: 0.5 } },
    contextMax: 128_000,
    model: 'claude-opus-5'
  })

  assert.equal(threshold, 64_000)
})

test('the threshold stays unknown without a context maximum', async () => {
  const plugin = await loadPlugin()

  const threshold = plugin.deriveThreshold({
    config: { compression: { threshold: 0.75 } },
    contextMax: null,
    model: 'claude-opus-5'
  })

  assert.equal(threshold, null)
})

test('a percentage expressed as a whole number is read as a percentage', async () => {
  const plugin = await loadPlugin()

  const threshold = plugin.deriveThreshold({
    config: { compression: { threshold: 75 } },
    contextMax: 128_000,
    model: 'claude-opus-5'
  })

  assert.equal(threshold, 96_000)
})

test('a derived threshold never exceeds the context maximum', async () => {
  const plugin = await loadPlugin()

  const threshold = plugin.deriveThreshold({
    config: { compression: { threshold_tokens: 999_000 } },
    contextMax: 128_000,
    model: 'claude-opus-5'
  })

  assert.equal(threshold, 128_000)
})
