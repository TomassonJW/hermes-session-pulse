import assert from 'node:assert/strict'
import test from 'node:test'

import { loadPlugin } from './helpers/load-plugin.mjs'

/**
 * Le compteur de compactions du runtime ne vit qu'en mémoire
 * (context_compressor.py : `self.compression_count = 0` à la construction).
 * Une reprise de session ou un redémarrage le remet à zéro alors que la
 * conversation A bien été compactée.
 *
 * Ce zéro est donc parfois un mensonge, et il est détectable : si le contexte
 * occupé dépasse le seuil de compaction, au moins une compaction a forcément
 * eu lieu. Annoncer « C0 » dans ce cas est incohérent.
 */

test('un zéro contredit par le dépassement du seuil devient inconnu', async () => {
  const plugin = await loadPlugin()

  // Cas réel observé : 381k occupés, compaction à 250k, compteur à 0.
  const compactions = plugin.trustedCompactions({
    compactions: 0,
    activeTokens: 381_000,
    thresholdTokens: 250_000
  })

  assert.equal(compactions, null)
})

test('un zéro cohérent sous le seuil est conservé', async () => {
  const plugin = await loadPlugin()

  const compactions = plugin.trustedCompactions({
    compactions: 0,
    activeTokens: 120_000,
    thresholdTokens: 250_000
  })

  assert.equal(compactions, 0)
})

test('un compteur positif est toujours conservé', async () => {
  const plugin = await loadPlugin()

  // Même au-dessus du seuil : le compteur dit quelque chose de vrai, il est
  // seulement possiblement sous-évalué. On ne le jette pas.
  const compactions = plugin.trustedCompactions({
    compactions: 3,
    activeTokens: 381_000,
    thresholdTokens: 250_000
  })

  assert.equal(compactions, 3)
})

test('sans seuil connu le zéro ne peut pas être contredit', async () => {
  const plugin = await loadPlugin()

  const compactions = plugin.trustedCompactions({
    compactions: 0,
    activeTokens: 381_000,
    thresholdTokens: null
  })

  assert.equal(compactions, 0)
})

test('un compteur déjà inconnu le reste', async () => {
  const plugin = await loadPlugin()

  const compactions = plugin.trustedCompactions({
    compactions: null,
    activeTokens: 120_000,
    thresholdTokens: 250_000
  })

  assert.equal(compactions, null)
})

test('le contrôle de cohérence est appliqué par le chargement complet', async () => {
  const plugin = await loadPlugin()
  const request = async method => {
    if (method === 'process.list') return { processes: [] }
    throw new Error(`RPC inattendue ${method}`)
  }

  const snapshot = await plugin.loadSessionPulse({
    request,
    sessionId: 'onglet-a',
    usage: {
      context_used: 381_000,
      context_max: 1_000_000,
      compressions: 0,
      threshold_tokens: 250_000
    },
    subagents: null
  })

  assert.equal(snapshot.thresholdTokens, 250_000)
  assert.equal(snapshot.compactions, null, 'C0 au-dessus du seuil est incohérent')
})
