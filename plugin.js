import {
  cn,
  host,
  queryClient,
  STATUSBAR_AREAS,
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
// session.usage), so there is no eviction signal to subscribe to. The map is
// therefore self-bounding: least-recently-touched sessions are dropped past a
// cap. An evicted session reports unknown (`—`) again, never a false zero.
const DEFAULT_MAX_TRACKED_SESSIONS = 64

export function createSubagentTracker({ maxSessions = DEFAULT_MAX_TRACKED_SESSIONS } = {}) {
  // Map preserves insertion order; re-inserting on touch makes it an LRU.
  const bySession = new Map()
  let globalActive = null

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
    },
    forget: sessionId => {
      bySession.delete(sessionId)
    },
    trackedSessionCount: () => bySession.size,
    countFor: sessionId => {
      const live = sessionId ? touch(sessionId) : undefined
      if (live !== undefined) return live.size
      // Never observed (or since evicted). A trustworthy global zero still
      // proves the focused tab has none; any non-zero global tells us nothing
      // about which tab owns it, so stay honestly unknown.
      return globalActive === 0 ? 0 : null
    }
  }
}

// The compaction threshold lives on `agent.context_compressor` and is not
// serialised by any plugin-reachable RPC, so we mirror the runtime's own
// resolution from config — a side-effect-free read, unlike `/context`, which
// dispatches to a worker for an ordinary local session.
//
// Key names and default follow agent_init.py:
//   float(compression.get("threshold", 0.50))
// It is `threshold`, not `threshold_percent`, and the fallback is 0.50.
const RUNTIME_DEFAULT_THRESHOLD = 0.5

const asFraction = value => {
  const number = finiteOrNull(value)
  if (number === null || number <= 0) return null
  // Config accepts both 0.75 and 75.
  const fraction = number > 1 ? number / 100 : number
  return fraction > 0 && fraction <= 1 ? fraction : null
}

// Mirrors resolve_model_threshold: substring match on the model name, longest
// key wins.
const modelThresholdFraction = (modelThresholds, model) => {
  if (!modelThresholds || typeof modelThresholds !== 'object') return null
  const name = String(model || '')
  if (!name) return null
  let bestKey = null
  for (const key of Object.keys(modelThresholds)) {
    if (!key || !name.includes(key)) continue
    if (bestKey === null || key.length > bestKey.length) bestKey = key
  }
  return bestKey === null ? null : asFraction(modelThresholds[bestKey])
}

export function deriveThreshold({ config, contextMax, model }) {
  const max = finiteOrNull(contextMax)
  if (!max) return null

  const compression = config?.compression
  const clamp = value => Math.min(max, value)

  const absolute = finiteOrNull(compression?.threshold_tokens)
  if (absolute) return clamp(absolute)

  const fraction =
    modelThresholdFraction(compression?.model_thresholds, model) ??
    asFraction(compression?.threshold) ??
    RUNTIME_DEFAULT_THRESHOLD

  return clamp(Math.round(max * fraction))
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
// one tab would be a lie.
export async function loadSessionPulse({ request, sessionId, usage, subagents = null }) {
  if (!sessionId) return { ...EMPTY_SNAPSHOT }

  const [processResult, configResult] = await Promise.allSettled([
    request('process.list', { session_id: sessionId }),
    request('config.get', { key: 'full' })
  ])

  const maxTokens = finiteOrNull(usage?.context_max)
  const config = configResult.status === 'fulfilled' ? configResult.value?.config : null

  return {
    activeTokens: finiteOrNull(usage?.context_used),
    thresholdTokens: config
      ? deriveThreshold({ config, contextMax: maxTokens, model: usage?.model })
      : null,
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
      usage?.context_used ?? null,
      usage?.context_max ?? null,
      usage?.compressions ?? null,
      globalActive
    ],
    enabled: Boolean(sessionId),
    // process.list is cheap and session-scoped; a few seconds is plenty.
    refetchInterval: 5_000,
    placeholderData: previous => previous,
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
      area: STATUSBAR_AREAS.right,
      order: 114,
      render: () => jsx(SessionPulseChip, { tracker })
    })

    return () => {
      offSubagent?.()
    }
  }
}
