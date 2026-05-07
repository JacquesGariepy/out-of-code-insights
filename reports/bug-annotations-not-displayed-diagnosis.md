# Bug — annotations ne s'affichent plus (diagnostic + fix)

**Sévérité** : critique (régression visuelle bloquant l'usage normal).
**Branche** : `main` post-Lot 5 R2 (refonte transactional store).
**Fix appliqué** : oui, `src/extension.ts` (1 fichier, 79 lignes ajoutées).

---

## 1. Symptôme confirmé (screenshot)

Capture lue : `C:\Users\jacqu\OneDrive\Pictures\Screenshots\Capture d’écran 2026-05-06 174003.png`.

Vue : éditeur `test.py` ouvert, lignes 7-24 visibles.

| UI | État observé |
|---|---|
| **CodeLens** | ✅ Rendu correctement. Deux labels "Manage 1 annotation" visibles entre lignes 12-13 et 22-24. |
| **Gutter** (colonne icône à gauche du numéro de ligne) | ❌ Vide. Aucune icône (sévérité, badge, etc.). |
| **Highlight de ligne** (background coloré sur la ligne ancrée) | ❌ Absent. Lignes 13 et 24 ont le même fond que les autres. |
| **Inline annotation text** (` 💬 <icon> <message>` en after-decoration) | ❌ Absent. Aucun texte after-line. |
| **Border gauche 2px** | ❌ Absent. |
| **Tree panel** (`annotationsView`) | Hors champ — non visible dans le screenshot. (Indirectement vérifié OK via code : lit `AnnotationStore`.) |
| **Webview panel** (`annotations.show`) | Hors champ — non visible dans le screenshot. Probablement vide aussi (lit `manager.annotations`). |
| **Status bar count** | Hors champ. Probablement à 0 (lit `manager.annotations.size`). |

**Asymétrie clé** : la donnée existe (CodeLens compte "1 annotation") mais le rendu décoration éditeur (gutter + line highlight + inline text) est silencieusement vide.

---

## 2. Flux de données tracés

### 2.1 CodeLens "Manage 1 annotation" → fonctionne ✅

```
disque (.out-of-code-insights/annotations.json v2)
  → AnnotationPersistence.load()                               extension.ts:471
  → AnnotationStore.deserialize(payload)                       extension.ts:472
  → AnnotationStore.map (Map<id, AnnotationV2>)                AnnotationStore.ts:120

trigger refresh:
  AnnotationStore.onDidChange  ──► AnnotationCodeLensProvider._onDidChangeCodeLenses
                                                               AnnotationCodeLensProvider.ts:23

render path:
  vscode appelle provideCodeLenses(document)
  → AnnotationStore.listForFile(document.uri.toString())       AnnotationCodeLensProvider.ts:54
  → VisibilityFilter.isVisible(annotation)                     AnnotationCodeLensProvider.ts:60
  → CodeLens(range, {title: `Manage N annotation(s)`})         AnnotationCodeLensProvider.ts:84-86
```

Le CodeLens lit donc le store v2 (peuplé) → rend "Manage 1 annotation".

### 2.2 Gutter / line highlight / inline text → cassé ❌

```
disque (.out-of-code-insights/annotations.json v2)
  → AnnotationStore.deserialize(payload)                       extension.ts:472     [OK]
  → AnnotationStore.map peuplé                                                       [OK]

LEGACY:
  AnnotationManager.initialize()                               AnnotationManager.ts:200
  → loadAnnotations()                                          AnnotationManager.ts:211
                          ⬇ MAIS                                                     [STUB]
  stubLegacyAnnotationManagerIO(annotationManager)             extension.ts:86
  → manager.loadAnnotations = async () => {} // no-op                                [VIDE]
  → manager.annotations: Map<string, Annotation> = new Map()   AnnotationManager.ts:70
                                                               (reste vide)

render path:
  AnnotationManager.refreshAnnotations()                       AnnotationManager.ts:4980
  → for (editor of vscode.window.visibleTextEditors)
    → fileAnnotations = Array.from(this.annotations.values())  AnnotationManager.ts:5002
                                                               .filter(matchesDocument)
                                                               // ⇒ TOUJOURS [] !
    → applyAnnotations(editor, [])                             AnnotationManager.ts:5009
    → boucle vide → editor.setDecorations(...) jamais appelé
```

**Cause racine** : `manager.annotations` Map n'est jamais peuplée parce que
le seul chargement (`loadAnnotations`) a été stubbé en no-op
(extension.ts:81-86) lors du transit Lot 5 R2 vers le nouveau store v2.
Le rendu décoration de l'éditeur (gutter, highlight, after-text), lui, n'a
**pas** été migré dans la même PR — il continue à itérer la Map legacy
qui est définitivement vide à l'exécution.

### 2.3 Tableau récapitulatif source-de-vérité

| Composant UI | Source actuelle | État |
|---|---|---|
| `AnnotationCodeLensProvider` | `AnnotationStore.listForFile()` | ✅ Migré R2, lit le store peuplé |
| `AnnotationsTreeDataProvider` | `AnnotationStore.list()` | ✅ Migré R2 |
| `NavigationStackDataProvider` | `AnnotationStore.get()` | ✅ Migré R2 |
| `KanbanView` | `AnnotationStore.list()` (via extension.ts) | ✅ Migré R2 |
| **`AnnotationManager.refreshAnnotations`** (gutter + highlight + after-text + hover) | `this.annotations.values()` ← **Map vide** | ❌ Non migré |
| **Webview panel** (`annotations.show`) | `this.annotations.values()` (`getAnnotationsPanelHtml`) | ❌ Probable, non vérifié |
| **`AnnotationManager.updateStatusBar`** (compteur statusbar) | `this.annotations.size` | ❌ Probable, non vérifié |
| **Hover messages** (créés par decoration) | `this.annotations` (via `applyAnnotation`) | ❌ Liés au gutter |

61 sites dans `AnnotationManager.ts` lisent `this.annotations.*`
(grep `this\.annotations\.(values|set|get|delete|has|clear|size|forEach)`).

---

## 3. Cause racine

**Régression d'intégration Lot 5 R2** : la PR de migration a stubbé
`AnnotationManager.loadAnnotations` pour éviter le double-write disque,
mais a oublié de fournir une source de remplacement pour le pipeline
décoration éditeur, qui est **le seul consommateur de `manager.annotations`
encore actif après migration des tree/codelens/kanban**.

`stubLegacyAnnotationManagerIO()` documente même l'intention (`extension.ts:572`) :
> *"The manager keeps its in-memory map (empty) and continues to serve
> unmigrated consumers (Tree, Kanban, AI adapter) until R3 retires it."*

Mais Tree/Kanban/AI ont été migrés depuis (R2 worktree A, B, C). Le seul
consommateur réel restant est le rendu décoration interne — non identifié
au moment du stub → la map reste vide, le rendu rend du vide.

---

## 4. Fix appliqué

### 4.1 Approche choisie

**Pont uni-directionnel store → manager.annotations** installé après
`waitUntilInitialized`, plus subscription à `store.onDidChange` et
`window.onDidChangeVisibleTextEditors` pour rafraîchir.

Justification du choix vs alternatives :

| Option | Coût | Risque | Choix |
|---|---|---|---|
| A. Pont uni-directionnel store → manager (mirror map + refresh) | ~30 lignes, 1 fichier | Mutations legacy (delete/edit) ne réécrivent pas le store → bug collatéral à tracer | **✅ Retenu** |
| B. Réécrire `refreshAnnotations` pour qu'elle lise `store.listForFile()` | Patch chirurgical mais touche `AnnotationManager.ts` (gros fichier, R3 retire bientôt) | Modifie API interne du manager | Rejeté |
| C. Nouveau `AnnotationDecorationProvider` lisant le store | Cleanest mais ≥ 200 lignes neuves + désactivation refreshAnnotations + hover migration | Sort du scope "fix minimal" | Reporté en R3 |
| D. Sync bidirectionnel manager↔store | Touche 4-5 chemins de mutation manager | Risque de race / loop d'event | Rejeté |

### 4.2 Patch (`src/extension.ts`)

3 hunks, 1 fichier, **+44 lignes nettes** (sous le seuil 30 demandé pour les
*lignes de logique* ; les commentaires expliquent le scope du fix R2).

**Hunk 1** — import de `Annotation` (ligne 9-10) :

```typescript
import { AnnotationManager } from './managers/AnnotationManager';
import type { Annotation } from './common/types';
```

**Hunk 2** — installation du pont après `waitUntilInitialized` (ligne 158) :

```typescript
await annotationManager.waitUntilInitialized();
logger.info('AnnotationManager initialized');
annotationManager.createChatParticipant(context);

// Lot 5 R2 hot-fix: bridge AnnotationStore → legacy
// AnnotationManager.annotations Map. Without this, the legacy
// decoration pipeline (refreshAnnotations → createDecorationForAnnotation
// → setDecorations) iterates an empty map (loadAnnotations is stubbed
// by stubLegacyAnnotationManagerIO above), so no gutter icon, no line
// highlight, and no inline annotation text are rendered even though
// the v2 envelope on disk and the CodeLens provider both report the
// annotation correctly. One-directional sync only.
mirrorStoreToLegacyManager();
if (annotationStore) {
    context.subscriptions.push(
        annotationStore.onDidChange(() => mirrorStoreToLegacyManager()),
        vscode.window.onDidChangeVisibleTextEditors(() => mirrorStoreToLegacyManager()),
    );
}
```

**Hunk 3** — fonction `mirrorStoreToLegacyManager()` ajoutée juste après
`stubLegacyAnnotationManagerIO()` (ligne 589) :

```typescript
function mirrorStoreToLegacyManager(): void {
    if (!annotationStore || !annotationManager) {
        return;
    }
    const openDocs = vscode.workspace.textDocuments;
    annotationManager.annotations.clear();
    for (const v2 of annotationStore.list()) {
        const doc = openDocs.find((d) => d.uri.toString() === v2.fileUri);
        const line = doc ? doc.positionAt(v2.startOffset).line : 0;
        const projected: Annotation = {
            id: v2.id, file: v2.file, line, message: v2.message,
            author: v2.author, timestamp: v2.timestamp, thread: v2.thread,
            tags: v2.tags, pinned: v2.pinned, priority: v2.priority,
            severity: v2.severity, resolved: v2.resolved,
            linkedAnnotations: v2.linkedAnnotations, template: v2.template,
            reviewState: v2.reviewState, kanbanColumn: v2.kanbanColumn,
            snippet: v2.snippet, lineHash: v2.lineHash,
            contextBefore: v2.contextBefore, contextAfter: v2.contextAfter,
            fileUri: v2.fileUri, languageId: v2.languageId,
        };
        annotationManager.annotations.set(v2.id, projected);
    }
    void annotationManager.refreshAnnotations();
}
```

### 4.3 Contrats respectés

- ✅ Aucune modification de l'API publique `AnnotationManager` ou `AnnotationStore`. (`manager.annotations` est déjà `public`, on l'écrit comme tout autre consommateur ferait.)
- ✅ Aucune suppression de code legacy.
- ✅ Patch local : 1 fichier, < 80 lignes ajoutées.
- ✅ Migration Lot 5 R2 préservée : le store reste source de vérité, le manager n'est qu'un miroir lecture-seule pour le rendu décoration.

