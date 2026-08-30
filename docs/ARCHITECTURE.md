# Architecture

## Frontière

Le plugin est une contribution Desktop ESM sans compilation. Il ne lit pas directement `state.db`, les fichiers de session, les journaux, les secrets ou les transcriptions. Sa seule lecture de configuration passe par `config.get` et reste limitée au profil propriétaire de l'onglet.

## Flux visé

```text
onglet sélectionné
  -> identifiant de session focalisée
  -> lectures Gateway indépendantes
  -> normalisation vérité / inconnu
  -> instantané lié à cet identifiant
  -> ligne compacte + détail accessible
```

## Concurrence

Chaque instantané porte son identifiant de session. Une réponse n’est appliquée que si cet identifiant correspond encore à l’onglet sélectionné. Les lectures indépendantes utilisent une sémantique équivalente à `Promise.allSettled` afin de conserver les catégories fiables en cas d’échec partiel.

## Sources retenues

Vérifiées contre le code source du Gateway installé, pas déduites. Le détail et
les corrections apportées aux hypothèses initiales sont dans
[le contrat runtime](RUNTIME_CONTRACT.md).

- contexte actif, maximum, compactions : `host.state.focusedUsage`, l'usage
  diffusé de la session focalisée, sans aucune RPC ;
- processus : `process.list({ session_id })`, session-scopé par `session_key`.
  C'est la seule RPC session-scopée ; `config.get` lit la configuration du
  profil propriétaire ;
- sous-agents : flux d'événements `subagent.*`, session-scopé par construction.
  Aucune RPC de délégation n'est utilisable ici : `delegation.status` est globale
  et `list_active_subagents()` retire `owner_session_id`. Le comptage reste
  inconnu jusqu'à ce qu'un zéro global fiable prouve que rien ne tourne nulle
  part, sinon un historique partiel serait présenté comme un recensement ;
- seuil de compaction : valeur exacte du runtime quand elle est publiée ; sinon
  borne haute calculée depuis la configuration, affichée avec `≤` pour ne pas la
  confondre avec le seuil effectif.

## Absence de source

Si Hermes ne publie pas une donnée requise et qu'aucune borne sûre n'est
calculable, elle est affichée `—`. Un zéro n'est montré qu'après une réponse
fiable et vide. Aucun accès direct à un secret, à `state.db` ou au contenu de
conversation n'est autorisé, et aucune écriture n'a lieu : ni `slash.exec`, ni
`delegation.pause`, ni `process.kill`.
