import {
  cn,
  COMPOSER_AREAS,
  host,
  queryClient,
  Tip,
  useQuery,
  useValue
} from '@hermes/plugin-sdk'
import { jsx } from 'react/jsx-runtime'

export function formatTokenCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—'
  if (value < 1_000) return String(Math.round(value))
  return `${Math.round(value / 1_000)}k`
}

const finiteOrNull = value =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

const runningProcessCount = payload => {
  const rows = Array.isArray(payload?.processes)
    ? payload.processes
    : Array.isArray(payload?.sessions)
      ? payload.sessions
      : null
  return rows ? rows.filter(item => item?.status === 'running').length : null
}

// Subagent activity is only session-scoped on the EVENT stream: every gateway
// frame carries its own session_id, whereas `delegation.status` is global and
// strips owner_session_id, and `session.usage.active_subagents` is a global
// counter too. So we track identities per session ourselves.
//
// The gateway emits NO `session.closed` event (it emits session.info /
// session.usage; `session.reclaimed` only covers idle/LRU reclamation), so
// there is no eviction signal to subscribe to. The map is therefore
// self-bounding: least-recently-touched sessions are dropped past a cap.
//
// Crucially, an event history is only a CENSUS once we know it started from
// nothing. The plugin can load or hot-reload while children are already
// running, and a late-arriving `subagent.tool` for an unseen child would
// otherwise read as "1" while others run unobserved. So counts stay unknown
// until a reliable global zero establishes a baseline.
const DEFAULT_MAX_TRACKED_SESSIONS = 64

export function createSubagentTracker({ maxSessions = DEFAULT_MAX_TRACKED_SESSIONS } = {}) {
  // Map preserves insertion order; re-inserting on touch makes it an LRU.
  const bySession = new Map()
  let globalActive = null
  // True once a reliable global zero proved nothing was running anywhere.
  let hasBaseline = false

  const touch = sessionId => {
    const live = bySession.get(sessionId)
    if (live === undefined) return undefined
    bySession.delete(sessionId)
    bySession.set(sessionId, live)
    return live
  }

  const observe = (eventType, sessionId, payload) => {
    if (typeof eventType !== 'string' || !eventType.startsWith('subagent.')) return
    if (!sessionId) return
    const identity =
      payload?.subagent_id ?? payload?.child_session_id ?? payload?.goal ?? null
    if (!identity) return

    let live = touch(sessionId)
    if (live === undefined) {
      live = new Set()
      bySession.set(sessionId, live)
    }
    if (eventType === 'subagent.complete') live.delete(String(identity))
    else live.add(String(identity))

    while (bySession.size > maxSessions) {
      const oldest = bySession.keys().next().value
      if (oldest === undefined) break
      bySession.delete(oldest)
    }
  }

  return {
    observe,
    observeGlobalActive: value => {
      globalActive = finiteOrNull(value)
      if (globalActive === 0) {
        // Authoritative: nothing is running in ANY session. This both
        // establishes the baseline and clears stale positives left behind by a
        // dropped completion event.
        hasBaseline = true
        bySession.clear()
      }
    },
    forget: sessionId => {
      bySession.delete(sessionId)
    },
    trackedSessionCount: () => bySession.size,
    hasReliableBaseline: () => hasBaseline,
    countFor: sessionId => {
      // Without a proven starting point our record may be incomplete, so any
      // number we could produce would be a guess presented as fact.
      if (!hasBaseline) return null
      const live = sessionId ? touch(sessionId) : undefined
      // Post-baseline, an unseen tab genuinely has none: we would have seen a
      // start event for it.
      return live === undefined ? 0 : live.size
    }
  }
}