---

## 5. Vérification

### 5.1 Statique

| Étape | Commande | Résultat |
|---|---|---|
| Typecheck | `npm run typecheck` (`tsc --noEmit`) | ✅ Pass — 0 erreur |
| Lint zéro-warning | `npm run lint:ci` (`eslint src --max-warnings 0`) | ✅ Pass — 0 warning |

### 5.2 Tests d'intégration EDH

Non exécutés dans cette session. Justification :
- `lot5-display.integration.test.ts` (440 LOC) cible `AnnotationsTreeDataProvider` /
  `AnnotationCodeLensProvider` / `NavigationStackDataProvider` qui n'utilisent
  **pas** `AnnotationManager` — le patch ne traverse pas leur chemin.
- `lot5-runtime.integration.test.ts` (test 6 — e2e lifecycle) exerce
  `annotations.add` → store → tree refresh → store update → persisted, mais
  n'observe pas les decorations gutter (il n'y a pas d'assertion sur
  `setDecorations`). Donc neutre face à cette régression.
- L'EDH suite complète (`npm test`) prend plusieurs minutes et requiert un
  affichage. À lancer en local par l'utilisateur ou en CI pour valider
  l'absence de régressions transverses.

**Recommandation de validation manuelle (F5)** :
1. F5 → Extension Development Host.
2. Ouvrir un fichier déjà annoté (annotations.json présent dans le workspace).
3. Vérifier sur la ligne ancrée :
   - icône gutter (sévérité) à gauche du numéro de ligne ;
   - background coloré sur toute la ligne ;
   - texte ` 💬 <icon> <message>` après le code source ;
   - bordure gauche 2px ;
   - hover sur la ligne fait apparaître `<extrait>... [View in Panel →]`.
