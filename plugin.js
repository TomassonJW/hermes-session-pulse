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

// ── Seuil de compaction ─────────────────────────────────────────────────────
//
// Le runtime résout le seuil ainsi (agent/context_compressor.py) :
//
//   pct   = model_thresholds | compression.threshold | 0.50
//   pct   = max(pct, 0.75)  si la fenêtre < 512_000   (_effective_threshold_percent)
//   ratio = max((fenêtre - max_tokens) * pct, 64_000) (_compute_threshold_tokens)
//   seuil = min(ratio, compression.threshold_tokens)  (_apply_threshold_tokens_cap)
//
// Seul `max_tokens`, la réserve de sortie du provider, est invisible pour un
// plugin. Mais `ratio` DÉCROÎT quand `max_tokens` croît : si le plafond
// configuré est déjà inférieur au ratio calculé avec une réserve de sortie
// généreuse, alors le plafond gagne pour toute valeur réelle de `max_tokens`.
// C'est une démonstration, pas une estimation — et elle couvre le cas courant
// d'un `threshold_tokens` explicitement configuré.
//
// Hors de ce cas, le seuil reste inconnu plutôt que deviné.

const RUNTIME_DEFAULT_THRESHOLD = 0.5
const SMALL_WINDOW_LIMIT = 512_000
const SMALL_WINDOW_FLOOR = 0.75
const MINIMUM_CONTEXT_LENGTH = 64_000
// Réserve de sortie maximale plausible. Une valeur haute rend la preuve plus
// exigeante, donc plus sûre : on ne conclut que si le plafond gagne même dans
// le cas le plus défavorable.
const MAX_PLAUSIBLE_OUTPUT_RESERVE = 128_000

const asFraction = value => {
  const number = finiteOrNull(value)
  if (number === null || number <= 0 || number > 1) return null
  return number
}

// Reproduit resolve_model_threshold : correspondance par sous-chaîne sur le nom
// du modèle, la clé la plus longue gagnant.
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

// Reproduit agent_init.py : enabled sauf désactivation explicite.
const compressionEnabled = compression => {
  const raw = compression?.enabled
  if (raw === undefined || raw === null) return true
  return ['true', '1', 'yes'].includes(String(raw).toLowerCase())
}

const reportedThreshold = usage =>
  finiteOrNull(
    usage?.context_threshold ?? usage?.threshold_tokens ?? usage?.compaction_threshold
  )

export function resolveThreshold({ config, contextMax, model, usage }) {
  const max = finiteOrNull(contextMax)

  // 1. Ce que le runtime rapporte lui-même gagne toujours.
  const reported = reportedThreshold(usage)
  if (reported) return max ? Math.min(max, reported) : reported

  if (!max) return null

  const compression = config?.compression
  // Un compresseur désactivé ne compacte jamais : aucun seuil à annoncer.
  if (!compressionEnabled(compression)) return null

  // 2. Sinon, le plafond absolu — mais seulement s'il est démontrablement
  //    gagnant.
  const cap = finiteOrNull(compression?.threshold_tokens)
  if (!cap || cap >= max) return null

  let pct =
    modelThresholdFraction(compression?.model_thresholds, model) ??
    asFraction(compression?.threshold) ??
    RUNTIME_DEFAULT_THRESHOLD
  if (max < SMALL_WINDOW_LIMIT) pct = Math.max(pct, SMALL_WINDOW_FLOOR)

  // Ratio dans le cas le plus défavorable au plafond : la plus grosse réserve
  // de sortie plausible, donc le plus petit ratio possible.
  const worstCaseWindow = Math.max(max - MAX_PLAUSIBLE_OUTPUT_RESERVE, 1)
  const worstCaseRatio = Math.max(
    Math.trunc(worstCaseWindow * pct),
    MINIMUM_CONTEXT_LENGTH
  )

  // Le plafond gagne même dans ce cas : il gagne donc toujours.
  return cap < worstCaseRatio ? cap : null
}

