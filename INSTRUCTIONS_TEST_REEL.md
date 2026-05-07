# Instructions de test reel -- Out-of-Code Insights

Extension : **Out-of-Code Insights** v1.0.18 (publisher : jacquesgariepy)

Ce document guide le test manuel de chaque circonstance de suivi d'annotations.
Chaque circonstance couvre une situation ou le code bouge et verifie que
l'annotation suit correctement.

> **Retrocompatibilite** : les fichiers `annotations.json` existants (sans champ
> `lineHash`) sont charges sans modification visible. A l'ouverture du document,
> l'extension capturera silencieusement l'ancre (`lineHash`, `contextBefore`,
> `contextAfter`) pour chaque annotation legacy et l'ecrira en place. Zero
> regression : les annotations anciennes continuent d'apparaitre exactement comme
> avant, et beneficient immediatement du suivi robuste pour la prochaine
> circonstance.

---

## Philosophie : annotation = couche virtuelle qui herite du destin de la ligne

Une annotation est une couche virtuelle posee sur une ligne de code. Elle n'a pas
d'existence propre : elle suit le destin de la ligne a laquelle elle est ancree,
exactement comme le ferait n'importe quel autre attribut de cette ligne dans VS Code.

| Circonstance            | Comportement natif VS Code              | Comportement annotation                                                      |
| ----------------------- | --------------------------------------- | ---------------------------------------------------------------------------- |
| Insertion au-dessus     | Les lignes suivantes decalent           | L'annotation decale avec elles                                               |
| Suppression de la ligne | Ligne disparait -- Ctrl+Z restaure      | Annotation disparait silencieusement, buffer 5s, Ctrl+Z ou paste la restaure |
| Cut + paste             | Ligne bouge                             | Annotation suit vers la nouvelle position (buffer 5s)                        |
| Copy + paste            | Ligne dupliquee                         | Prompt Yes/No : dupliquer l'annotation a la nouvelle position ?              |
| Drag-and-drop (panneau) | Reordonnancement liste                  | Ligne mise a jour, anchor recapture                                          |
| Undo/redo               | Etat restaure                           | Annotation revient avec sa ligne                                             |
| Edition externe         | Fichier modifie, VS Code propose reload | `findAnchor` relocalise l'annotation par hash + contexte                     |
| Rename fichier          | Fichier renomme                         | `annotation.file` mis a jour automatiquement                                 |

---

## Prerequis

1. Ouvrir ce depot dans VS Code.
2. Lancer `npm install` dans le terminal integre si `node_modules/` est absent.
3. S'assurer que le projet compile : `npm run compile` (ou `npm run typecheck`
   pour la verification de types seule).

---

## Lancement F5

Deux configurations sont disponibles dans `.vscode/launch.json` :

| Configuration                           | Usage recommande                                                       |
| --------------------------------------- | ---------------------------------------------------------------------- |
| **Run Extension**                       | Ouvre une fenetre VS Code vide -- pour tester dans votre propre projet |
| **Run Extension (with test workspace)** | Ouvre `test-fixtures/` comme workspace -- **recommande pour ce guide** |
| **Extension Tests**                     | Lance la suite de tests d'integration VS Code                          |

**Etapes pour F5 :**

1. Ouvrir la palette de commandes (`Ctrl+Shift+P`) et choisir
   **"Debug: Select and Start Debugging"**, ou appuyer sur `F5`.
2. Selectionner **"Run Extension (with test workspace)"**.
3. Une nouvelle fenetre VS Code (Extension Development Host) s'ouvre avec le
   dossier `test-fixtures/` comme workspace.
4. Dans cette fenetre, ouvrir `sample.ts`.
5. L'annotation pre-existante sur la ligne 7 (`multiply`) apparait avec
   migration silencieuse : son `lineHash` est capture automatiquement.

Pour arreter la session : fermer la fenetre Extension Development Host ou
appuyer sur le carre rouge dans la barre de debogage.

---

## Circonstance 1 : INSERTION au-dessus de l'annotation

**Objectif** : verifier que l'annotation se deplace vers le bas quand des lignes
sont inserees au-dessus d'elle.

**Etapes** :

1. Dans la fenetre Extension Development Host, ouvrir `sample.ts`.
2. Verifier que l'annotation est visible sur la ligne 7 (fonction `multiply`).
3. Placer le curseur sur la ligne 1 et appuyer sur `Entree` trois fois pour
   inserer 3 lignes vides au-dessus.
4. Observer la gouttiere (gutter) et le panneau "Annotations".

**Comportement attendu** : l'annotation passe de la ligne 7 a la ligne 10.
Elle reste attachee a la ligne `return a * b;` (via `lineHash`). Aucune
annotation n'est perdue.

