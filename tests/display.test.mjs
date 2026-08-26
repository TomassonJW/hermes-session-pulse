import assert from 'node:assert/strict'
import test from 'node:test'

import { loadPlugin } from './helpers/load-plugin.mjs'

test('a complete snapshot renders the canonical compact line', async () => {
  const plugin = await loadPlugin()

  const line = plugin.formatPulseLine({
    activeTokens: 42_000,
    thresholdTokens: 96_000,
    maxTokens: 128_000,
    compactions: 3,
    subagents: 2,
    processes: 1
  })

  assert.equal(line, '42k / 96k / 128k · C3 · A2 · P1')
})

test('a verified idle snapshot shows explicit zeros, not dashes', async () => {
  const plugin = await loadPlugin()

  const line = plugin.formatPulseLine({
    activeTokens: 8_000,
    thresholdTokens: 96_000,
    maxTokens: 128_000,
    compactions: 0,
    subagents: 0,
    processes: 0
  })

  assert.equal(line, '8k / 96k / 128k · C0 · A0 · P0')
})

test('unknown categories render as a dash and never as zero', async () => {
  const plugin = await loadPlugin()

  const line = plugin.formatPulseLine({
    activeTokens: 42_000,
    thresholdTokens: null,
    maxTokens: 128_000,
    compactions: null,
    subagents: null,
    processes: 2
  })

  assert.equal(line, '42k / — / 128k · C— · A— · P2')
})

test('an entirely unknown snapshot still holds the layout', async () => {
  const plugin = await loadPlugin()

  const line = plugin.formatPulseLine({
    activeTokens: null,
    thresholdTokens: null,
    maxTokens: null,
    compactions: null,
    subagents: null,
    processes: null
  })

  assert.equal(line, '— / — / — · C— · A— · P—')
})

test('the threshold state reports normal below the threshold', async () => {
  const plugin = await loadPlugin()

  assert.equal(
    plugin.thresholdState({ activeTokens: 42_000, thresholdTokens: 96_000 }),
    'normal'
  )
})

test('the threshold state warns as the threshold is approached', async () => {
  const plugin = await loadPlugin()

  assert.equal(
    plugin.thresholdState({ activeTokens: 90_000, thresholdTokens: 96_000 }),
    'near'
  )
})

test('the threshold state reports reached once the threshold is met', async () => {
  const plugin = await loadPlugin()

  assert.equal(
    plugin.thresholdState({ activeTokens: 96_000, thresholdTokens: 96_000 }),
    'over'
  )
})

test('the threshold state is unknown without both figures', async () => {
  const plugin = await loadPlugin()

  assert.equal(
    plugin.thresholdState({ activeTokens: 42_000, thresholdTokens: null }),
    'unknown'
  )
})

test('the accessible label spells every category out in full', async () => {
  const plugin = await loadPlugin()

  const label = plugin.accessibleLabel({
    activeTokens: 42_000,
    thresholdTokens: 96_000,
    maxTokens: 128_000,
    compactions: 3,
    subagents: 2,
    processes: 1
  })

  assert.match(label, /42,000/)
  assert.match(label, /compaction/i)
  assert.match(label, /subagent/i)
  assert.match(label, /process/i)
  assert.doesNotMatch(label, /C3/)
})

test('the accessible label names unknown categories as unknown', async () => {
  const plugin = await loadPlugin()

  const label = plugin.accessibleLabel({
    activeTokens: null,
    thresholdTokens: null,
    maxTokens: null,
    compactions: null,
    subagents: null,
    processes: null
  })

  assert.match(label, /unknown/i)
  assert.doesNotMatch(label, /—/)
})