// ── Compactions ─────────────────────────────────────────────────────────────
//
// `compression_count` ne vit qu'en mémoire côté runtime : il repart à zéro à
// chaque reprise de session ou redémarrage, alors que la conversation a bien
// été compactée. Ce zéro est donc parfois faux, et il est détectable : si le
// contexte occupé dépasse le seuil de compaction, au moins une compaction a
// forcément eu lieu. On préfère alors `—` à un « 0 » faux.
export function trustedCompactions({ compactions, activeTokens, thresholdTokens }) {
  const count = finiteOrNull(compactions)
  if (count === null || count > 0) return count

  const used = finiteOrNull(activeTokens)
  const threshold = finiteOrNull(thresholdTokens)
  if (used === null || !threshold) return count

  return used >= threshold ? null : count
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

// Le bloc `compression` de la configuration ne change quasiment jamais, mais
// une requête séparée mise en cache cinq minutes rendait le seuil inconnu de
// façon durable dès que la toute première lecture échouait (socket du gateway
// pas encore ouverte au montage, changement de profil en cours). On mémorise
// donc uniquement les SUCCÈS : un échec transitoire est réessayé au
// rafraîchissement suivant, cinq secondes plus tard.
let cachedCompression = null

export function __resetCompressionCache() {
  cachedCompression = null
}

const readCompression = async request => {
  if (cachedCompression) return cachedCompression
  try {
    const answer = await request('config.get', { key: 'full' })
    const block = answer?.config?.compression
    if (block && typeof block === 'object') {
      cachedCompression = block
      return block
    }
    // Une configuration sans bloc `compression` est une réponse valide : le
    // runtime appliquera ses défauts, dont aucun plafond. Mémorisée telle
    // quelle pour ne pas re-interroger en boucle.
    cachedCompression = {}
    return cachedCompression
  } catch {
    // Volontairement pas mémorisé : on réessaiera.
    return null
  }
}

// `subagents` vient du suivi d'événements de l'appelant, pas d'une requête :
// toute RPC de sous-agents est globale, et un décompte global attribué à un
// onglet serait un mensonge.
export async function loadSessionPulse({
  request,
  sessionId,
  usage,
  subagents = null,
  config = null
}) {
  if (!sessionId) return { ...EMPTY_SNAPSHOT }

  const [processResult, compression] = await Promise.all([
    request('process.list', { session_id: sessionId }).then(
      value => ({ ok: true, value }),
      () => ({ ok: false })
    ),
    // Une configuration explicitement fournie (tests, appelant qui l'a déjà)
    // court-circuite la lecture.
    config?.compression ? Promise.resolve(config.compression) : readCompression(request)
  ])

  const maxTokens = finiteOrNull(usage?.context_max)
  const activeTokens = finiteOrNull(usage?.context_used)
  const thresholdTokens = resolveThreshold({
    config: compression ? { compression } : null,
    contextMax: maxTokens,
    model: usage?.model,
    usage
  })

  return {
    activeTokens,
    thresholdTokens,
    maxTokens,
    // Le compteur du runtime repart à zéro après une reprise : on refuse un
    // zéro que le dépassement du seuil contredit.
    compactions: trustedCompactions({
      compactions: usage?.compressions,
      activeTokens,
      thresholdTokens
    }),
    subagents: finiteOrNull(subagents),
    processes: processResult.ok ? runningProcessCount(processResult.value) : null
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
    // L'identifiant de session fait partie de la clé : changer d'onglet est une
    // requête différente, pas un réaffichage des chiffres de l'onglet précédent.
    queryKey: [
      PLUGIN_ID,
      sessionId,
      // Le modèle change le seuil : ne pas resservir celui du modèle précédent.
      usage?.model ?? null,
      usage?.context_used ?? null,
      usage?.context_max ?? null,
      usage?.compressions ?? null,
      globalActive
    ],
    enabled: Boolean(sessionId),
    // `process.list` est peu coûteuse et session-scopée : quelques secondes
    // suffisent.
    refetchInterval: 5_000,
    // Volontairement PAS de `placeholderData`. `previous => previous`
    // resservirait l'instantané de l'onglet PRÉCÉDENT sous l'onglet
    // fraîchement focalisé pendant le chargement — exactement la fuite que ce
    // plugin existe pour éviter. Un onglet en chargement affiche `—`.
    queryFn: () => {
      // Les mises à jour du suivi vont ici, pas dans le corps du rendu : le
      // rendu doit rester sans effet de bord.
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
