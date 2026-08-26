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

### 2. `COMPOSER_AREAS.underside` existe bel et bien

**Cette section corrigeait à tort le handoff. Le handoff avait raison.**

`COMPOSER_AREAS` expose `underside: 'composer.underside'`
(`apps/desktop/src/app/chat/composer/contrib.ts`), décrit dans le source comme
« floating strip BELOW the whole composer (no chrome) ». La constante est bien
réexportée aux plugins par `apps/desktop/src/sdk/index.ts`.

Une première version de ce document affirmait le contraire et plaçait le
composant sur `statusBar.right`. C'était faux : la conclusion venait d'une liste
partielle citée dans la documentation SDK, pas du source. Le composant est
maintenant sur `COMPOSER_AREAS.underside`, ce que `UI_CONTRACT.md` demandait
depuis le début.

Zones réelles : `top`, `bottom`, `underside`, `leading`, `actions`,
`middleware`, `attachments`, `microActions`, `atCompletions`.

Leçon : une énumération dans un document n'est pas le contrat. Seul le source
l'est.

### 3. Le seuil de compaction n'est pas dérivable

Aucune lecture accessible au plugin ne l'expose. Vérifié en live : ni
`session.usage` ni `session.context_breakdown` ne contiennent l'un des six noms
candidats.

Le repli `/context` est écarté : `_live_slash_command_output` ne sert `context`
directement que si `_session_uses_compute_host(session)` est vrai, sinon la
commande partait au worker. Lire une jauge ne doit pas exécuter une commande.

**Et la dérivation depuis la configuration est également écartée.** Une première
version reproduisait `compression.threshold` avec défaut 0,50 et présentait le
résultat comme le seuil. C'était un nombre faux affiché avec assurance, car la
résolution réelle (`agent/context_compressor.py`) fait davantage :

1. le pourcentage est **relevé à 0,75 pour toute fenêtre inférieure à 512 000**
   (`_effective_threshold_percent`) : un modèle 128k ne garde donc pas un 0,50
   configuré, contrairement à ce que ce document affirmait ;
2. le pourcentage s'applique à `context_length - max_tokens`, la réservation de
   sortie du provider, qu'aucune RPC n'expose ;
3. le résultat est planchéisé à `MINIMUM_CONTEXT_LENGTH`, avec un repli à 85 %
   pour les fenêtres dégénérées ;
4. `threshold_tokens` est appliqué comme **plafond** via `min()`
   (`_apply_threshold_tokens_cap`), pas comme vainqueur absolu ;
5. des relèvements par provider et les moteurs de contexte externes peuvent
   encore tout remplacer.

Une entrée manquante (`max_tokens`) suffit à rendre le calcul non reproductible.
Le plugin ne lit donc plus la configuration du tout : il n'affiche que le seuil
que le runtime lui donne, et `—` sinon. C'est la seule réponse honnête, et elle
respecte l'invariant du projet.

## Lectures retenues

| Donnée | Source | Portée onglet |
|---|---|---|
| Contexte actif, maximum, compactions | `host.state.focusedUsage` | oui, natif |
| Processus | `process.list({session_id})` | oui, `session_key` |
| Sous-agents | flux `subagent.*`, après baseline | oui, par événement |
| Seuil | uniquement si le runtime le rapporte | sinon `—` |

`host.state.focusedUsage` évite tout RPC pour les tokens : le Desktop diffuse
déjà l'usage de la session focalisée. `process.list` est la seule RPC émise.

## Baseline du comptage de sous-agents

Un historique d'événements n'est un recensement que si l'on sait qu'il a commencé
à zéro. Le plugin peut être chargé ou rechargé à chaud alors que des sous-agents
tournent déjà : un `subagent.tool` tardif pour un enfant jamais vu afficherait
alors `A1` alors que d'autres tournent sans être observés, et un
`subagent.complete` isolé produirait un `A0` mensonger.

Le comptage reste donc **inconnu** jusqu'à ce qu'un zéro global fiable
(`session.usage.active_subagents === 0`) prouve qu'aucun sous-agent ne tourne
nulle part. Ce zéro établit la baseline et, à chaque nouvelle occurrence, purge
les positifs périmés qu'un événement de fin perdu aurait laissés.

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

## Défauts trouvés par revue hostile indépendante

Une revue adverse en lecture seule a rendu un verdict **BLOCK** avec 12
constats. Elle avait raison sur les points matériels, y compris contre ce
document. Tous corrigés en TDD avec RED observé.

### Fuite entre onglets par `placeholderData` (critique)

`useQuery` était configuré avec `placeholderData: previous => previous`. React
Query sert alors le dernier résultat observé pendant le chargement de la nouvelle
clé : au changement d'onglet, les chiffres de l'onglet précédent s'affichaient
sous le nouvel onglet. C'était exactement la fuite que ce plugin existe pour
éviter.

Corrigé en retirant `placeholderData`. Un onglet en cours de chargement affiche
`—`. `tests/focus-isolation.test.mjs` invoque le composant réel et échoue si on
le réintroduit (vérifié en le remettant).

### Seuil faux affiché avec assurance (élevé)

Voir la section 3 ci-dessus. La dérivation depuis la configuration ne reproduit
ni le plancher 512k, ni la soustraction de `max_tokens`, ni la sémantique de
plafond de `threshold_tokens`. Elle est supprimée : le plugin n'affiche que ce
que le runtime rapporte.

### Comptage de sous-agents sans baseline (élevé)

Un historique partiel était présenté comme un recensement, et un
`subagent.complete` isolé produisait un faux `A0`. Voir la section baseline.

### Zéro global n'écrasait pas un positif périmé (élevé)

`countFor()` retournait la taille du `Set` avant de consulter le compteur
global ; un événement de fin perdu laissait donc `A1` affiché alors que le
compteur autoritaire disait zéro. Le zéro global purge maintenant tout.

### Modèle absent de la clé de requête (moyen)

Un changement de modèle qui laissait contexte et compactions identiques servait
l'ancienne valeur. `usage.model` fait désormais partie de la clé.

### Harnais de vérification complaisant (moyen)

Le harnais comptait comme preuve des affirmations non prouvées : n'importe quel
rejet, timeout inclus, validait « méthode absente » ; « global » était codé en
dur ; l'absence de `owner_session_id` dans un tableau vide ne prouvait rien ;
`session.context_breakdown` n'était jamais appelé. Corrigé : exigence d'une
erreur `unknown method` explicite, vérification de forme du payload, six noms
candidats testés sur les deux lectures, et marquage explicite `VACUOUS` quand
une preuve serait vide.

### Fuite mémoire du suivi de sous-agents

Trouvée avant la revue : le code s'abonnait à `session.closed`, qui **n'existe
pas** (le gateway émet `session.info`, `session.usage`, et `session.reclaimed`
seulement pour la récupération de sessions inactives). Le `Map` grossissait d'une
entrée par session vue. Le suivi est borné par LRU.

## Points restants, non corrigés

- **Routage par propriétaire d'onglet.** Le SDK expose
  `host.state.focusedSessionOwner` et `host.requestProfile(owner, ...)` parce que
  le focus d'une tuile peut changer sans changer le gateway actif. Le plugin
  utilise `host.request`, qui cible le socket du profil actif. Avec plusieurs
  profils ou connexions, la tuile focalisée peut appartenir à un autre
  propriétaire. Le suivi n'est pas non plus indexé par `(connectionId, profile,
  sessionId)`. Non corrigé : à traiter avec une vérification réelle multi-profils,
  pas à l'aveugle.
