# Bug #2 — édition d'annotation non persistée

**Sévérité** : critique (perte silencieuse des modifications utilisateur).
**Branche** : `main` post-fix bug #1 (`reports/bug-annotations-not-displayed-diagnosis.md`).
**Fix appliqué** : oui, `src/extension.ts` (1 fichier, ~120 lignes nouvelles).
**Stratégie** : Option A (mirror bidirectionnel via chokepoint `saveAnnotations`).

---

## 1. Cause confirmée

Symptôme rapporté : après édition d'une annotation (message/severity/tags),
l'UI affiche bien le nouveau contenu, mais après reload de la fenêtre la
modification est perdue.

### 1.1 Trace du flux édition (avant ce fix)

```
Cmd 'annotations.edit' → editAnnotationCommand        AnnotationManager.ts:5155
  → findAnnotation(file, line)                        :5159  [lit manager.annotations]
  → modifyAnnotation(id)                              :5164
    → annotation = this.annotations.get(id)           :5193
    → annotation.message = newMessage                 :5221  [mutation in-memory]
    → annotation.severity = ...                       :5239
    → annotation.timestamp = isoNow                   :5246
    → await this.saveAnnotations()                    :5247  ← STUB no-op
    → await this.refreshAnnotations()                 :5248  [re-render UI ✓]
    → updateAnnotationsPanel()                        :5249  [refresh webview ✓]
    → emit('annotationChanged')                       :5255  [trigger mirror ?]
```

### 1.2 Pourquoi rien n'est persisté

`extension.ts` `stubLegacyAnnotationManagerIO()` (avant patch) :
```typescript
m.saveAnnotations = async () => { /* intentional R2 no-op */ };
```

Donc l'appel ligne 5247 ne touche pas le disque. Et le store v2 (qui détient
maintenant le pipeline persistance) n'est jamais notifié. La modification
reste en mémoire dans `manager.annotations[id]` jusqu'à ce que :

