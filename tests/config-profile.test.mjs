import assert from 'node:assert/strict'
import test from 'node:test'

import { loadPlugin } from './helpers/load-plugin.mjs'

/**
 * Deux défauts découverts en conditions réelles, après que le seuil est resté
 * introuvable malgré une logique de démonstration correcte.
 *
 * 1. Une réponse VALIDE mais sans bloc `compression` était mémorisée comme un
 *    succès définitif. Or les profils secondaires de ce poste n'ont aucun bloc
 *    `compression` : une seule lecture adressée au mauvais profil condamnait
 *    l'affichage du seuil pour toute la durée de vie du plugin, sans jamais
 *    réessayer, même après un retour sur le bon profil.
 *
 * 2. `loadSessionPulse` ne portait aucune identité de profil. La lecture
 *    partait vers la passerelle ACTIVE, qui n'est pas nécessairement celle qui
 *    possède l'onglet affiché.
 *
 * Un bloc absent est désormais traité comme une absence de réponse utile : rien
 * n'est mémorisé, et le tick suivant réessaie.
 */

test('un bloc compression absent n’est pas mémorisé comme un succès', async () => {
  const plugin = await loadPlugin()
  let attempt = 0
  const request = async method => {
    if (method === 'process.list') return { processes: [] }
    if (method === 'config.get') {
      attempt += 1
      // Premier appel : profil sans bloc compression (cas réel des profils
      // secondaires de ce poste).
      if (attempt === 1) return { config: {} }
      return { config: { compression: { threshold: 0.9, threshold_tokens: 250_000 } } }
    }
    throw new Error(`RPC inattendue ${method}`)
  }

  const args = {
    request,
    sessionId: 'onglet-a',
    usage: { context_used: 154_000, context_max: 1_000_000, compressions: 1 }
  }

  const first = await plugin.loadSessionPulse(args)
  assert.equal(first.thresholdTokens, null, 'aucun plafond lisible au premier essai')

  // Le tick suivant doit REESSAYER, pas resservir un vide mémorisé.
  const second = await plugin.loadSessionPulse(args)
  assert.equal(
    second.thresholdTokens,
    250_000,
    'un bloc absent doit être réessayé, pas mémorisé définitivement'
  )
})

test('un bloc compression lu avec succès est bien mémorisé', async () => {
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
    usage: { context_used: 154_000, context_max: 1_000_000, compressions: 1 }
  }

  await plugin.loadSessionPulse(args)
  await plugin.loadSessionPulse(args)
  await plugin.loadSessionPulse(args)

  assert.equal(configCalls, 1, 'un succès reste mémorisé, pas de lecture à chaque tick')
})

test('la raison d’un seuil inconnu est exposée pour le diagnostic', async () => {
  const plugin = await loadPlugin()
  const request = async method => {
    if (method === 'process.list') return { processes: [] }
    throw new Error('gateway indisponible')
  }

  await plugin.loadSessionPulse({
    request,
    sessionId: 'onglet-a',
    usage: { context_used: 154_000, context_max: 1_000_000, compressions: 1 }
  })

  const reason = plugin.__lastConfigError()
  assert.ok(reason, 'un échec silencieux est indiagnosticable')
  assert.match(reason, /gateway indisponible/)
})

test('une réponse sans bloc compression est décrite, pas avalée', async () => {
  const plugin = await loadPlugin()
  const request = async method => {
    if (method === 'process.list') return { processes: [] }
    if (method === 'config.get') return { config: {} }
    throw new Error(`RPC inattendue ${method}`)
  }

  await plugin.loadSessionPulse({
    request,
    sessionId: 'onglet-a',
    usage: { context_used: 154_000, context_max: 1_000_000, compressions: 1 }
  })

  const reason = plugin.__lastConfigError()
  assert.ok(reason, 'la forme reçue doit être décrite')
  assert.match(reason, /compression/)
})

test('la lecture est adressée au profil propriétaire quand il est fourni', async () => {
  const plugin = await loadPlugin()
  const seen = []
  const request = async (method, params) => {
    seen.push([method, params?.profile ?? null])
    if (method === 'process.list') return { processes: [] }
    if (method === 'config.get') {
      return { config: { compression: { threshold: 0.9, threshold_tokens: 250_000 } } }
    }
    throw new Error(`RPC inattendue ${method}`)
  }

  const snapshot = await plugin.loadSessionPulse({
    request,
    sessionId: 'onglet-a',
    usage: { context_used: 154_000, context_max: 1_000_000, compressions: 1 },
    profile: 'default'
  })

  assert.equal(snapshot.thresholdTokens, 250_000)
  // Les deux lectures doivent viser le profil propriétaire de l'onglet, pas la
  // passerelle active par défaut.
  for (const [method, profile] of seen) {
    assert.equal(profile, 'default', `${method} doit porter le profil propriétaire`)
  }
})

test('le cache de configuration est cloisonné par profil', async () => {
  const plugin = await loadPlugin()
  const request = async (method, params) => {
    if (method === 'process.list') return { processes: [] }
    if (method === 'config.get') {
      // Seul `default` porte un plafond ; les profils secondaires n'en ont pas.
      if (params?.profile === 'default') {
        return { config: { compression: { threshold: 0.9, threshold_tokens: 250_000 } } }
      }
      return { config: {} }
    }
    throw new Error(`RPC inattendue ${method}`)
  }

  const usage = { context_used: 154_000, context_max: 1_000_000, compressions: 1 }

  const secondary = await plugin.loadSessionPulse({
    request,
    sessionId: 'onglet-b',
    usage,
    profile: 'ui-studio'
  })
  assert.equal(secondary.thresholdTokens, null, 'ce profil n’a pas de plafond')

  // Le vide du profil secondaire ne doit pas contaminer `default`.
  const primary = await plugin.loadSessionPulse({
    request,
    sessionId: 'onglet-a',
    usage,
    profile: 'default'
  })
  assert.equal(primary.thresholdTokens, 250_000, 'le cache ne doit pas fuir entre profils')
})
