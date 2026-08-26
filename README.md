# Hermes Session Pulse

A compact status chip for Hermes Desktop that reports on **the focused
conversation tab only**.

```text
42k / 96k / 128k · C3 · A2 · P1
```

| Field | Meaning |
|---|---|
| `42k` | tokens currently occupying the context window |
| `96k` | tokens at which auto-compaction is expected |
| `128k` | the model's context limit |
| `C3` | compactions so far in this conversation |
| `A2` | subagents currently active for this tab |
| `P1` | background processes currently running for this tab |

## The one rule

**An unknown value is shown as `—`, never as `0`.** A zero appears only after a
source answered reliably and was genuinely empty. This distinction is the whole
point: a status indicator that quietly renders "I don't know" as "nothing is
happening" is worse than no indicator at all.

The same discipline applies per tab. Everything displayed belongs to
`host.state.focusedSessionId`, the runtime identity of the focused tile.
Switching tabs starts a new query rather than re-rendering the previous tab's
numbers.

## Install

Copy `plugin.js` into your Hermes desktop plugins directory, keeping the folder
name equal to the plugin id:

```bash
mkdir -p ~/.hermes/desktop-plugins/hermes-session-pulse
cp plugin.js ~/.hermes/desktop-plugins/hermes-session-pulse/plugin.js
```

The desktop app watches that directory and loads the plugin within a few
seconds; later saves hot-reload it. If it does not appear, run **Reload desktop
plugins** from the command palette (⌘K). Under a named profile the path is
`~/.hermes/profiles/<profile>/desktop-plugins/`.

No build step: the file is a plain ESM module, so it uses `jsx()` calls rather
than JSX syntax.

## How each value is obtained

The runtime contract was verified against the Hermes gateway source rather than
assumed, and then re-checked by an adversarial review that caught real mistakes.
The reasoning, including the claims that turned out to be wrong, is recorded in
[`docs/RUNTIME_CONTRACT.md`](docs/RUNTIME_CONTRACT.md):

- **Context, limit, compactions** come from `host.state.focusedUsage`, the
  usage the desktop already streams for the focused session. No RPC needed.
- **Processes** come from `process.list({ session_id })`, which is genuinely
  session-scoped (it matches on the registry's `session_key`). This is the only
  RPC the plugin issues.
- **Subagents** are counted from the `subagent.*` event stream, because every
  gateway event frame carries its own `session_id`. They cannot be obtained per
  tab over RPC: `delegation.status` takes no session id, and
  `list_active_subagents()` explicitly strips `owner_session_id`.
  The count stays unknown until a reliable global zero
  (`session.usage.active_subagents === 0`) proves nothing is running anywhere —
  otherwise a plugin that loaded mid-flight would report a partial history as a
  complete census.
- **The compaction threshold** is shown **only if the runtime reports it**, and
  reads `—` otherwise. It deliberately is not derived from config: the real
  resolution raises the percentage to 75% for any window under 512K, applies it
  to `context_length - max_tokens` (a value no plugin can read), floors it, and
  treats `threshold_tokens` as a *cap* rather than a winner. Reproducing that
  from config produces a confident wrong number, which is worse than admitting
  ignorance. See issue #2.

## What it will not do

- No mutation of any kind: no `slash.exec`, no `delegation.pause`, no
  `process.kill`, no `config.set`.
- No reads of `state.db`, transcripts, prompts, or secrets. The plugin does not
  read your configuration at all; `process.list` is its only RPC.
- No conversation content, subagent goal, command line, or private path is ever
  rendered.
- No hardcoded colors: only Hermes theme variables, so it follows your theme.

## Accessibility

The compact line is decorative shorthand; the full sentence is what assistive
technology receives, so no information depends on decoding `C3 · A2 · P1` or on
color alone. Numbers are tabular so the chip does not jitter as values change.

## Development

Requires Node.js 20 or newer. There are no runtime dependencies.

```bash
npm test     # unit tests
npm run check   # syntax check + unit tests
```

The suite covers the pure logic (formatting, threshold derivation, the subagent
tracker, snapshot assembly) and the plugin's registration contract. The SDK is
stubbed with exactly the identifiers `plugin.js` imports, so a typo in an import
fails the suite instead of becoming a `ReferenceError` at render time.

### Verifying against a real gateway

Unit tests cannot prove that an RPC name or payload shape is real. This does:

```bash
PULSE_PLUGIN_PATH=$PWD/plugin.js \
  node --experimental-vm-modules scripts/verify-live.mjs
```

It spawns a real Hermes gateway, loads the actual `plugin.js`, and drives its
own code path against live JSON-RPC. It requires an explicit `unknown method`
rejection before it will call `delegation.async_status` absent, and it checks six
candidate field names on both `session.usage` and `session.context_breakdown`
before it will call the threshold unexposed. Where a check would be vacuous, it
says so rather than reporting a pass. It is read-only and sends no message to any
model.
A recorded run is in
[`docs/evidence/live-gateway-verification.json`](docs/evidence/live-gateway-verification.json).

## License

MIT — see [LICENSE](LICENSE).