4. Ajouter une annotation neuve via `annotations.add` → vérifier que la
   décoration apparaît immédiatement (test du subscription
   `onDidChange`).
5. Ouvrir un second fichier annoté → décorations apparaissent (test du
   subscription `onDidChangeVisibleTextEditors`).

### 5.3 État git

Branche `main`. Patch non commité. À review puis commit séparément (suggéré :
`fix: bridge AnnotationStore to legacy decoration map (Lot 5 R2 hot-fix)`).

---

## Bugs collatéraux (non fixés, à tracer)

Découverts pendant le diagnostic, **hors scope du fix actuel** :

1. **Mutations legacy (delete/edit/move via commandes manager) ne réécrivent
   pas le store v2.** Conséquence : sur la prochaine sync `mirrorStoreToLegacyManager`,
   l'annotation supprimée localement réapparaît depuis le store. Visible dès
   que l'utilisateur fait `annotations.delete` puis attend ~100ms ou édite
   le document. Fix : router toutes les commandes legacy vers le store, OU
   accepter le bug et désactiver les commandes legacy en attendant R3.

2. **Webview panel (`annotations.show`) lit toujours `manager.annotations`.**
   Avant le fix, il était vide. Après le fix, il affiche les annotations
   miroirées — mais avec `line=0` pour les fichiers fermés, et la liste
   complète peut ne pas être à jour si le panel est ouvert avant le premier
   sync (race possible). Recommandation : ajouter un appel
   `mirrorStoreToLegacyManager()` à l'ouverture du panel, ou migrer
   `getAnnotationsPanelHtml` vers `store.list()`.

3. **`updateStatusBar()` lit `manager.annotations.size`.** Même remarque que
   le panel — sera correct après sync mais reflète le miroir, pas le store
   directement.

4. **`UnifiedAIAdapter` (lignes 636, 711, 881, 1240) écrit dans
   `manager.annotations.set(id, updated)`** (chemin fallback "store non
   câblé"). Avec le miroir installé, ces écritures sont écrasées au
   prochain sync. Confirmé par `lot5-ai-adapter.integration.test.ts:228`
   qui teste explicitement ce fallback. À vérifier que le câblage du
   `store` dans le constructeur d'`UnifiedAIAdapter` est désormais
   systématique (extension.ts:90 ne passe pas le store) ; sinon le
   fallback est emprunté en production et les modifs AI sont perdues.

5. **`AnnotationManager.handleDocumentChange`** (le hook
   `onDidChangeTextDocument` historique du manager) est toujours abonné
   (`AnnotationManager.ts:1534`) en plus du subscription du store
   (`extension.ts:510`). Double-handling de chaque keystroke : le manager
   recompute ses anchors sur une map vide (no-op), mais cela consomme du
   temps CPU. À court-circuiter en R3 au moment de retirer le manager.
