import assert from 'node:assert/strict'
import test from 'node:test'

import { loadPlugin } from './helpers/load-plugin.mjs'

/**
 * Le bloc `compression` de la configuration alimente la démonstration du
 * seuil. Il était lu par une requête SÉPARÉE, mise en cache cinq minutes et
 * sans réessai utile : un seul échec au montage (socket du gateway pas encore
 * ouverte, changement de profil en cours) laissait le seuil inconnu
 * durablement, alors que la donnée était disponible une seconde plus tard.
 *
 * La lecture appartient donc au chargement de l'instantané, qui se rafraîchit
 * toutes les cinq secondes : un échec transitoire se répare tout seul.
 */

test('le seuil est résolu par le chargement de l’instantané, sans configuration fournie', async () => {
  const plugin = await loadPlugin()
  const calls = []
  const request = async (method, params) => {
    calls.push(method)
    if (method === 'process.list') return { processes: [] }
    if (method === 'config.get') {
      assert.equal(params.key, 'full')
      return { config: { compression: { threshold: 0.9, threshold_tokens: 250_000 } } }
    }
    throw new Error(`RPC inattendue ${method}`)
  }

  const snapshot = await plugin.loadSessionPulse({
    request,
    sessionId: 'onglet-a',
    usage: { context_used: 131_000, context_max: 1_000_000, compressions: 1 }
  })

  assert.ok(calls.includes('config.get'), 'la configuration doit être lue ici')
  assert.equal(snapshot.thresholdTokens, 250_000)
  assert.equal(snapshot.compactions, 1)
})

test('un échec de lecture de la configuration laisse le reste intact', async () => {
  const plugin = await loadPlugin()
  const request = async method => {
    if (method === 'process.list') return { processes: [] }
    throw new Error('gateway indisponible')
  }

  const snapshot = await plugin.loadSessionPulse({
    request,
    sessionId: 'onglet-a',
    usage: { context_used: 131_000, context_max: 1_000_000, compressions: 1 }
  })

  // Le seuil est inconnu, mais aucune autre valeur n'est perdue.
  assert.equal(snapshot.thresholdTokens, null)
  assert.equal(snapshot.activeTokens, 131_000)
  assert.equal(snapshot.maxTokens, 1_000_000)
  assert.equal(snapshot.processes, 0)
})

test('un échec transitoire se répare au rafraîchissement suivant', async () => {
  const plugin = await loadPlugin()
  let attempt = 0
  const request = async method => {
    if (method === 'process.list') return { processes: [] }
    if (method === 'config.get') {
      attempt += 1
      // Le premier appel échoue, comme une socket pas encore ouverte.
      if (attempt === 1) throw new Error('gateway indisponible')
      return { config: { compression: { threshold: 0.9, threshold_tokens: 250_000 } } }
    }
    throw new Error(`RPC inattendue ${method}`)
  }

  const args = {
    request,
    sessionId: 'onglet-a',
    usage: { context_used: 131_000, context_max: 1_000_000, compressions: 1 }
  }

  const first = await plugin.loadSessionPulse(args)
  assert.equal(first.thresholdTokens, null, 'premier essai: échec honnête')

  const second = await plugin.loadSessionPulse(args)
  assert.equal(second.thresholdTokens, 250_000, 'le rafraîchissement doit réparer')
})

test('la configuration lue est réutilisée sans être redemandée à chaque tick', async () => {
  const plugin = await loadPlugin()
  let configCalls = 0
  const request = async method => {
    if (method === 'process.list') return { processes: [] }
    if (method === 'config.get') {
      configCalls += 1
      return { config: { compression: { threshold: 0.9, threshold_tokens: 250_000 } } }
    }
    throw new Error(`RPC inattendue ${method}`)
  }

  const args = {
    request,
    sessionId: 'onglet-a',
    usage: { context_used: 131_000, context_max: 1_000_000, compressions: 1 }
  }

  await plugin.loadSessionPulse(args)
  await plugin.loadSessionPulse(args)
  await plugin.loadSessionPulse(args)

  assert.equal(configCalls, 1, 'un seul appel: le bloc est mis en cache après succès')
})