// The compaction threshold CANNOT be honestly derived. It lives on
// `agent.context_compressor` and is serialised by no plugin-reachable read,
// and the runtime's resolution (agent/context_compressor.py) needs inputs no
// plugin can see:
//
//   1. threshold_percent = config `threshold`, then a per-model override, then
//      RAISED to 0.75 for ANY window below 512_000 (_effective_threshold_percent
//      — so a 128K model does NOT keep a configured 0.50);
//   2. the percentage applies to `context_length - max_tokens`, the provider's
//      output reservation, which no RPC exposes;
//   3. the result is floored at MINIMUM_CONTEXT_LENGTH with an 85%
//      degenerate-window fallback;
//   4. `threshold_tokens` is applied as a CAP via min(), not as a winner
//      (_apply_threshold_tokens_cap);
//   5. provider autoraises and external context engines can override all of it.
//
// Reproducing that from `config.get` produces a confident wrong number, which
// is worse than admitting ignorance. So we only report a threshold the runtime
// itself hands us, and otherwise render unknown. See issue: exposing the
// compressor's effective threshold_tokens on session.usage would fix this.
export function readReportedThreshold({ usage, contextMax }) {
  const reported = finiteOrNull(
    usage?.context_threshold ??
      usage?.threshold_tokens ??
      usage?.compaction_threshold
  )
  if (!reported) return null
  const max = finiteOrNull(contextMax)
  // A threshold beyond the window can never be reached; clamp so the display
  // stays coherent.
  return max ? Math.min(max, reported) : reported
}

const UNKNOWN = '—'

// Near-threshold accent starts at 90% of the threshold — enough warning to act
// on, late enough that it isn't permanently lit.
const NEAR_THRESHOLD_FRACTION = 0.9

export function formatPulseLine(snapshot) {
  const counter = (prefix, value) =>
    `${prefix}${value === null || value === undefined ? UNKNOWN : Math.trunc(value)}`

  return [
    [
      formatTokenCount(snapshot?.activeTokens),
      formatTokenCount(snapshot?.thresholdTokens),
      formatTokenCount(snapshot?.maxTokens)
    ].join(' / '),
    counter('C', snapshot?.compactions),
    counter('A', snapshot?.subagents),
    counter('P', snapshot?.processes)
  ].join(' · ')
}

export function thresholdState({ activeTokens, thresholdTokens }) {
  const used = finiteOrNull(activeTokens)
  const threshold = finiteOrNull(thresholdTokens)
  if (used === null || !threshold) return 'unknown'
  if (used >= threshold) return 'over'
  if (used >= threshold * NEAR_THRESHOLD_FRACTION) return 'near'
  return 'normal'
}

// Screen readers get the full sentence, never the compact glyph line: the
// information must not depend on decoding `C3 · A2 · P1`.
export function accessibleLabel(snapshot) {
  const exact = value =>
    value === null || value === undefined
      ? 'unknown'
      : Math.trunc(value).toLocaleString('en-US')

  return [
    `Context in use: ${exact(snapshot?.activeTokens)} tokens`,
    `compaction expected at: ${exact(snapshot?.thresholdTokens)} tokens`,
    `model limit: ${exact(snapshot?.maxTokens)} tokens`,
    `compactions so far: ${exact(snapshot?.compactions)}`,
    `active subagents: ${exact(snapshot?.subagents)}`,
    `active processes: ${exact(snapshot?.processes)}`
  ].join('. ') + '.'
}

const EMPTY_SNAPSHOT = {
  activeTokens: null,
  thresholdTokens: null,
  maxTokens: null,
  compactions: null,
  subagents: null,
  processes: null
}

// `subagents` is supplied by the caller's event-stream tracker, not fetched:
// every subagent RPC on the gateway is global, and a global count attributed to
// one tab would be a lie. The threshold likewise comes only from what the
// runtime reports — never from a config-derived guess.
export async function loadSessionPulse({ request, sessionId, usage, subagents = null }) {
  if (!sessionId) return { ...EMPTY_SNAPSHOT }

  const [processResult] = await Promise.allSettled([
    request('process.list', { session_id: sessionId })
  ])

  const maxTokens = finiteOrNull(usage?.context_max)

  return {
    activeTokens: finiteOrNull(usage?.context_used),
    thresholdTokens: readReportedThreshold({ usage, contextMax: maxTokens }),
    maxTokens,
    compactions: finiteOrNull(usage?.compressions),
    subagents: finiteOrNull(subagents),
    processes:
      processResult.status === 'fulfilled' ? runningProcessCount(processResult.value) : null
  }
}

