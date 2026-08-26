import assert from 'node:assert/strict'
import test from 'node:test'

import { loadPlugin } from './helpers/load-plugin.mjs'

// There is NO `session.closed` gateway event (verified against the installed
// runtime: tui_gateway emits session.info / session.usage; session.reclaimed
// covers only idle/LRU reclamation). So the tracker cannot rely on an eviction
// event and must bound itself.
//
// Every test here first establishes the baseline with a reliable global zero,
// because without one the tracker reports unknown by design.

test('the tracker evicts the oldest sessions past its cap', async () => {
  const plugin = await loadPlugin()
  const tracker = plugin.createSubagentTracker({ maxSessions: 3 })
  tracker.observeGlobalActive(0)

  tracker.observe('subagent.start', 'tab-1', { subagent_id: 's1' })
  tracker.observe('subagent.start', 'tab-2', { subagent_id: 's2' })
  tracker.observe('subagent.start', 'tab-3', { subagent_id: 's3' })
  tracker.observe('subagent.start', 'tab-4', { subagent_id: 's4' })

  assert.equal(tracker.trackedSessionCount(), 3)
  assert.equal(tracker.countFor('tab-4'), 1)
})

test('touching a session keeps it from being evicted as oldest', async () => {
  const plugin = await loadPlugin()
  const tracker = plugin.createSubagentTracker({ maxSessions: 2 })
  tracker.observeGlobalActive(0)

  tracker.observe('subagent.start', 'tab-1', { subagent_id: 's1' })
  tracker.observe('subagent.start', 'tab-2', { subagent_id: 's2' })
  // Re-touch tab-1 so tab-2 becomes the least recently used.
  tracker.observe('subagent.tool', 'tab-1', { subagent_id: 's1' })
  tracker.observe('subagent.start', 'tab-3', { subagent_id: 's3' })

  assert.equal(tracker.countFor('tab-1'), 1)
  assert.equal(tracker.trackedSessionCount(), 2)
})

test('the tracker stays bounded across many sessions', async () => {
  const plugin = await loadPlugin()
  const tracker = plugin.createSubagentTracker()
  tracker.observeGlobalActive(0)

  for (let index = 0; index < 500; index += 1) {
    tracker.observe('subagent.start', `tab-${index}`, { subagent_id: `s${index}` })
  }

  assert.ok(
    tracker.trackedSessionCount() < 500,
    'an unbounded tracker would leak one entry per session ever seen'
  )
})

test('an authoritative global zero releases every tracked session', async () => {
  const plugin = await loadPlugin()
  const tracker = plugin.createSubagentTracker()

  tracker.observeGlobalActive(0)
  tracker.observe('subagent.start', 'tab-1', { subagent_id: 's1' })
  tracker.observe('subagent.start', 'tab-2', { subagent_id: 's2' })
  assert.equal(tracker.trackedSessionCount(), 2)

  // Nothing is running anywhere: no live set needs to be retained.
  tracker.observeGlobalActive(0)

  assert.equal(tracker.trackedSessionCount(), 0)
  assert.equal(tracker.countFor('tab-1'), 0)
})
