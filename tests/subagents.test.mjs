import assert from 'node:assert/strict'
import test from 'node:test'

import { loadPlugin } from './helpers/load-plugin.mjs'

/**
 * The event stream is the only per-tab source of subagent activity, but the
 * plugin can load or hot-reload while subagents are ALREADY running. A count
 * assembled from a partial history is not a census, so it must not be
 * presented as one.
 */

test('an event history that starts mid-flight is not a reliable count', async () => {
  const plugin = await loadPlugin()
  const tracker = plugin.createSubagentTracker()

  // The plugin loaded late; the first thing it ever sees is a tool event from
  // an already-running child. Other children may be running unseen.
  tracker.observe('subagent.tool', 'tab-a', { subagent_id: 's1' })

  assert.equal(
    tracker.countFor('tab-a'),
    null,
    'a mid-flight history must read unknown, not 1'
  )
})

test('a completion alone never establishes a verified zero', async () => {
  const plugin = await loadPlugin()
  const tracker = plugin.createSubagentTracker()

  // Seeing only the END of a child we never saw start proves nothing about
  // how many others are still running.
  tracker.observe('subagent.complete', 'tab-a', { subagent_id: 's1' })

  assert.equal(tracker.countFor('tab-a'), null)
})

test('a global zero establishes the baseline that makes later counts trustworthy', async () => {
  const plugin = await loadPlugin()
  const tracker = plugin.createSubagentTracker()

  // A reliable global zero proves nothing is running anywhere, so from here on
  // the event stream is a complete record.
  tracker.observeGlobalActive(0)
  tracker.observe('subagent.start', 'tab-a', { subagent_id: 's1' })

  assert.equal(tracker.countFor('tab-a'), 1)
})

test('an authoritative global zero clears a stale positive', async () => {
  const plugin = await loadPlugin()
  const tracker = plugin.createSubagentTracker()

  tracker.observeGlobalActive(0)
  tracker.observe('subagent.start', 'tab-a', { subagent_id: 's1' })
  assert.equal(tracker.countFor('tab-a'), 1)

  // A dropped completion event would otherwise pin A1 forever. The global
  // counter is authoritative: nothing is running anywhere.
  tracker.observeGlobalActive(0)

  assert.equal(tracker.countFor('tab-a'), 0)
})

test('a non-zero global count does not invent a per-tab number', async () => {
  const plugin = await loadPlugin()
  const tracker = plugin.createSubagentTracker()

  tracker.observeGlobalActive(3)

  assert.equal(tracker.countFor('tab-never-seen'), null)
})

test('after a baseline, a completed child yields a verified zero', async () => {
  const plugin = await loadPlugin()
  const tracker = plugin.createSubagentTracker()

  tracker.observeGlobalActive(0)
  tracker.observe('subagent.start', 'tab-a', { subagent_id: 's1' })
  tracker.observe('subagent.complete', 'tab-a', { subagent_id: 's1' })

  assert.equal(tracker.countFor('tab-a'), 0)
})

test('sessions stay isolated once a baseline exists', async () => {
  const plugin = await loadPlugin()
  const tracker = plugin.createSubagentTracker()

  tracker.observeGlobalActive(0)
  tracker.observe('subagent.start', 'tab-a', { subagent_id: 's1' })
  tracker.observe('subagent.start', 'tab-b', { subagent_id: 's2' })
  tracker.observe('subagent.start', 'tab-a', { subagent_id: 's3' })

  assert.equal(tracker.countFor('tab-a'), 2)
  assert.equal(tracker.countFor('tab-b'), 1)
})

test('a repeated identity is never double counted', async () => {
  const plugin = await loadPlugin()
  const tracker = plugin.createSubagentTracker()

  tracker.observeGlobalActive(0)
  tracker.observe('subagent.start', 'tab-a', { subagent_id: 's1' })
  tracker.observe('subagent.tool', 'tab-a', { subagent_id: 's1' })
  tracker.observe('subagent.text', 'tab-a', { subagent_id: 's1' })

  assert.equal(tracker.countFor('tab-a'), 1)
})

test('a proven baseline survives the global counter becoming unavailable', async () => {
  const plugin = await loadPlugin()
  const tracker = plugin.createSubagentTracker()

  tracker.observeGlobalActive(0)
  tracker.observe('subagent.start', 'tab-a', { subagent_id: 's1' })
  // The global counter goes away (older gateway, RPC gap). Our own record is
  // still complete: we watched it start from a proven-empty baseline.
  tracker.observeGlobalActive(null)

  assert.equal(tracker.countFor('tab-a'), 1)
  assert.equal(tracker.countFor('tab-unseen'), 0)
})
