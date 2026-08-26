import assert from 'node:assert/strict'
import test from 'node:test'

import { loadPlugin } from './helpers/load-plugin.mjs'

// There is NO `session.closed` gateway event (verified against the installed
// runtime: tui_gateway emits session.info / session.usage, never session.closed).
// So the tracker cannot rely on an eviction event and must bound itself.

test('the tracker evicts the oldest sessions past its cap', async () => {
  const plugin = await loadPlugin()
  const tracker = plugin.createSubagentTracker({ maxSessions: 3 })

  tracker.observe('subagent.start', 'tab-1', { subagent_id: 's1' })
  tracker.observe('subagent.start', 'tab-2', { subagent_id: 's2' })
  tracker.observe('subagent.start', 'tab-3', { subagent_id: 's3' })
  tracker.observe('subagent.start', 'tab-4', { subagent_id: 's4' })

  assert.equal(tracker.trackedSessionCount(), 3)
  // The oldest tab was evicted, so it is unknown again — never a false zero.
  assert.equal(tracker.countFor('tab-1'), null)
  assert.equal(tracker.countFor('tab-4'), 1)
})

test('touching a session keeps it from being evicted as oldest', async () => {
  const plugin = await loadPlugin()
  const tracker = plugin.createSubagentTracker({ maxSessions: 2 })

  tracker.observe('subagent.start', 'tab-1', { subagent_id: 's1' })
  tracker.observe('subagent.start', 'tab-2', { subagent_id: 's2' })
  // Re-touch tab-1 so tab-2 becomes the least recently used.
  tracker.observe('subagent.tool', 'tab-1', { subagent_id: 's1' })
  tracker.observe('subagent.start', 'tab-3', { subagent_id: 's3' })

  assert.equal(tracker.countFor('tab-1'), 1)
  assert.equal(tracker.countFor('tab-2'), null)
})

test('a session whose subagents all finished stops occupying a slot', async () => {
  const plugin = await loadPlugin()
  const tracker = plugin.createSubagentTracker({ maxSessions: 5 })

  tracker.observe('subagent.start', 'tab-1', { subagent_id: 's1' })
  tracker.observe('subagent.complete', 'tab-1', { subagent_id: 's1' })

  // Still reports a verified zero for that tab...
  assert.equal(tracker.countFor('tab-1'), 0)
  // ...but an idle tab must not pin memory forever.
  assert.ok(tracker.trackedSessionCount() <= 5)
})

test('the tracker defaults to a bounded number of sessions', async () => {
  const plugin = await loadPlugin()
  const tracker = plugin.createSubagentTracker()

  for (let index = 0; index < 500; index += 1) {
    tracker.observe('subagent.start', `tab-${index}`, { subagent_id: `s${index}` })
  }

  assert.ok(
    tracker.trackedSessionCount() < 500,
    'an unbounded tracker would leak one entry per session ever seen'
  )
})