**Verification** : ouvrir `.out-of-code-insights/annotations.json` -- le champ
`"line"` doit etre mis a jour a 10 (base zero si applicable).

---

## Circonstance 2 : INSERTION en dessous de l'annotation

**Objectif** : verifier que l'annotation ne bouge pas quand des lignes sont
inserees apres elle.

**Etapes** :

1. L'annotation est sur la ligne 7 (`multiply`).
2. Placer le curseur a la fin du fichier et appuyer sur `Entree` deux fois.

**Comportement attendu** : l'annotation reste sur la ligne 7. Le decalage
arithmetique ne s'applique pas aux lignes inserees apres l'annotation.

---

## Circonstance 3 : SUPPRESSION de la ligne ancree -- silencieux + buffer 5s

**Objectif** : verifier que l'annotation disparait silencieusement de la gouttiere
quand sa ligne est supprimee, et qu'elle peut etre recuperee via Ctrl+Z ou paste.

**Etapes -- suppression simple puis Ctrl+Z** :

1. L'annotation est sur la ligne 7 (`return a * b;`).
2. Selectionner la ligne 7 entierement (`Ctrl+L`).
3. Appuyer sur `Delete` ou `Backspace` pour supprimer la ligne.
4. **Comportement immediat** : l'annotation disparait de la gouttiere et du panneau
   sans aucun dialog ni toast. Elle est placee dans un buffer interne de 5 secondes.
5. Appuyer sur `Ctrl+Z` dans les 5 secondes.
6. **Comportement attendu** : la ligne est restauree (comportement VS Code natif) et
   l'annotation reapparait automatiquement -- le buffer detecte le contenu reinseree
   via son `lineHash` et restaure l'annotation silencieusement.

**Etapes -- suppression sans Ctrl+Z (expiry dialog apres 5s)** :

1. L'annotation est sur la ligne 7.
2. Supprimer la ligne 7 (`Ctrl+L` puis `Delete`).
3. Attendre plus de 5 secondes sans coller ni annuler.
4. Effectuer n'importe quelle frappe pour declencher un evenement document.
5. **Comportement attendu** : une dialog apparait :

    > **"1 cut annotation(s) were not pasted within the clipboard window.
    > What do you want to do?"**
    >
    > [ Delete annotation ] [ Keep at nearest line ] [ Cancel ]

**Test du bouton "Delete annotation"** :

- Cliquer sur **"Delete annotation"**.
- Comportement attendu : l'annotation est supprimee definitivement.

**Test du bouton "Keep at nearest line"** :

- Recommencer (supprimer, attendre 5s+, declench un evenement).
- Cliquer sur **"Keep at nearest line"**.
- Comportement attendu : l'annotation est deplacee a la ligne adjacente la plus
  proche. Elle reste visible dans le panneau.

**Test du bouton "Cancel"** :

- Recommencer, cliquer sur **"Cancel"** (ou `Echap`).
- Comportement attendu : l'annotation est restauree a sa position (meme si la
  ligne originale a disparu -- elle reste "flottante" jusqu'a la prochaine action).

---

## Circonstance 4 : CUT + PASTE intra-fichier

**Objectif** : verifier que l'annotation suit un bloc deplace par couper-coller
dans le meme fichier.

**Etapes** :

1. L'annotation est sur la ligne 7 (`return a * b;`).
2. Selectionner les lignes 7-9 (la fonction `multiply` complete).
3. Couper (`Ctrl+X`).
4. Placer le curseur a la ligne 1.
5. Coller (`Ctrl+V`) dans les 5 secondes.

