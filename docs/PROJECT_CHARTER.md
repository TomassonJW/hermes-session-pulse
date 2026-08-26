# Contrat produit

## Mission

Permettre à une personne utilisant Hermes Desktop de connaître immédiatement la pression de contexte et les travaux enfants de la conversation visible, même lorsque plusieurs onglets sont ouverts.

## Invariant principal

L’identité de portée vient exclusivement de l’onglet sélectionné. Un changement d’onglet invalide les lectures précédentes et déclenche des lectures portant toutes le nouvel identifiant de session.

## Valeurs requises

1. Tokens actifs du contexte courant.
2. Seuil effectif de compaction de cette session.
3. Limite de contexte du modèle effectif.
4. Nombre de compactions du sujet visible.
5. Nombre de tâches de sous-agents actives ou en attente.
6. Nombre de processus enfants actifs ou en attente.

## Règles de vérité

- `0` signifie qu’une source autoritaire a confirmé l’absence d’activité.
- `—` signifie que la source est absente, incompatible, en erreur ou non qualifiée.
- Une estimation est identifiée comme telle dans le détail.
- Les résultats d’un ancien onglet ne peuvent jamais être promus dans le nouvel onglet.
- Les lots de délégation comptent leurs tâches, pas seulement leurs conteneurs.
- Les processus sont comptés depuis leur registre, pas depuis le texte de la conversation.

## Hors périmètre initial

- coût monétaire ;
- vitesse de génération ;
- commandes, objectifs ou contenu des sous-agents ;
- pilotage ou interruption depuis l’indicateur ;
- agrégation de toutes les sessions ;
- modification du code source de Hermes Desktop.

## Livraison

Un dépôt public MIT contenant le plugin, ses tests, son installation réversible, sa documentation et son pilotage GitHub.
