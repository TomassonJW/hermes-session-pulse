# Contrat d’interface

## Classe de surface

Outil natif Hermes Desktop.

## Parcours principal

Regarder l’indicateur près du composeur de l’onglet sélectionné, puis cliquer seulement si une valeur demande une explication.

## Forme compacte

```text
42k / 96k / 128k · C3 · A2 · P1
```

Ordre stable : contexte actif, seuil de compaction, maximum modèle, compactions, sous-agents, processus.

## Détail au clic

Le panneau détaille les libellés en français courant :

- Contexte actif : valeur, nature mesurée ou estimée.
- Compaction prévue à : seuil effectif et règle appliquée.
- Limite du modèle : fenêtre maximale.
- Compactions : total de la conversation visible.
- Sous-agents : nombre actif/en attente.
- Processus : nombre actif/en attente.
- Dernière actualisation et éventuelles sources indisponibles.

Aucun prompt, objectif, commande, chemin privé ou contenu de conversation n’est affiché.

## États

- Sans session : aucun indicateur.
- Chargement initial : valeurs `—`, sans déplacement de mise en page.
- Donnée indisponible : `—` avec explication dans le détail.
- Inactif vérifié : `A0` ou `P0`.
- Près du seuil : accent visuel discret.
- Seuil atteint ou dépassé : avertissement, sans animation agressive.

## Accessibilité

- cible clavier native ;
- libellé complet lisible par lecteur d’écran ;
- information jamais portée uniquement par la couleur ;
- nombres tabulaires ;
- focus visible ;
- contraste hérité des variables de thème Hermes.

## Précédents examinés

- `context-meter` : retenu pour la proximité avec le composeur et le rattachement à la session focalisée ; rejet de la double jauge comme forme principale.
- `hermes-token-meter` : retenu pour le suivi de changement de session ; rejet de la dépendance à l’ancienne barre inférieure.
- `Hermes Agent Dock` : retenu comme précédent de vérité sur les sous-agents ; rejet du panneau complet, hors du besoin de lecture rapide.

## Décision locale

Le rendu initial vise la zone d’actions du composeur, sous réserve de confirmation du contrat public SDK courant. Aucun patch DOM ni modification du Desktop n’est autorisé.