**Comportement attendu** : le cut place l'annotation dans le buffer interne
(`recentDeletions`). Le paste (evenement d'insertion) est compare au `lineHash`
stocke : le contenu correspond, l'annotation est restauree silencieusement a la
nouvelle position (debut du fichier). Le `lineHash` et le contexte sont recaptures.
Aucun dialog n'apparait -- la recuperation est transparente.

**Si le paste est effectue apres 5 secondes** : voir Circonstance 3 (expiry dialog).

---

## Circonstance 5 : COPY + PASTE -- prompt de duplication

**Objectif** : verifier que l'extension propose de dupliquer l'annotation quand
le contenu copie contient une ligne ancree.

**Prerequis** : le bloc colle doit contenir au moins 2 lignes non vides pour que
la detection s'active (guard anti-faux-positifs).

**Etapes** :

1. L'annotation est sur la ligne 7 (`return a * b;`).
2. Selectionner les lignes 7-9 (la fonction `multiply`, au moins 2 lignes).
3. Copier (`Ctrl+C`).
4. Placer le curseur au debut du fichier et coller (`Ctrl+V`).
5. **Comportement attendu** : une notification apparait :

    > **"An annotation was found in the pasted block. Copy it to the new location?"**
    >
    > [ Yes ] [ No ]

**Test "Yes"** :

- Cliquer sur **"Yes"**.
- Comportement attendu : une nouvelle annotation est creee a la position collee.
  L'annotation originale reste sur la ligne 7. Les deux annotations coexistent.

**Test "No"** :

- Recommencer, cliquer sur **"No"**.
- Comportement attendu : aucune nouvelle annotation. L'annotation originale reste
  seule sur la ligne 7.

**Note** : la detection ne s'active que si le texte colle correspond exactement
au contenu du presse-papiers OS (guard clipboard). Les insertions par frappe,
auto-completion, et Enter ne declenchent jamais ce prompt.

---

## Circonstance 6 : DRAG-AND-DROP

**Objectif** : verifier que l'annotation suit une reorganisation via drag-and-drop
dans le panneau "Annotations".

**Etapes** :

1. Ouvrir le panneau "Annotations" via `Ctrl+Shift+P` > **"Show Annotations Panel"**.
2. Si plusieurs annotations existent dans le fichier, en glisser une vers
   une nouvelle position dans la liste du panneau.

**Comportement attendu** : l'annotation est reordonnee. Sa position `line` est
mise a jour et son `lineHash`/contexte est recapture pour refleter la nouvelle
ligne dans le document.

> **Note** : le drag-and-drop dans le panneau reordonne les annotations par
> index dans la liste (pas par numero de ligne document). L'anchor est mis a
> jour via `setAnnotationLine` ; la recapture complete du `lineHash` interviendra
> au prochain evenement `onDidChangeTextDocument` ou `onDidOpenTextDocument`.

---

## Circonstance 7 : UNDO + REDO

**Objectif** : verifier que les annotations restent coherentes apres plusieurs
cycles undo/redo.

**Etapes** :

1. L'annotation est sur la ligne 7.
2. Inserer 3 lignes au-dessus (ligne 1). L'annotation passe a la ligne 10.
3. Annuler l'insertion (`Ctrl+Z`). L'annotation doit revenir a la ligne 7.
4. Refaire (`Ctrl+Y` ou `Ctrl+Shift+Z`). L'annotation doit repasser a 10.
5. Alterner undo/redo 5 fois rapidement.

**Comportement attendu** : chaque evenement `onDidChangeTextDocument` (que ce
soit undo ou redo) passe par le meme pipeline de decalage arithmetique. Le
`lineHash` est valide apres chaque operation. Aucune annotation n'est perdue
ou doublee.

---

## Circonstance 8 : EDITION EXTERNE (Notepad / editeur externe)

**Objectif** : verifier que les annotations se reancrent apres une modification
faite hors de VS Code.

**Etapes** :

1. Fermer `sample.ts` dans la fenetre Extension Development Host.
2. Ouvrir `test-fixtures/sample.ts` dans le Bloc-notes (Notepad) ou un autre
   editeur externe.
3. Inserer 5 lignes vides au debut du fichier.
4. Sauvegarder depuis l'editeur externe.
5. Revenir dans VS Code et rouvrir `sample.ts`.

**Comportement attendu** : VS Code detecte la modification externe et propose de
recharger le fichier. A l'ouverture, le listener `onDidOpenTextDocument` entre en
action :

- Pour chaque annotation, `lineHash` est compare au contenu actuel de la ligne.
- Si la ligne 7 ne correspond plus au hash stocke, `findAnchor` cherche le contenu
  dans tout le document par contexte.
- Si trouve (ligne 12 apres l'insertion de 5 lignes), `annotation.line` est mis
  a jour vers 12.
- Si non trouve (edition trop destructrice), l'annotation reste en drift mais
  n'est pas supprimee silencieusement.

> **Note** : ce comportement necessite que le fichier ait ete ouvert au moins
> une fois dans VS Code depuis l'ajout de l'annotation (pour que le snapshot
> initial soit cree). Les annotations legacy sans `lineHash` sont migrees
> silencieusement a la premiere ouverture.

---

## Circonstance 9 : REFACTOR -- renommage de symbole LSP

**Objectif** : verifier que les annotations restent en place apres un rename
de symbole via le LSP TypeScript.

**Etapes** :

1. L'annotation est sur la ligne 7 (`return a * b;`).
2. Placer le curseur sur le nom de la fonction `multiply` (ligne 7 de la
   definition, ligne 3 dans `sample.ts`).
3. Appuyer sur `F2` pour renommer le symbole. Entrer `multiplyNumbers`.
4. Valider.

**Comportement attendu** : VS Code applique le rename via une serie de
`TextEdit`. Ces modifications passent par `onDidChangeTextDocument` (meme
pipeline que les insertions normales). Si la ligne de l'annotation n'est pas
touchee par le rename, elle ne bouge pas. Si la ligne est modifiee (ex. mise
a jour d'un commentaire inline), le `lineHash` est recalcule via le pipeline
et l'annotation reste ancree par contexte.

---

## Circonstance 10 : RENAME de fichier

**Objectif** : verifier que les annotations suivent le fichier renomme.

**Etapes** :

1. Dans l'explorateur de fichiers VS Code, faire un clic droit sur
   `sample.ts` > **"Rename"**.
2. Renommer en `sample_renamed.ts`.
3. Valider.

**Comportement attendu** : `handleFileRename` met a jour `annotation.file` de
`"sample.ts"` vers `"sample_renamed.ts"` dans toutes les annotations
concernees. Les annotations sont sauvegardees automatiquement. Elles continuent
d'apparaitre sur le bon fichier.

**Verification** : ouvrir `.out-of-code-insights/annotations.json` -- le champ
`"file"` doit contenir `"sample_renamed.ts"`.

---

## Verification globale de retrocompatibilite

L'annotation pre-chargee dans `test-fixtures/.out-of-code-insights/annotations.json`
est une annotation **legacy** (format existant, sans `lineHash`) :

```json
{
    "id": "moqn0eym0uvq9smc1m9o",
    "file": "sample.ts",
    "line": 7,
    "message": "ok",
    "author": "Anonymous",
    "timestamp": "2026-05-04T03:25:57.310Z"
}
```

Au lancement F5, cette annotation doit :

1. Apparaitre normalement dans la gouttiere de `sample.ts` ligne 7.
2. Etre migree silencieusement (le `lineHash` est capture et ecrit en place).
3. Beneficier immediatement du suivi robuste pour toutes les circonstances
   documentees ci-dessus.

Aucun message d'erreur, aucune perte de donnee, aucune incompatibilite.

---

## Commandes disponibles

Toutes ces commandes sont accessibles via `Ctrl+Shift+P` dans la fenetre
Extension Development Host :

| Commande                         | Titre                           |
| -------------------------------- | ------------------------------- |
| `annotations.add`                | Add Annotation                  |
| `annotations.delete`             | Delete Annotation               |
| `annotations.edit`               | Edit Annotation                 |
| `annotations.show`               | Show Annotations Panel          |
| `annotations.navigate`           | Navigate to Annotation          |
| `annotations.moveUp`             | Move Annotation Up              |
| `annotations.moveDown`           | Move Annotation Down            |
| `annotations.toggleDisplay`      | Toggle Annotations Display      |
| `annotations.exportJSON`         | Export Annotations to JSON      |
| `annotations.importJSON`         | Import Annotations from JSON    |
| `annotations.pinToggle`          | Toggle Annotation Pin           |
| `annotations.setSeverity`        | Set Annotation Severity         |
| `annotations.keywordSearch`      | Keyword Search in Annotations   |
| `annotations.showKanban`         | Show Kanban Board               |
| `annotations.startReview`        | Start Review Mode               |
| `annotations.stopReview`         | Stop Review Mode                |
| `annotations.nextAnnotation`     | Next Annotation                 |
| `annotations.previousAnnotation` | Previous Annotation             |
| `outOfCodeInsights.showLogs`     | Out-of-Code Insights: Show Logs |

---

## Statut d'implementation par circonstance

| Circonstance                              | Mecanisme code                                  | Statut |
| ----------------------------------------- | ----------------------------------------------- | ------ |
| Insertion au-dessus/dessous               | Decalage arithmetique par `contentChanges`      | CABLE  |
| Suppression (buffer 5s + expiry dialog)   | `recentDeletions` + `showExpiredDeferralDialog` | CABLE  |
| Cut + paste (buffer 5s)                   | `recentDeletions` + recuperation par `lineHash` | CABLE  |
| Copy + paste (prompt Yes/No)              | `detectAndPromptCopyPaste` + clipboard guard    | CABLE  |
| Drag-and-drop panneau                     | `setAnnotationLine` dans `AnnotationsTree.ts`   | CABLE  |
| Undo/redo                                 | Meme pipeline `onDidChangeTextDocument`         | CABLE  |
| Edition externe                           | `handleDocumentOpen` + `findAnchor`             | CABLE  |
| Move Up / Move Down                       | `setAnnotationLine` + doc ouvert                | CABLE  |
| Rename fichier                            | `handleFileRename` + snapshot key migree        | CABLE  |
| Retrocompatibilite legacy (sans lineHash) | Migration silencieuse a l'open                  | CABLE  |

**Tests unitaires** : 38/38 passent (mocha, sans hote VS Code).
**typecheck** : 0 erreur TypeScript.
**Em-dash** : aucun trouve dans src/ et INSTRUCTIONS_TEST_REEL.md.