// ─── UI ────────────────────────────────────────────────────────────────────
// Everything above is pure and unit-tested. Everything below is the thin
// Hermes Desktop binding.

const PLUGIN_ID = 'hermes-session-pulse'

const ACCENT_BY_STATE = {
  over: 'var(--ui-accent)',
  near: 'var(--ui-text-secondary)',
  normal: 'var(--ui-text-tertiary)',
  unknown: 'var(--ui-text-quaternary)'
}

function SessionPulseChip({ tracker }) {
  // focusedSessionId is the runtime identity of the FOCUSED tab/tile — the
  // whole point of this plugin. activeSessionId would leak another tab's data.
  const sessionId = useValue(host.state.focusedSessionId)
  const usage = useValue(host.state.focusedUsage)

  // Streamed usage carries the GLOBAL active_subagents counter; a reliable zero
  // there is the only inference it licenses for an unobserved tab.
  const globalActive =
    typeof usage?.active_subagents === 'number' ? usage.active_subagents : null

  const { data } = useQuery({
    // The session id is part of the key, so switching tabs is a different
    // query rather than a stale render of the previous tab's numbers.
    queryKey: [
      PLUGIN_ID,
      sessionId,
      // The model affects any threshold the runtime reports, so a model switch
      // must not serve the previous model's number.
      usage?.model ?? null,
      usage?.context_used ?? null,
      usage?.context_max ?? null,
      usage?.compressions ?? null,
      globalActive
    ],
    enabled: Boolean(sessionId),
    // process.list is cheap and session-scoped; a few seconds is plenty.
    refetchInterval: 5_000,
    // Deliberately NO placeholderData. `previous => previous` would re-serve
    // the PREVIOUS tab's snapshot under the newly focused tab while its own
    // reads are still in flight — the exact cross-tab leak this plugin exists
    // to avoid. A loading tab shows `—`, which is honest and holds the layout.
    queryFn: () => {
      // Tracker updates belong here, not in the render body: rendering must
      // stay free of side effects.
      tracker.observeGlobalActive(globalActive)
      return loadSessionPulse({
        request: (method, params) => host.request(method, params),
        sessionId,
        usage,
        subagents: tracker.countFor(sessionId)
      })
    }
  })

  if (!sessionId) return null

  const snapshot = data ?? EMPTY_SNAPSHOT
  const state = thresholdState(snapshot)

  return jsx(Tip, {
    label: accessibleLabel(snapshot),
    children: jsx('span', {
      role: 'status',
      'aria-label': accessibleLabel(snapshot),
      className: cn(
        'inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] tabular-nums'
      ),
      style: { color: ACCENT_BY_STATE[state] },
      children: formatPulseLine(snapshot)
    })
  })
}

export default {
  id: PLUGIN_ID,
  name: 'Session Pulse',
  defaultEnabled: true,
  register(ctx) {
    const tracker = createSubagentTracker()

    // Subagent counts are only trustworthy per-tab from the event stream:
    // every frame carries its own session_id.
    const offSubagent = host.onEvent('*', event => {
      const type = event?.type ?? event?.params?.type
      if (typeof type !== 'string' || !type.startsWith('subagent.')) return
      const sid = event?.session_id ?? event?.params?.session_id
      const payload = event?.payload ?? event?.params?.payload
      tracker.observe(type, sid, payload)
      queryClient.invalidateQueries({ queryKey: [PLUGIN_ID] })
    })

    ctx.register({
      id: 'pulse',
      // The UI contract asks for a thin strip under the composer.
      // COMPOSER_AREAS.underside is 'composer.underside' — a floating strip
      // below the whole composer, with no chrome of its own.
      area: COMPOSER_AREAS.underside,
      order: 114,
      render: () => jsx(SessionPulseChip, { tracker })
    })

    return () => {
      offSubagent?.()
    }
  }
}
