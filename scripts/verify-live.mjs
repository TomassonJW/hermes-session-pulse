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

  // The RPC the previous handoff assumed must NOT exist.
  try {
    await request('delegation.async_status', { session_id: sessionId || 'x' })
    record('delegation.async_status is absent', false, 'it answered — handoff would be right')
  } catch (e) {
    record('delegation.async_status is absent', true, `rejected: ${e.message}`)
  }

  // The global one that DOES exist — and why we cannot use it per tab.
  try {
    const del = await request('delegation.status', {})
    const keys = Object.keys(del || {})
    const strips = !JSON.stringify(del?.active || []).includes('owner_session_id')
    record('delegation.status exists but is global', true, `keys=${keys.join(',')}`)
    record('delegation.status strips owner_session_id', strips, 'cannot scope to a tab')
  } catch (e) {
    record('delegation.status exists but is global', false, e.message)
  }

  // The reads the plugin actually performs.
  let liveConfig = null
  try {
    const cfg = await request('config.get', { key: 'full' })
    liveConfig = cfg?.config || null
    const comp = liveConfig?.compression || {}
    record('config.get key=full works', true, `compression keys: ${Object.keys(comp).join(',')}`)
    record(
      'live config uses `threshold` not `threshold_percent`',
      Object.prototype.hasOwnProperty.call(comp, 'threshold'),
      `threshold=${comp.threshold}`
    )
    const derived = plugin.deriveThreshold({
      config: liveConfig,
      contextMax: 200_000,
      model: 'claude-opus-5'
    })
    record('deriveThreshold on LIVE config', derived !== null, `→ ${derived}`)
  } catch (e) {
    record('config.get key=full works', false, e.message)
  }

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
      record(
        'session.usage exposes NO threshold field',
        !('context_threshold' in (usage || {})) &&
          !('threshold_tokens' in (usage || {})),
        'threshold must be derived from config'
      )
    } catch (e) {
      record('session.usage works', false, e.message)
    }

    // Full end-to-end run through the plugin's real code path.
    try {
      const snapshot = await plugin.loadSessionPulse({
        request,
        sessionId,
        usage,
        subagents: null
      })
      record('loadSessionPulse end-to-end', true, JSON.stringify(snapshot))
      record('formatPulseLine end-to-end', true, plugin.formatPulseLine(snapshot))
      record('thresholdState end-to-end', true, plugin.thresholdState(snapshot))
      record('accessibleLabel end-to-end', true, plugin.accessibleLabel(snapshot))
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
