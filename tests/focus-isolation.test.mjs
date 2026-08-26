import assert from 'node:assert/strict'
import test from 'node:test'

import { loadPlugin } from './helpers/load-plugin.mjs'

/**
 * The core invariant: a focus switch must never render the previous tab's
 * numbers under the new tab. React Query's `placeholderData: previous =>
 * previous` does exactly that — it serves the last observer result while the
 * new query key loads — so it must not be used here.
 *
 * These tests drive the real component function with a controllable useQuery
 * stub, so they assert behaviour rather than merely grepping the source.
 */
const harness = ({ focusedSessionId, focusedUsage = null }) => {
  const queryCalls = []
  const sdk = {
    host: {
      state: {
        focusedSessionId: 'atom:sid',
        focusedUsage: 'atom:usage',
        focusedSessionProfile: 'atom:profile'
      },
      request: async () => ({}),
      onEvent: () => () => {}
    },
    useValue: atom => {
      if (atom === 'atom:sid') return focusedSessionId
      if (atom === 'atom:usage') return focusedUsage
      if (atom === 'atom:profile') return 'default'
      return undefined
    },
    useQuery: options => {
      queryCalls.push(options)
      // Simulate a pending fetch for a newly-focused tab: React Query would
      // return undefined data unless placeholderData supplies something.
      const data = options.placeholderData
        ? options.placeholderData({
            activeTokens: 999_000,
            thresholdTokens: 999_000,
            maxTokens: 999_000,
            compactions: 99,
            subagents: 99,
            processes: 99
          })
        : undefined
      return { data }
    }
  }
  return { queryCalls, sdk }
}

const renderChip = async ({ focusedSessionId, focusedUsage }) => {
  const { queryCalls, sdk } = harness({ focusedSessionId, focusedUsage })
  const plugin = await loadPlugin({ sdk })
  const contributions = []
  plugin.default.register({ register: c => contributions.push(c) })

  // `render()` returns a React element descriptor: { type: Component, props }.
  // Invoke the component function itself so we exercise its real body.
  const descriptor = contributions[0].render()
  const element = descriptor.type(descriptor.props)
  return { element, queryCalls, plugin }
}

test('a pending tab shows unknowns, never the previous tab’s numbers', async () => {
  const { element } = await renderChip({
    focusedSessionId: 'tab-new',
    focusedUsage: null
  })

  // Tip → span; the rendered text must not contain the other tab's 999k.
  const rendered = JSON.stringify(element)
  assert.doesNotMatch(rendered, /999/, 'previous tab data leaked into the new tab')
  assert.match(rendered, /—/, 'a pending tab must render unknown markers')
})

test('the query does not opt into cross-tab placeholder data', async () => {
  const { queryCalls } = await renderChip({
    focusedSessionId: 'tab-new',
    focusedUsage: null
  })

  // Aucune des requêtes (configuration et instantané) ne doit resservir le
  // résultat précédent lors d'un changement d'onglet.
  assert.ok(queryCalls.length >= 1)
  for (const options of queryCalls) {
    assert.equal(
      options.placeholderData,
      undefined,
      'placeholderData resservirait le résultat de l’onglet précédent'
    )
  }
})

test('the focused session id is part of the query key', async () => {
  const { queryCalls } = await renderChip({
    focusedSessionId: 'tab-abc',
    focusedUsage: { context_used: 10, context_max: 100 }
  })

  // La requête de l'instantané est celle qui porte l'identité de l'onglet ; la
  // requête de configuration est volontairement partagée entre les onglets.
  const scoped = queryCalls.filter(options => options.queryKey.includes('tab-abc'))
  assert.equal(
    scoped.length,
    1,
    'sans identifiant de session dans la clé, deux onglets partageraient un cache'
  )
})

test('nothing renders when no tab is focused', async () => {
  const { element } = await renderChip({ focusedSessionId: null, focusedUsage: null })

  assert.equal(element, null)
})
