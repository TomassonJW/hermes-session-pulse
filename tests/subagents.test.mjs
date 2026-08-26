import assert from 'node:assert/strict'
import test from 'node:test'

import { loadPlugin } from './helpers/load-plugin.mjs'

test('subagent tracker counts only the focused session and ignores other tabs', async () => {
  const plugin = await loadPlugin()
  const tracker = plugin.createSubagentTracker()

  tracker.observe('subagent.start', 'tab-a', { subagent_id: 's1' })
  tracker.observe('subagent.start', 'tab-b', { subagent_id: 's2' })
  tracker.observe('subagent.start', 'tab-a', { subagent_id: 's3' })

  assert.equal(tracker.countFor('tab-a'), 2)
  assert.equal(tracker.countFor('tab-b'), 1)
})

test('subagent tracker releases a subagent when it completes', async () => {
  const plugin = await loadPlugin()
  const tracker = plugin.createSubagentTracker()

  tracker.observe('subagent.start', 'tab-a', { subagent_id: 's1' })
  tracker.observe('subagent.start', 'tab-a', { subagent_id: 's2' })
  tracker.observe('subagent.complete', 'tab-a', { subagent_id: 's1' })

  assert.equal(tracker.countFor('tab-a'), 1)
})

test('subagent tracker never double counts a repeated identity', async () => {
  const plugin = await loadPlugin()
  const tracker = plugin.createSubagentTracker()

  tracker.observe('subagent.start', 'tab-a', { subagent_id: 's1' })
  tracker.observe('subagent.tool', 'tab-a', { subagent_id: 's1' })
  tracker.observe('subagent.text', 'tab-a', { subagent_id: 's1' })

  assert.equal(tracker.countFor('tab-a'), 1)
})

test('subagent tracker reports unknown for a session it never observed', async () => {
  const plugin = await loadPlugin()
  const tracker = plugin.createSubagentTracker()

  tracker.observe('subagent.start', 'tab-a', { subagent_id: 's1' })

  assert.equal(tracker.countFor('tab-unseen'), null)
})

test('a reliable global zero proves the focused tab has no subagent', async () => {
  const plugin = await loadPlugin()
  const tracker = plugin.createSubagentTracker()

  tracker.observeGlobalActive(0)

  assert.equal(tracker.countFor('tab-never-seen'), 0)
})

test('a non-zero global count stays unknown for an unobserved tab', async () => {
  const plugin = await loadPlugin()
  const tracker = plugin.createSubagentTracker()

  tracker.observeGlobalActive(3)

  assert.equal(tracker.countFor('tab-never-seen'), null)
})

test('a global zero does not erase a subagent observed on the focused tab', async () => {
  const plugin = await loadPlugin()
  const tracker = plugin.createSubagentTracker()

  tracker.observe('subagent.start', 'tab-a', { subagent_id: 's1' })
  tracker.observeGlobalActive(0)

  assert.equal(tracker.countFor('tab-a'), 1)
})

test('forgetting a session drops its tracked subagents', async () => {
  const plugin = await loadPlugin()
  const tracker = plugin.createSubagentTracker()

  tracker.observe('subagent.start', 'tab-a', { subagent_id: 's1' })
  tracker.forget('tab-a')

  assert.equal(tracker.countFor('tab-a'), null)
})
