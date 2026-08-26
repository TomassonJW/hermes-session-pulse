# Contrat runtime vérifié

Toutes les affirmations ci-dessous sont vérifiées dans le code source du runtime
Hermes, pas déduites d'une documentation. Référence lue :
`project--2026-08-26--13-38--hermes--grok-canonical-runtime`.

Ce document corrige trois hypothèses du handoff du 26/08 14:21 qui étaient fausses.

## Corrections apportées au handoff

### 1. `delegation.async_status` n'existe pas

La méthode réelle est `delegation.status`
(`tui_gateway/methods_session.py:3349`). Elle ne prend **aucun** `session_id` et
retourne l'arbre global de sous-agents. Pire, `list_active_subagents()`
(`tools/delegate_tool.py:356`) retire explicitement `owner_session_id` de chaque
enregistrement.

Conséquence : **le nombre de sous-agents n'est pas filtrable par onglet via RPC.**
Un décompte pris là serait celui de toute l'application, pas celui de l'onglet
focalisé, ce qui violerait l'invariant de portée par onglet.

`session.usage` expose bien `active_subagents` (`tui_gateway/server.py:6140`),
mais il est alimenté par `async_delegation.active_count()`, un compteur **global**
lui aussi. `active_for_session(origin_ui_session_id)` existe
(`tools/async_delegation.py:627`) mais n'est exposé par aucune méthode RPC.

Décision : compter les sous-agents à partir du flux d'événements
`subagent.*`, qui est session-scopé par construction — chaque trame porte
`session_id` (`tui_gateway/server.py:2023`, `_event_frame`). On additionne les
démarrages et on retranche les fins pour la session focalisée. Le décompte
n'est affiché que lorsqu'il est fiable ; sinon `—`.

Renfort utile : lorsque le compteur global `active_subagents` vaut 0, aucune
session ne peut en avoir, donc 0 est vrai pour l'onglet focalisé. C'est la seule
inférence sûre que le compteur global autorise.

### 2. `COMPOSER_AREAS.underside` n'existe pas

Les zones réelles du composeur sont `top`, `bottom`, `leading`, `actions`,
`attachments`, `middleware`. Il n'y a pas de `underside`.

Décision : `statusBar.right`, cohérent avec le précédent `session-tokens` déjà
installé, qui est un chip de statut de la même nature. La bande sous le composeur
décrite dans `UI_CONTRACT.md` n'est pas réalisable sans modifier le Desktop, ce
que le contrat interdit.

### 3. Le seuil de compaction n'est exposé par aucune lecture accessible

`threshold_tokens` et `threshold_percent` vivent sur `agent.context_compressor`
et ne sont sérialisés ni par `session.usage`, ni par
`session.context_breakdown`, ni par `delegation.status`.

Le repli `/context` prévu par le handoff ne fonctionne pas non plus :
`_live_slash_command_output` ne sert `context` que si
`_session_uses_compute_host(session)` est vrai (`tui_gateway/server.py:14803`).
Pour une session locale ordinaire, `slash.exec /context` part au worker, ce qui
est une exécution réelle et non une lecture sans effet de bord. Le handoff
demandait explicitement une lecture sans mutation : ce chemin est donc écarté.

Décision : dériver le seuil de la configuration, qui est lisible sans effet de
bord via `config.get({ key: 'full' })`, en reproduisant la résolution du runtime :

1. `compression.threshold_tokens` s'il est défini — plafond absolu ;
2. sinon `compression.model_thresholds`, correspondance par sous-chaîne sur le
   nom du modèle, la clé la plus longue gagnant (`resolve_model_threshold`,
   `agent/context_compressor.py:2045`) ;
3. sinon `compression.threshold` ;
4. sinon 0,50.

Les noms de clés et la valeur par défaut viennent de `agent/agent_init.py:2101` :
`float(_compression_cfg.get("threshold", 0.50))`.

Piège vérifié sur la configuration réelle du profil actif : la clé est bien
`threshold` et non `threshold_percent`, et le défaut est 0,50 et non 0,75. Une
première implémentation lisait `threshold_percent` avec un défaut de 0,75 ; elle
retournait donc silencieusement une valeur fausse sur la configuration réellement
installée. Le test `the live configuration shape resolves to its absolute
ceiling` rejoue le bloc `compression` exact trouvé dans `config.yaml`.

La fraction est multipliée par `context_max`. Sans `context_max`, le seuil reste
inconnu.

Limite assumée : le runtime applique un plancher pour les très petites fenêtres
de contexte, que cette dérivation ne reproduit pas. Le seuil est donc présenté
comme dérivé, et le panneau de détail le dit en français courant. Pour les
modèles de 128k et plus, le plancher ne s'applique pas.

## Lectures retenues

| Donnée | Source | Portée onglet |
|---|---|---|
| Contexte actif, maximum, compactions | `host.state.focusedUsage` | oui, natif |
| Processus | `process.list({session_id})` | oui, `session_key` |
| Sous-agents | flux `subagent.*` + zéro global | oui, par événement |
| Seuil | `config.get({key:'full'})` + `context_max` | dérivé |

`host.state.focusedUsage` évite tout RPC pour les tokens : le Desktop diffuse
déjà l'usage de la session focalisée.

## Identité d'onglet

`host.state.focusedSessionId` est bien l'identité runtime de la tuile focalisée,
confirmée dans le SDK. C'est la seule clé utilisée. `activeSessionId` n'est pas
utilisé.

## Invariants de sécurité

- Aucune lecture de `state.db`, de transcription ou de secret.
- `config.get` ne sert qu'à lire le bloc `compression` ; rien d'autre n'est
  conservé ni affiché.
- Aucune mutation : pas de `slash.exec`, pas de `delegation.pause`, pas de
  `process.kill`.
