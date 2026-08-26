import assert from 'node:assert/strict'
import test from 'node:test'

import { loadPlugin } from './helpers/load-plugin.mjs'

/**
 * Le seuil de compaction n'est pas librement calculable, mais il est parfois
 * DÉMONTRABLE. Le runtime fait, dans l'ordre :
 *
 *   pct    = model_thresholds | compression.threshold | 0.50
 *   pct    = max(pct, 0.75) si la fenêtre < 512_000
 *   ratio  = max((fenêtre - max_tokens) * pct, 64_000)
 *   seuil  = min(ratio, compression.threshold_tokens)   <- un PLAFOND
 *
 * Seul `max_tokens` (la réserve de sortie du provider) est invisible. Or
 * `ratio` ne fait que DÉCROÎTRE quand `max_tokens` augmente. Donc si le
 * plafond est déjà inférieur au ratio calculé avec une réserve de sortie
 * généreuse, le plafond gagne pour toute valeur réelle : c'est une preuve,
 * pas une estimation.
 */

test('le plafond est affiché quand il gagne quelle que soit la réserve de sortie', async () => {
  const plugin = await loadPlugin()

  // Cas réel : fenêtre 1M, seuil 0.9, plafond 250k.
  // Le ratio reste au-dessus de 780k même avec 128k de réserve : le plafond gagne.
  const threshold = plugin.resolveThreshold({
    config: { compression: { threshold: 0.9, threshold_tokens: 250_000 } },
    contextMax: 1_000_000,
    model: 'claude-opus-5',
    usage: null
  })

  assert.equal(threshold, 250_000)
})

test('le seuil reste inconnu quand le plafond est trop proche du ratio', async () => {
  const plugin = await loadPlugin()

  // Plafond 850k : au-dessus du ratio du pire cas (~785k) mais en dessous du
  // ratio d'une petite réserve de sortie (~896k). C'est donc `max_tokens`,
  // inconnu, qui décide. On ne peut rien prouver.
  const threshold = plugin.resolveThreshold({
    config: { compression: { threshold: 0.9, threshold_tokens: 850_000 } },
    contextMax: 1_000_000,
    model: 'claude-opus-5',
    usage: null
  })

  assert.equal(threshold, null)
})

test('sans plafond configuré le seuil reste inconnu', async () => {
  const plugin = await loadPlugin()

  // Sans plafond, le résultat dépend directement de `max_tokens`.
  const threshold = plugin.resolveThreshold({
    config: { compression: { threshold: 0.9 } },
    contextMax: 1_000_000,
    model: 'claude-opus-5',
    usage: null
  })

  assert.equal(threshold, null)
})

test('un seuil rapporté par le runtime est toujours préféré', async () => {
  const plugin = await loadPlugin()

  const threshold = plugin.resolveThreshold({
    config: { compression: { threshold: 0.9, threshold_tokens: 250_000 } },
    contextMax: 1_000_000,
    model: 'claude-opus-5',
    usage: { threshold_tokens: 187_000 }
  })

  assert.equal(threshold, 187_000)
})

test('la compaction désactivée ne promet aucun seuil', async () => {
  const plugin = await loadPlugin()

  const threshold = plugin.resolveThreshold({
    config: {
      compression: { enabled: false, threshold: 0.9, threshold_tokens: 250_000 }
    },
    contextMax: 1_000_000,
    model: 'claude-opus-5',
    usage: null
  })

  assert.equal(threshold, null)
})

test('le plancher des petites fenêtres est appliqué avant la preuve', async () => {
  const plugin = await loadPlugin()

  // Fenêtre 128k : le runtime relève le pourcentage à 0.75 même si 0.50 est
  // configuré. Le plafond 40k reste bien en dessous du ratio, donc il gagne.
  const threshold = plugin.resolveThreshold({
    config: { compression: { threshold: 0.5, threshold_tokens: 40_000 } },
    contextMax: 128_000,
    model: 'claude-opus-5',
    usage: null
  })

  assert.equal(threshold, 40_000)
})

test('un plafond supérieur à la fenêtre est sans effet, donc non prouvable', async () => {
  const plugin = await loadPlugin()

  const threshold = plugin.resolveThreshold({
    config: { compression: { threshold: 0.9, threshold_tokens: 9_000_000 } },
    contextMax: 1_000_000,
    model: 'claude-opus-5',
    usage: null
  })

  assert.equal(threshold, null)
})

test('un seuil par modèle est pris en compte dans la preuve', async () => {
  const plugin = await loadPlugin()

  const threshold = plugin.resolveThreshold({
    config: {
      compression: {
        threshold: 0.9,
        threshold_tokens: 250_000,
        model_thresholds: { 'claude-opus': 0.5 }
      }
    },
    contextMax: 1_000_000,
    model: 'claude-opus-5',
    usage: null
  })

  // pct 0.5 -> ratio ~436k avec 128k de réserve : 250k reste prouvable.
  assert.equal(threshold, 250_000)
})
