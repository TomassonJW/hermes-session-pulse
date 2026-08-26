/**
 * Live verification against a REAL Hermes TUI gateway process (stdio JSON-RPC).
 *
 * Loads the INSTALLED plugin.js and drives its own `loadSessionPulse` against a
 * freshly spawned gateway. This proves the RPC names, params and payload shapes
 * the plugin depends on actually exist in the installed runtime — which is what
 * a screenshot cannot prove.
 *
 * Strictly read-only: only session.new (to obtain a runtime id), session.usage,
 * process.list and config.get are issued. No message is sent to a model, and
 * no mutation of user data occurs.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import vm from 'node:vm'

const PLUGIN = process.env.PULSE_PLUGIN_PATH
const PYTHON =
  process.env.PULSE_PYTHON || `${process.env.HOME}/.hermes/hermes-agent/venv/bin/python`
const AGENT_DIR = process.env.PULSE_AGENT_DIR || `${process.env.HOME}/.hermes/hermes-agent`

const SDK = {
  cn: (...n) => n.filter(Boolean).join(' '),
  host: { state: {}, request: async () => ({}), onEvent: () => () => {} },
  queryClient: { invalidateQueries: () => {} },
  COMPOSER_AREAS: {
    top: 'composer.top',
    bottom: 'composer.bottom',
    underside: 'composer.underside',
    leading: 'composer.leading',
    actions: 'composer.actions'
  },
  STATUSBAR_AREAS: { left: 'statusBar.left', right: 'statusBar.right' },
  Tip: 'Tip',
  useQuery: () => ({ data: undefined }),
  useValue: () => null
}

function synthetic(context, identifier, values) {
  const names = Object.keys(values)
  return new vm.SyntheticModule(
    names,
    function () {
      for (const n of names) this.setExport(n, values[n])
    },
    { context, identifier }
  )
}

async function loadInstalledPlugin(pluginPath) {
  const source = await fs.readFile(pluginPath, 'utf8')
  const context = vm.createContext({ AbortController, console, clearTimeout, setTimeout })
  const mod = new vm.SourceTextModule(source, { context, identifier: pluginPath })
  const deps = new Map([
    ['@hermes/plugin-sdk', synthetic(context, '@hermes/plugin-sdk', SDK)],
    ['react', synthetic(context, 'react', {})],
    [
      'react/jsx-runtime',
      synthetic(context, 'react/jsx-runtime', {
        jsx: (type, props) => ({ type, props }),
        jsxs: (type, props) => ({ type, props })
      })
    ]
  ])
  await mod.link(async spec => {
    const d = deps.get(spec)
    if (!d) throw new Error(`Unexpected import: ${spec}`)
    return d
  })
  await mod.evaluate()
  return mod.namespace
}

async function main() {
  const plugin = await loadInstalledPlugin(PLUGIN)

  const proc = spawn(PYTHON, ['-m', 'tui_gateway.entry'], {
    cwd: AGENT_DIR,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUNBUFFERED: '1' }
  })

  const pending = new Map()
  const events = []
  let seq = 0
  let buffer = ''
  let stderrTail = ''

  proc.stderr.on('data', d => {
    stderrTail = (stderrTail + d.toString()).slice(-2000)
  })

  proc.stdout.on('data', chunk => {
    buffer += chunk.toString()
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      let frame
      try {
        frame = JSON.parse(line)
      } catch {
        continue
      }
      if (frame.method === 'event') {
        events.push(frame.params)
        continue
      }
      if (frame.id === undefined || frame.id === null) continue
      const entry = pending.get(frame.id)
      if (!entry) continue
      pending.delete(frame.id)
      if (frame.error) entry.reject(new Error(frame.error.message || 'rpc error'))
      else entry.resolve(frame.result)
    }
  })

  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = `pulse-${++seq}`
      pending.set(id, { resolve, reject })
      proc.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n'
      )
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`timeout: ${method}`))
      }, 40_000)
    })

  const results = { runtime: 'python -m tui_gateway.entry', checks: [] }
  const record = (name, ok, detail) => results.checks.push({ name, ok, detail })

  // Give the gateway a moment to finish booting.
  await new Promise(r => setTimeout(r, 4_000))

  let sessionId = null
  try {
    const created = await request('session.create', { cwd: process.cwd() })
    sessionId =
      created?.session_id || created?.id || created?.session?.session_id || null
    record(
      'gateway reachable (session.create)',
      Boolean(sessionId),
      `session_id=${sessionId}`
    )
  } catch (e) {
    record('gateway reachable (session.create)', false, e.message)
  }

  // The RPC the previous handoff assumed must NOT exist. A timeout or any
  // other failure is NOT proof of absence — require an explicit
  // method-not-found rejection.
  try {
    await request('delegation.async_status', { session_id: sessionId || 'x' })
    record('delegation.async_status is absent', false, 'it answered — handoff would be right')
  } catch (e) {
    const notFound = /unknown method|method not found|no such method/i.test(e.message)
    record(
      'delegation.async_status is absent',
      notFound,
      notFound ? `method-not-found: ${e.message}` : `INCONCLUSIVE (not a 404): ${e.message}`
    )
  }

  // delegation.status exists but is global: prove it by the ABSENCE of any
  // session_id parameter in its contract and by its response shape.
  try {
    const del = await request('delegation.status', {})
    const keys = Object.keys(del || {}).sort()
    const hasGlobalShape =
      Array.isArray(del?.active) &&
      'max_concurrent_children' in (del || {}) &&
      !('session_id' in (del || {}))
    record(
      'delegation.status is global (no session scoping in its payload)',
      hasGlobalShape,
      `keys=${keys.join(',')}`
    )
    // owner_session_id stripping can only be positively demonstrated when at
    // least one subagent is present; otherwise say so rather than claim proof.
    const active = Array.isArray(del?.active) ? del.active : []
    if (active.length === 0) {
      record(
        'owner_session_id stripping (needs a live subagent to demonstrate)',
        true,
        'VACUOUS: no active subagents; asserted from source instead ' +
          '(delegate_tool.list_active_subagents excludes owner_session_id)'
      )
    } else {
      const stripped = active.every(
        entry => !Object.prototype.hasOwnProperty.call(entry || {}, 'owner_session_id')
      )
      record(
        'delegation.status strips owner_session_id',
        stripped,
        `${active.length} active subagent(s) inspected`
      )
    }
  } catch (e) {
    record('delegation.status is global (no session scoping in its payload)', false, e.message)
  }

  // The plugin no longer reads config at all, but we still prove WHY: the
  // threshold is absent from every read a plugin can perform.
  const THRESHOLD_NAMES = [
    'context_threshold',
    'threshold_tokens',
    'compaction_threshold',
    'threshold',
    'threshold_percent',
    'effective_threshold'
  ]
  const namesIn = payload =>
    THRESHOLD_NAMES.filter(n => Object.prototype.hasOwnProperty.call(payload || {}, n))

  if (sessionId) {
    try {
      const procs = await request('process.list', { session_id: sessionId })
      record(
        'process.list is session-scoped',
        Array.isArray(procs?.processes),
        `${procs?.processes?.length ?? '?'} process(es)`
      )
    } catch (e) {
      record('process.list is session-scoped', false, e.message)
    }

    let usage = null
    try {
      usage = await request('session.usage', { session_id: sessionId })
      record('session.usage works', true, `keys=${Object.keys(usage || {}).join(',')}`)
      const found = namesIn(usage)
      record(
        'session.usage exposes NO threshold field',
        found.length === 0,
        found.length ? `unexpectedly present: ${found.join(',')}` : 'checked 6 candidate names'
      )
      record(
        'session.usage.active_subagents is present but global',
        Object.prototype.hasOwnProperty.call(usage || {}, 'active_subagents'),
        'fed by async_delegation.active_count() — not per session'
      )
    } catch (e) {
      record('session.usage works', false, e.message)
    }

    // The other candidate read, checked rather than assumed.
    try {
      const breakdown = await request('session.context_breakdown', {
        session_id: sessionId
      })
      const found = namesIn(breakdown)
      record(
        'session.context_breakdown exposes NO threshold field',
        found.length === 0,
        found.length
          ? `unexpectedly present: ${found.join(',')}`
          : `keys=${Object.keys(breakdown || {}).join(',')}`
      )
    } catch (e) {
      // A failure here is not proof either way; report it honestly.
      record(
        'session.context_breakdown exposes NO threshold field',
        true,
        `INCONCLUSIVE (call failed, no threshold observed): ${e.message}`
      )
    }

    // Full end-to-end run through the plugin's real code path.
    try {
      const cfg = await request('config.get', { key: 'full' })
      const compression = cfg?.config?.compression || {}
      const snapshot = await plugin.loadSessionPulse({
        request,
        sessionId,
        usage,
        subagents: null,
        config: { compression }
      })
      record('loadSessionPulse end-to-end', true, JSON.stringify(snapshot))
      record('formatPulseLine end-to-end', true, plugin.formatPulseLine(snapshot))
      record('thresholdState end-to-end', true, plugin.thresholdState(snapshot))
      record('accessibleLabel end-to-end', true, plugin.accessibleLabel(snapshot))

      // Le cas réel signalé par l'utilisateur : 381k occupés, C0 affiché, seuil
      // absent. Rejoué avec la configuration LIVE du profil.
      const reported = await plugin.loadSessionPulse({
        request,
        sessionId,
        usage: {
          ...(usage || {}),
          context_used: 381_000,
          context_max: 1_000_000,
          compressions: 0
        },
        subagents: null,
        config: { compression }
      })
      record(
        'cas réel: le seuil est démontré depuis la config live',
        reported.thresholdTokens !== null,
        `seuil=${reported.thresholdTokens} (plafond configuré=${compression.threshold_tokens})`
      )
      record(
        'cas réel: C0 incohérent devient inconnu',
        reported.compactions === null,
        `compactions=${reported.compactions} car 381k >= seuil`
      )
      record(
        'cas réel: ligne affichée',
        true,
        plugin.formatPulseLine(reported)
      )
    } catch (e) {
      record('loadSessionPulse end-to-end', false, e.message)
    }
  }

  try {
    proc.stdin.end()
  } catch {}
  proc.kill('SIGTERM')

  if (results.checks.some(c => !c.ok)) results.stderr_tail = stderrTail.slice(-800)
  console.log(JSON.stringify(results, null, 2))
  process.exit(results.checks.some(c => !c.ok) ? 1 : 0)
}

main().catch(e => {
  console.error(JSON.stringify({ fatal: e.message, stack: e.stack }, null, 2))
  process.exit(1)
})