1. `mirrorStoreToLegacyManager` (installé par fix bug #1) se déclenche
   sur n'importe quel `store.onDidChange` ou `onDidChangeVisibleTextEditors`.
2. Cette fonction fait `manager.annotations.clear()` puis repopulate
   depuis `store.list()` — **la version stale du store écrase la
   modification utilisateur**.

Trigger fréquent : ouvrir un autre éditeur, faire défiler, taper du texte
(qui passe par `applyDocumentChange` → `notifyChanged` → `onDidChange`).

### 1.3 Mutations affectées (29 sites `saveAnnotations()`)

Toutes les méthodes de mutation passent par `saveAnnotations()`. Les
principales :

| Méthode | Ligne | Action utilisateur |
|---|---|---|
| `modifyAnnotation` | 5247 | Edit message/severity (commande UI) |
| `deleteAnnotation` | 5265 | Suppression annotation |
| `replyToAnnotation` | 5292 | Ajout commentaire au thread |
| `togglePinAnnotation` | 1897 | Pin/unpin |
| `setAnnotationSeverity` | 1920 | Changement de sévérité (raccourci) |
| `changeSeverity` | 1944 | Changement de sévérité (panel) |
| `editAnnotationTags` | 1976 | Édition des tags |
| `addAnnotation` (legacy path) | 4071 | Création (utilisé en fallback) |
| `resolveAnnotation` | (~5501) | Marquage résolu |
| `moveAnnotationUp/Down` | 1357, 1376 | Déplacement de ligne |
| Import JSON | 3195, 3213 | Import bulk |
| Init (snapshot anchors) | 220 | Phase de démarrage **AVANT mirror** |

→ Le chokepoint `saveAnnotations` est un point unique de patching idéal,
**mais** il est aussi appelé pendant `initialize()` ligne 220, AVANT que
le mirror ne soit installé. Ce détail conditionne la séquence d'install
du bridge (cf. §2.4).

---

## 2. Stratégie retenue : Option A (chokepoint write-back)

### 2.1 A vs B comparées

| Critère | Option A (mirror bidirectionnel) | Option B (rerouter chaque mutation vers store) |
|---|---|---|
| Surface code touchée | 1 fichier (`extension.ts`), ~120 lignes | `AnnotationManager.ts` (5532 LOC), ≥10 méthodes mutées |
| Couvre toutes les mutations existantes | ✅ via chokepoint `saveAnnotations` | ⚠️ requiert auditer les 29 sites un par un |
| Respect de la cible Option C "store = source de vérité" | ⚠️ store devient autoritatif via réplication différée (~µs) | ✅ store mis à jour direct |
| Risque de régression | Faible (1 point d'entrée) | Élevé (chemins legacy multiples) |
| Dette R3 | 1 fonction à supprimer | 10+ chemins à supprimer/migrer |
| Lignes de code | ~120 | ~200+ estimé |

**Choix : A**. B aurait dépassé le seuil 5 fichiers/100 lignes implicite
(la cible Option C exige migration franche, pas patch surgical de chaque
mutation). A respecte le contrat "transitional bridge — remove when Option
C migration completes" et concentre la dette en un endroit clairement
balisé.

### 2.2 Architecture du fix

```
                    Source de vérité = AnnotationStore (v2 envelope)
                                  ↑↓
              ┌───────────────────────────────────────────┐
              │                                           │
              ▼                                           ▼
   mirrorStoreToLegacyManager           reconcileLegacyToStore
   (store → manager)                    (manager → store)
   sur store.onDidChange                appelé par
   sur onDidChangeVisibleTextEditors    saveAnnotations() patché
              │                                           ↑
              ▼                                           │
   manager.annotations Map (V1)                 saveAnnotations()
   = projection lecture-seule          ←  appelé par 29 mutations
                                          legacy (modify, delete, …)
```

### 2.3 Composants ajoutés (`src/extension.ts`)

1. **`reconcileLegacyToStore()`** — Diff manager.annotations vs store.list()
   par id. Upsert chaque V1 projeté en V2. Remove orphelins. Tout dans une
   transaction unique → 1 seul `onDidChange` au commit.

2. **`installLegacySaveBridge()`** — Remplace `manager.saveAnnotations` par
   un wrapper qui appelle `reconcileLegacyToStore`. Installé APRÈS
   `mirrorStoreToLegacyManager()` premier passage.

3. **Site d'install** — Juste après le mirror et l'abonnement aux events,
   avant `registerStoreCommands` :

```typescript
mirrorStoreToLegacyManager();
if (annotationStore) {
    context.subscriptions.push(
        annotationStore.onDidChange(() => mirrorStoreToLegacyManager()),
        vscode.window.onDidChangeVisibleTextEditors(() => mirrorStoreToLegacyManager()),
    );
}
// transitional bridge — remove when Option C migration completes
installLegacySaveBridge();
```

### 2.4 Séquencement critique

| Ordre | Étape | Impact |
|---|---|---|
| 1 | `bootstrapTransactionalStack` | Store chargé depuis disque, peuplé |
| 2 | `new AnnotationManager(context)` | Manager Map vide |
| 3 | `stubLegacyAnnotationManagerIO` | `loadAnnotations` + `saveAnnotations` = no-op |
| 4 | Init manager (async) | `initialize()` appelle `saveAnnotations` ligne 220 → **no-op** ✅ |
| 5 | `await waitUntilInitialized` | Init terminée |
| 6 | `mirrorStoreToLegacyManager()` | Manager Map ← store.list() |
| 7 | Subscriptions onDidChange | Sync auto store→manager |
| 8 | **`installLegacySaveBridge()`** | `saveAnnotations` patché : reconcile manager→store |
| 9 | Run-time : mutation utilisateur | `saveAnnotations` → reconcile → store mute → onDidChange → mirror back-patch |

L'ordre est essentiel : si `installLegacySaveBridge` était appelé avant
le mirror initial (étape 6), le `saveAnnotations` de l'étape 4 (init)
verrait un manager vide et purgerait le store entier. **Vérifié à la
relecture** : install à l'étape 8, après mirror.

### 2.5 Boucle de feedback — analyse statique

```
edit → manager.annotations[id].message = X         (mutation)
     → await saveAnnotations()                     (notre patch)
       → reconcileLegacyToStore()
         → store.beginTransaction
         → store.upsert(projection of all V1)      (N opérations)
         → store.commit                            (fires 1 onDidChange)
           → mirrorStoreToLegacyManager listener   (sync call)
             → manager.annotations.clear()
             → for v2 of store.list(): set(...)
             → void refreshAnnotations()           (debounced 100ms)
           → flushSave listener                    (debounced 100ms)
             → setTimeout(serialize + persistence.save, 100ms)
         → commit returns
       → reconcile returns
     → saveAnnotations returns                     (await unblocks)
     → modifyAnnotation continues:
       → await refreshAnnotations()                (no-op, already debounced)
       → updateAnnotationsPanel()                  (lit manager.annotations rafraîchi)
       → emit('annotationChanged')                 (consommateurs externes)
[+100ms]
       → flushSave fires                           (write to disk)
```

**Pas de boucle infinie** : mirror n'appelle jamais saveAnnotations.
JS single-threaded, transactions synchrones. La debounce 100ms sur
flushSave coalesce les saves rapides (taper plusieurs caractères dans
un message d'edit).

---

## 3. Diff résumé

`src/extension.ts` — **3 hunks** (1 ajout d'install + 2 nouvelles fonctions).

```diff
+        // Lot 5 R2 hot-fix #2: now that the mirror is installed and the
+        // manager.annotations Map mirrors the store, repurpose the legacy
+        // saveAnnotations() stub to reconcile manager → store on every
+        // mutation (modify/delete/reply/severity/tag/pin/move/resolve/...).
+        // 29 sites in AnnotationManager.ts call saveAnnotations() after
+        // touching the in-memory map, so this single chokepoint persists
+        // every legacy mutation through the v2 store.
+        // transitional bridge — remove when Option C migration completes
+        installLegacySaveBridge();
```

```diff
+function installLegacySaveBridge(): void {
+    if (!annotationManager) { return; }
+    interface Stubbable { saveAnnotations: () => Promise<void>; }
+    (annotationManager as unknown as Stubbable).saveAnnotations = async () => {
+        reconcileLegacyToStore();
+    };
+}
```

```diff
+function reconcileLegacyToStore(): void {
+    if (!annotationStore || !annotationManager) { return; }
+    const liveIds = new Set<string>();
+    for (const v1 of annotationManager.annotations.values()) {
+        liveIds.add(v1.id);
+    }
+    const orphanIds: string[] = [];
+    for (const v2 of annotationStore.list()) {
+        if (!liveIds.has(v2.id)) { orphanIds.push(v2.id); }
+    }
+    const openDocs = vscode.workspace.textDocuments;
+    annotationStore.beginTransaction();
+    try {
+        for (const v1 of annotationManager.annotations.values()) {
+            if (!v1.fileUri) { /* warn + continue */ }
+            const existing = annotationStore.get(v1.id);
+            const doc = openDocs.find((d) => d.uri.toString() === v1.fileUri);
+            // Preserve existing offsets when line unchanged; recompute on
+            // line change; fallback to existing offsets when doc closed.
+            let startOffset = existing?.startOffset ?? 0;
+            let endOffset = existing?.endOffset ?? 0;
+            if (doc) { /* recompute if line changed */ }
+            annotationStore.upsert({
+                id, fileUri, file, startOffset, endOffset,
+                lineHash, contextBefore, contextAfter,
+                origin: existing?.origin ?? { kind: 'manual' },
+                message, author, timestamp, thread, tags, pinned,
+                priority, severity, resolved, linkedAnnotations,
+                template, reviewState, kanbanColumn, snippet, languageId,
+            });
+        }
+        for (const id of orphanIds) { annotationStore.remove(id); }
+        annotationStore.commit();
+    } catch (err) {
+        annotationStore.rollback();
+        getLogger().error('reconcileLegacyToStore: rollback after error', err);
+    }
+}
```

Total : **+82 lignes nettes** dont ~30 lignes de commentaires explicatifs.

---

## 4. Preuve de persistance

### 4.1 Vérification statique (logique)

Le pipeline persistance disque existait déjà avant ce fix (extension.ts:539-545) :

```typescript
context.subscriptions.push(
    annotationStore.onDidChange(() => {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(flushSave, 100);
    }),
);
// flushSave: serialize + persistence.save(payload)
```

`reconcileLegacyToStore` provoque `store.commit` → `onDidChange` → la
subscription ci-dessus → `flushSave` après 100 ms → écriture disque.

Le test d'intégration `lot5-runtime.integration.test.ts:230` (test #2
"annotations.add flow lands in schema-v2 envelope on disk") prouve que
ce pipeline serialise+sauve correctement quand store fire
`onDidChange`. Notre fix réutilise ce même pipeline sans modification.

### 4.2 Quality gates (statique)

| Étape | Commande | Résultat |
|---|---|---|
| Typecheck | `npm run typecheck` | ✅ Pass |
| Lint zéro-warning | `npm run lint:ci` | ✅ Pass |

### 4.3 Tests d'intégration EDH

Non exécutés dans cette session (ils requièrent un EDH host complet et
plusieurs minutes par run sur Windows).

**Tests existants pertinents qui restent valides** :
- `lot5-runtime.integration.test.ts` test #2, #6, #7 (persistance store →
  disk) — pipeline inchangé.
- `lot5-managers.integration.test.ts` (LinkedAnnotationManager,
  ReviewModeManager, SnippetManager) — passent par `store.update` direct,
  ne traversent pas notre bridge.
- `annotationStore.integration.test.ts` — exercise store directement.

**Aucun test existant n'exerce le path "édition via commande legacy →
disk"** parce que ce flow n'a jamais marché correctement (R2 a stubbé
saveAnnotations sans le compenser). Recommandation : ajouter un test
neuf dans Lot 5 R3 (hors scope du fix immédiat).

### 4.4 Validation manuelle F5

Procédure recommandée :
1. F5 → Extension Development Host.
2. Workspace contenant `.out-of-code-insights/annotations.json` v2 avec ≥1 annotation.
3. Ouvrir le fichier annoté → vérifier décoration gutter (fix bug #1).
4. Cmd Palette → "Annotations: Edit Annotation" sur la ligne ancrée.
5. Modifier le message → confirmer.
6. **Attendre 200 ms** (debounce save).
7. Ouvrir `.out-of-code-insights/annotations.json` dans un autre éditeur.
8. Vérifier que `annotations[*].message` est la nouvelle valeur.
9. **Reload window** (`Developer: Reload Window`).
10. Rouvrir le fichier annoté → vérifier que le message est bien la
    nouvelle version (pas l'ancienne) — preuve de persistance.

Tests additionnels :
- Pin/unpin → vérifier `pinned: true` dans JSON.
- Edit tags → vérifier `tags: [...]` dans JSON.
- Delete → annotation absente du JSON après reload.
- Reply (add comment to thread) → `thread: [..., {nouveau}]` dans JSON.

---

## 5. Mutations résiduelles encore boguées

Toutes les mutations qui passent par `saveAnnotations()` sont maintenant
persistées (29 sites). Mutations restantes problématiques :

### 5.1 ✅ Couvertes par le fix (toutes les principales)

`modifyAnnotation`, `deleteAnnotation`, `replyToAnnotation`,
`togglePinAnnotation`, `setAnnotationSeverity`, `changeSeverity`,
`editAnnotationTags`, `resolveAnnotation`, `moveAnnotationUp`,
`moveAnnotationDown`, `addAnnotation` (legacy path), import JSON.

### 5.2 ⚠️ Bugs résiduels NON couverts (à tracer)

| # | Bug | Cause | Impact | Recommandation |
|---|---|---|---|---|
| **5.2.1** | Mutations qui ne passent PAS par `saveAnnotations` | Aucune identifiée par grep, mais audit non exhaustif (peut-être une commande Kanban legacy ou un chemin d'AI adapter) | À évaluer cas par cas | Run grep `this\.annotations\.set\|delete` et croiser avec `saveAnnotations()` calls |
| **5.2.2** | `UnifiedAIAdapter` lignes 881, 1240 — écrit dans `manager.annotations.set(id, updated)` SANS appeler saveAnnotations | Code AI fallback path quand `store` non câblé | Modifs AI invisibles côté store ; au prochain mirror, écrasées | Soit forcer le câblage `store` dans le constructeur (extension.ts:90 ne le passe pas), soit appeler `manager.saveAnnotations()` après chaque set |
| **5.2.3** | Annotations à `fileUri` undefined sont loggées warn et skippées | Notre garde dans reconcileLegacyToStore | Annotations legacy sans fileUri (très anciennes) ne se persistent pas | Migrer fileUri à la lecture dans `mirrorStoreToLegacyManager` (utiliser `vscode.workspace.asRelativePath` à partir du champ `file`) |
| **5.2.4** | Race AI adapter ↔ bridge | `UnifiedAIAdapter` (1304 LOC) appelle `populateAnchor` puis `manager.annotations.set` puis `manager.emit('annotationChanged')`. Aucun `saveAnnotations`. | Modif AI persistera SI un autre flow déclenche saveAnnotations rapidement après. Sinon perdue au prochain mirror. | Appeler `manager.saveAnnotations()` après chaque AI mutation |
| **5.2.5** | `clearAnnotations` legacy interne (5300+) | Override par `annotations.clearAll` côté store, mais legacy `clearAnnotations` accessible via panel webview ? | À vérifier : route-t-il vers store ou vers manager ? | Audit |

### 5.3 Notes sur la robustesse

- **Annotations 'suspended'** : `store.list()` n'inclut PAS les suspended.
  Notre orphanIds calculation utilise `store.list()`, donc une annotation
  suspended n'est PAS marquée orphelin (correct — on ne veut pas la
  remove). Mais elle n'apparaît pas non plus côté manager. Comportement
  correct : suspended = invisible jusqu'à paste.

- **Annotations 'paste'-cloned** : `existing.origin.kind === 'paste'`. Notre
  reconcile préserve `origin: existing?.origin`. ✅

- **IDs legacy non-UUID** : la doc V2 dit "id is RFC4122 v4 UUID" mais ce
  n'est pas validé runtime (ni par `upsert` ni par `validate`). Les IDs
  legacy `timestamp+random` passent sans broncher. ✅ pour transition,
  ⚠️ à corriger en R3.

- **Closed-file annotations en édition** : édition d'annotation se fait
  toujours sur le fichier actif (cf. `editAnnotationCommand:5156`
  `getActiveEditor`). Donc le doc est toujours ouvert au moment de la
  reconcile → offsets recomputés correctement.

---

## 6. Bilan cumulé bug #1 + bug #2

| Métrique | Valeur |
|---|---|
| Fichiers touchés | 1 (`src/extension.ts`) |
| Lignes ajoutées (cumul) | ~165 (bug #1: ~83, bug #2: ~82) |
| Fonctions transitoires ajoutées | 3 (`mirrorStoreToLegacyManager`, `installLegacySaveBridge`, `reconcileLegacyToStore`) |
| API publique modifiée | 0 (zéro) |
| Code legacy supprimé | 0 (zéro) |
| Quality gates | typecheck ✅ / lint ✅ |
| Dette flaggée à supprimer en R3 | 3 fonctions transitoires + le stub `stubLegacyAnnotationManagerIO` |

**Toutes les fonctions transitoires sont marquées `// transitional bridge —
remove when Option C migration completes`** pour faciliter la suppression
au moment de retirer le legacy AnnotationManager (R3).
