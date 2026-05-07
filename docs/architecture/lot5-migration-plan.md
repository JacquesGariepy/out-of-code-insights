# Lot 5 — Plan de migration des consommateurs

**Statut** : plan d'attaque pré-implémentation.
**Auteur** : APU (architecte transactionnel).
**Date** : 2026-05-06.
**Inputs** : `docs/architecture/annotation-store-v2.md`, `docs/architecture/consumer-migration-map.md`, `src/transactional/AnnotationStore.ts` (Lot 4 livré).
**Scope** : remplacer `AnnotationManager` (5567 lignes) + adapter 13 fichiers consommateurs + 4 fichiers de tests, sans régression sur Tree / Kanban / AI / Linked / Review / CodeLens / NavigationStack.

---

## 0. Constat de gap

Le store actuel (`src/transactional/AnnotationStore.ts`) **expose** :
- CRUD : `add/remove/update/get/getAll/getByFile`.
- Edit-tracking : `applyDocumentChange/suspend/resume/getSuspendedByHash`.
- Transactions : `beginTransaction/commit/rollback`.
- Undo mirror : `mirrorUndo/mirrorRedo`.
- Persistence in-memory : `serialize/deserialize`.
- Validation : `validate`.
- Helpers offset : `offsetToLine/lineToOffset`.
- Events `vscode.Event` : `onDidChange/onDidSuspend/onDidResume`.

Le store **n'expose PAS** (méthodes attendues par les 13 consommateurs, cf. consumer-migration-map.md §3) :
- `load() / save() / refresh() / waitUntilInitialized() / dispose()`
- `list() / listForFile() / size()` (alias ergonomiques)
- `upsert()` (création/mise à jour idempotente, requise par UnifiedAIAdapter:702)
- `setAnnotationLine()` (drag-drop reorder dans le tree)
- `populateAnchor()` (calcul d'ancre standalone, requis par AI:850/898)
- `isVisible() / isEnabled() / getConfig()` (filtrage display, CodeLens)
- `navigateToAnnotation() / focusAnnotationInPanel()` (services de navigation)
- `navigationStack` (composition NavigationStack)
- `notifyChanged()` ou émission `'annotationChanged'` style EventEmitter Node.js
- Listener `'kanbanColumnsChanged'`

**Ce gap structure tout le plan** : la stratégie doit couvrir simultanément l'ajout des méthodes manquantes et l'extraction des responsabilités hors-domaine.

---

## 1. Stratégie de remplacement — choix et justification

### Options considérées

#### Option A — Big-Bang
**Description** : remplacer `AnnotationManager` par `AnnotationStore + services` en un seul lot ; supprimer `AnnotationManager.ts` et `anchor.ts` dans le même commit ; toucher les 13 fichiers consommateurs simultanément.

| Avantages | Inconvénients |
|---|---|
| Pas de couche transitoire à maintenir/supprimer. | Rebase impossible si CI échoue partiellement. |
| Code final immédiat (pas de noms tampon). | Régression invisible avant que tous les sites soient touchés. |
| Pas de risque "couche compat oubliée". | Bloque toute autre PR pendant la migration. |
| | 5567 lignes à digérer dans une seule revue → revue impraticable. |
| | Pas de parallélisation possible (commit unique). |

**Verdict** : refusé. La taille du diff impose des paliers verts intermédiaires.

#### Option B — Adapter complet (façade)
**Description** : créer `AnnotationManagerAdapter implements AnnotationManager` qui reproduit l'API publique de l'ancien manager mais délègue à `AnnotationStore + services`. Les 13 consommateurs migrent un par un de l'adapter vers le store direct. Suppression de l'adapter en tout dernier.

| Avantages | Inconvénients |
|---|---|
| Migration consommateur par consommateur, CI verte à chaque palier. | Code duplique l'API ancienne *et* nouvelle pendant N rounds. |
| Reverts ciblés possibles. | L'adapter doit reproduire EventEmitter style Node + EventEmitter style vscode → friction. |
| Bon pour des refontes très étalées dans le temps. | Round supplémentaire dédié à supprimer l'adapter. |
| | Risque d'oublier un site et de figer l'adapter en place. |
| | Coût de maintenance pendant la migration (deux APIs à comprendre). |

**Verdict** : sur-dimensionné. La cartographie worker-2 montre que **9 fichiers sur 13** ont moins de 20 lignes à toucher. Un adapter complet serait de la dette pour 4 fichiers gros.

#### Option C — Hybride (RECOMMANDÉE)
**Description** :
- **(a)** enrichir le store d'un *thin layer* de méthodes ergonomiques qui matchent l'usage attendu (`list`/`listForFile`/`upsert`/`dispose`/`waitUntilInitialized`) — pas un adapter, juste des alias et primitives manquantes — **API définitive dès le jour 1**.
- **(b)** extraire en services injectables et autonomes les responsabilités hors-domaine du store (cf. §4) — **services définitifs dès le jour 1**.
- **(c)** migrer les 13 consommateurs en 4 worktrees parallèles vers `store + services`. Pas de couche tampon.
- **(d)** supprimer `AnnotationManager.ts` et `anchor.ts` une fois tous les imports migrés.

| Avantages | Inconvénients |
|---|---|
| Pas de code transitoire à supprimer après migration. | Demande un round séquentiel de fondation (store enrichi + services) avant les worktrees. |
| Parallélisation 4× sur le gros du travail. | Léger risque d'incohérence inter-worktrees → mitigé par contrats figés en round 1. |
| Chaque worktree a son palier vert (typecheck + lint:ci + test:unit). | |
| Convergence finale en un round séquentiel court. | |

**Verdict** : **CHOIX RECOMMANDÉ**. 3 rounds (séquentiel → parallèle 4× → séquentiel court). Pas de dette transitoire.

### Décision

**Option C — Hybride**. Justification synthétique :

1. **Le gap de surface** (§0) impose de toucher au store de toute façon : l'enrichir avec list/listForFile/upsert/dispose est plus court qu'écrire un adapter complet.
2. **9/13 fichiers consommateurs ont un volume ≤20 lignes** — un adapter complet pour eux est sur-ingénierie.
3. **Les 4 fichiers HIGH/MEDIUM** (extension.ts, LinkedAnnotationManager, UnifiedAIAdapter, AnnotationsTree) seront chacun pris dans un worktree dédié — la parallélisation transforme le risque "gros diff" en risque "diff revue par worktree".
4. **Pas de couche à supprimer** ⇒ pas de round terminal "ménage de l'adapter".
5. **Les services extraits** (Persistence, Navigation, VisibilityFilter, ChatParticipant) sont la **bonne architecture finale**, pas un palliatif de migration.

---

## 2. Ordonnancement (3 rounds, 4 worktrees parallèles en round 2)

### Round 1 — Fondations (séquentiel, 1 agent)

**Objectif** : geler l'API cible. Aucun consommateur n'est touché ; tous les tests existants passent toujours (l'ancien `AnnotationManager` reste en place, le store et les nouveaux services coexistent).

**Étape 1.1 — Enrichir `AnnotationStore.ts`** :
- Ajouter `list(): readonly AnnotationV2[]` (alias de `getAll()`).
- Ajouter `listForFile(file: string): readonly AnnotationV2[]` (matching `fileUri OR file` pour compat display path).
- Ajouter `size(): number`.
- Ajouter `upsert(ann: AnnotationDraftRaw): Readonly<AnnotationV2>` (idempotent : `add` si nouveau, `update` si id présent).
- Ajouter `dispose(): void` (vidange listeners + map + journal + suspended ; émet rien).
- Ajouter `waitUntilInitialized(): Promise<void>` (résolu après `deserialize` ou immédiatement si pas encore chargé).
- Ajouter `notifyChanged(): void` (fire `_onDidChange.fire([])` — utilisé par les sites externes qui faisaient `manager.emit('annotationChanged')`).
- Ajouter `populateAnchor(ann: AnnotationV2, document: vscode.TextDocument, line: number): Promise<void>` (recalcule lineHash + context via `captureAnchor`, mute via `update`).
- Ajouter `setAnnotationLine(id: string, newLine: number, document: vscode.TextDocument): void` (drag-drop reorder du panneau ; recalcule offsets).

**Étape 1.2 — Créer les services dans `src/transactional/`** :
- `AnnotationPersistence.ts` (cf. §4).
- `AnnotationNavigation.ts` (cf. §4).
- `VisibilityFilter.ts` (cf. §4).
- `KanbanColumnStore.ts` (cf. §4).

**Étape 1.3 — Tests unitaires** : couvrir les nouvelles méthodes du store + chaque service. Pas de tests EDH ici.

**Critères verts round 1** : `npm run typecheck` ✓ + `npm run lint:ci` ✓ + `npm run test:unit` ✓ + `npm test` ✓ (les EDH existants ne dépendent que de l'ancien manager).

**Sortie** : API cible figée, contrat opposable aux 4 worktrees du round 2.

---

### Round 2 — Migration consommateurs (parallèle, 4 worktrees)

Les 4 worktrees peuvent démarrer simultanément après la sortie de round 1. Chaque worktree merge dans `main` indépendamment et reste vert isolément.

#### Worktree A — Tree + Display (LOW-MEDIUM)
**Fichiers** :
- `src/tree/AnnotationsTree.ts` (~15-20 lignes touchées)
- `src/tree/NavigationStackTree.ts` (~5 lignes)
- `src/views/KanbanView.ts` (0-3 lignes, commentaires uniquement)
- `src/providers/AnnotationCodeLensProvider.ts` (~7 lignes)

**Tests couvrants** : `src/test/suite/annotations.test.ts` (display) + nouveau `src/test/suite/transactional/tree-display.integration.test.ts`.

**Effort estimé** : S (≤30 lignes total).
**Risque** : LOW. Lecture seule pour la majorité ; le seul site mutant est `setAnnotationLine` (drag-drop reorder) déjà offert par le store en round 1.

#### Worktree B — Managers consommateurs (HIGH)
**Fichiers** :
- `src/managers/LinkedAnnotationManager.ts` (~50 lignes)
- `src/managers/ReviewModeManager.ts` (~10-12 lignes)
- `src/managers/SnippetManager.ts` (0-3 lignes — n'importe pas `AnnotationManager`, juste vérifier que `ann.line` reste lisible via getter dérivé)

**Tests couvrants** : tests unitaires existants de chaque manager + `src/test/suite/transactional/linked.integration.test.ts` (nouveau).

**Effort estimé** : L (~65 lignes).
**Risque** : MED. LinkedAnnotationManager fait beaucoup d'allers-retours `annotations.get/values` + émet `'annotationChanged'`. Suppression du `as any` cheat à `UnifiedAIAdapter:610` est traitée dans worktree C.

#### Worktree C — Providers AI + CodeLens (HIGH bcs mutation directe)
**Fichiers** :
- `src/providers/UnifiedAIAdapter.ts` (~30-35 lignes — dont `:702` mutation directe Map à éliminer via `store.upsert`)
- `src/providers/UnifiedAIProvider.ts` (0 lignes — non-impacté)
- `src/providers/ClaudeCodeProvider.ts` (0 lignes — non-impacté)

**Tests couvrants** : nouveaux `src/test/suite/transactional/ai-adapter.integration.test.ts`.

**Effort estimé** : M (~35 lignes).
**Risque** : HIGH. Le site `:702` `manager.annotations.set(...)` est l'unique mutation directe externe de la Map ; le journal transactionnel doit absolument prendre le relais. Le `as any` à `:610` est cassé : injecter `LinkedAnnotationManager` proprement.

#### Worktree D — Extension entry + tests E2E (MEDIUM)
**Fichiers** :
- `src/extension.ts` (~12-15 lignes)
- `src/managers/AnnotationManagerErrorHandling.ts` (rename optionnel, sinon 0 ligne)
- `src/common/types.ts` (~10-30 lignes — selon décision sur extension de `Annotation` vs nouveau type `AnnotationV2`)
- Mise à jour des tests d'intégration EDH existants pour pointer sur le store.

**Tests couvrants** : `src/test/suite/extension.test.ts` (smoke), `src/test/suite/annotationReanchor.integration.test.ts` (~50 lignes commentaires/assertions).

**Effort estimé** : M (~50 lignes + tests).
**Risque** : MED. Entry-point change de constructeur, listeners du Kanban à rebrancher sur `KanbanColumnStore`, hooks `'annotationChanged'` à reconnecter sur `store.onDidChange`.

#### Indépendance des worktrees

Aucun chevauchement de fichier. Conflits de merge théoriquement nuls. Seuls accointances : tous importent les nouveaux services (figés en round 1) et lisent `AnnotationV2` depuis `src/transactional/types.ts`.

**Critères verts par worktree** : `npm run typecheck` ✓ + `npm run lint:ci` ✓ + `npm run test:unit` ✓ + `npm test` ✓ pour leur scope. Les anciens tests d'`AnnotationManager` non touchés peuvent rester verts car l'ancien manager n'est PAS encore supprimé.

---

### Round 3 — Extinction et smoke E2E (séquentiel, 1 agent)

**Objectif** : supprimer l'ancien code et valider de bout en bout.

**Étape 3.1 — Supprimer**
1. `src/managers/AnnotationManager.ts` (5567 lignes) — DELETE.
2. `src/anchoring/anchor.ts` (487 lignes) — DELETE après extraction des helpers utiles dans `src/transactional/internal/hashing.ts` (≤60 lignes : `hashLine`, `EMPTY_LINE_HASH`, `normalizeLine`, `isEmptyLineHash`) et `src/transactional/internal/anchor-fallback.ts` (≤80 lignes : `captureAnchor`, `findAnchor`, `reanchor`, `TextDocumentLike`, `AnchorData`, `MovedBlock`).
3. `src/test/integration/annotationManager.integration.test.ts` (3340 lignes) — DELETE (les §7.x tests EDH sont déjà dans `src/test/suite/transactional/`).
4. `src/anchoring/__tests__/anchor.test.ts` (700 lignes) — MOVE vers `src/transactional/internal/__tests__/hashing.test.ts` + `anchor-fallback.test.ts`.
5. `src/test/suite/unit/annotationManager.unit.test.ts` (632 lignes) — MOVE/REWRITE vers `src/transactional/__tests__/store-edge-cases.unit.test.ts` ; supprimer les tests redondants avec ceux du store.

**Étape 3.2 — Smoke E2E**
- Nouveau test `src/test/suite/transactional/end-to-end.integration.test.ts` qui exerce : création annotation via UI command → édition document → cut/paste → drag-drop reorder → undo/redo → reload workspace → validation persistence.
- Tous les §7.x EDH tests existants tournent au vert.

**Étape 3.3 — F5 manuel utilisateur**
- L'utilisateur exerce les 14 scénarios §7.x dans Extension Development Host. Liste de scripts dans la section §6 ci-dessous.

**Critères verts round 3** : `npm run typecheck` ✓ + `npm run lint:ci` ✓ + `npm run test:unit` ✓ + `npm test` ✓ + smoke E2E vert + F5 utilisateur OK.

**Estimation totale** : **3 rounds** (1 séquentiel + 1 parallèle 4× + 1 séquentiel).

---

## 3. Mapping API publique exhaustif

`AnnotationManager.X` → `AnnotationStore.Y` ou service extrait.

### Collections / lecture

| Source `AnnotationManager` | Cible | Note |
|---|---|---|
| `manager.annotations: Map<string, Annotation>` (champ public) | `store.list(): readonly AnnotationV2[]` | Itération seule. Lecture par id : `store.get(id)`. |
| `Array.from(manager.annotations.values())` | `store.list()` | Alias direct. |
| `manager.annotations.get(id)` | `store.get(id)` | Identique. |
| `manager.annotations.size` | `store.size()` | Nouveau helper round 1. |
| `manager.annotations.set(id, ann)` | `store.upsert(ann)` | **Site UnifiedAIAdapter:702** — passer obligatoirement par upsert pour journaliser. |
| `manager.getAnnotationsForFile(fileName)` | `store.listForFile(fileName)` | Round 1 ajoute le helper. |

### Cycle de vie

| Source | Cible | Note |
|---|---|---|
| `manager.loadAnnotations()` | `await persistence.load(store, fileUri)` | Service `AnnotationPersistence` cf. §4. |
| `manager.saveAnnotations()` | `await persistence.save(store, fileUri)` | Idem. |
| `manager.refreshAnnotations()` | `store.notifyChanged()` puis observateurs s'auto-refresh via `onDidChange` | Plus d'appel direct à un "refresh" — tout observable. |
| `manager.waitUntilInitialized()` | `await store.waitUntilInitialized()` | Round 1. |
| `manager.dispose()` | `store.dispose()` | Round 1. |

### Mutations

| Source | Cible | Note |
|---|---|---|
| `manager.setAnnotationLine(ann, line, doc?)` | `store.setAnnotationLine(ann.id, line, doc)` | Round 1. Recalcule startOffset = lineToOffset(line). |
| `manager.populateAnchor(ann, doc, line)` | `await store.populateAnchor(ann, doc, line)` | Round 1. |
| `manager.addAnnotation(args?)` | handler de commande dans `commands/addAnnotation.ts` qui invoque `store.add(draft, opts, doc)` | Plus dans le store. |
| `manager.deleteAnnotationCommand()` | handler `commands/deleteAnnotation.ts` → `store.remove(id)` | Idem. |
| `manager.editAnnotationCommand()` | handler → `store.update(id, patch)` | Idem. |

### Display & filtres

| Source | Cible | Note |
|---|---|---|
| `manager.shouldAnnotationBeVisible(ann)` | `visibilityFilter.isVisible(ann)` | Service dédié. Logique tags/severity hors store. |
| `manager.annotationsEnabled: boolean` | `visibilityFilter.isGloballyEnabled()` | Préserve `outOfCodeInsights.enableAnnotations`. |
| `manager.config: ExtensionConfig` | `configurationManager.get()` | Pas dans le store. Existe déjà via `ConfigurationManager`. |

### Navigation

| Source | Cible | Note |
|---|---|---|
| `manager.navigateToAnnotation(id, record?)` | `await navigationService.navigateTo(id, record)` | Service dédié. |
| `manager.focusAnnotationInPanel(id)` | `navigationService.focusInPanel(id)` | Idem. |
| `manager.navigationStack` (champ) | `navigationService.stack: NavigationStack` | Composition explicite, pas un champ public du store. |

### AI / Chat / Templates / Snippets

| Source | Cible | Note |
|---|---|---|
| `manager.createChatParticipant(context)` | `chatParticipant.register(context, store)` | Module dédié. |
| `manager.ensureAiConfigured()` | `unifiedAIAdapter.ensureConfigured()` | Déjà côté AI adapter. |
| `manager.applyTemplate / createTemplate / getTemplates` | `templateManager.apply / create / list` | Existant, juste injecté par DI. |
| `manager.addSnippet / applySnippet / previewSnippet / getSnippets` | `snippetManager.*` | Idem. |
| `manager.searchAnnotationById / searchAnnotationsByFilter` | `commands/search.ts` invoquant `store.list().filter(...)` | Pas dans le store. |

### Events

| Source | Cible | Note |
|---|---|---|
| `manager.on('annotationChanged', cb)` | `store.onDidChange(ops => cb())` | API VS Code event style. |
| `manager.emit('annotationChanged')` | `store.notifyChanged()` | Round 1. |
| `manager.on('kanbanColumnsChanged', cb)` | `kanbanColumnStore.onDidChange(cb)` | Hors du store transactionnel. |
| EventEmitter inheritance (extends EventEmitter) | composition (Store n'hérite plus de Node EventEmitter) | Pas de regression. |

### Erreur handling

| Source | Cible | Note |
|---|---|---|
| `manager.handleError(message, error)` | `errorHandler.handle(message, error)` (module renommé `AnnotationManagerErrorHandling.ts` → `AnnotationErrorHandling.ts` au choix) | N'a aucune dépendance state, peut rester en place. |

---

## 4. Nouveaux services à créer (round 1)

Tous sous `src/transactional/`. SPDX `MPL-2.0`. Aucun n'hérite de `AnnotationManager`.

### `AnnotationPersistence.ts`

**Responsabilités** :
- Path resolver : convertir `outOfCodeInsights.annotation.path` en chemin absolu, valider la traversée workspace-root.
- Création du dossier `.out-of-code-insights/` à la première écriture.
- `load(store: AnnotationStore, workspaceFolder: vscode.Uri): Promise<void>` — lit `annotations.json`, `JSON.parse`, `store.deserialize`.
- `save(store: AnnotationStore, workspaceFolder: vscode.Uri): Promise<void>` — `store.serialize()`, `JSON.stringify(_, null, 2)`, `fs.writeFile`.
- File watcher (`vscode.workspace.createFileSystemWatcher`) → recharge `store.deserialize` sur modification externe.
- Émet `onDidLoad` / `onDidSave` events.

**Dépendances** : `vscode`, `node:fs/promises`, `node:path`, `AnnotationStore`, `ConfigurationManager`.

### `AnnotationNavigation.ts`

**Responsabilités** :
- `navigateTo(id: string, record?: boolean): Promise<void>` — ouvre le document via `vscode.window.showTextDocument`, place le curseur à `positionAt(ann.startOffset)`, push optionnellement dans `NavigationStack`.
- `focusInPanel(id: string): void` — révèle l'annotation dans `AnnotationsTreeDataProvider` via `treeView.reveal(...)`.
- Compose `NavigationStack` (réutilise `src/managers/NavigationStack.ts` qui n'est PAS supprimé).
- `readonly stack: NavigationStack`.

**Dépendances** : `vscode`, `AnnotationStore`, `NavigationStack`, `AnnotationsTreeDataProvider`.

### `VisibilityFilter.ts`

**Responsabilités** :
- `isVisible(ann: AnnotationV2): boolean` — porte la logique `shouldAnnotationBeVisible` (tags désactivés, severity courante, état `resolved`, focus mode).
- `isGloballyEnabled(): boolean` — lecture de `outOfCodeInsights.enableAnnotations`.
- Réagit aux changements de configuration via `vscode.workspace.onDidChangeConfiguration`.
- Émet `onDidChange` quand un filtre change → permet aux trees de se rafraîchir sans toucher le store.

**Dépendances** : `vscode`, `ConfigurationManager`.

**Pourquoi pas dans le store** : la visibilité dépend de configuration utilisateur (filtres tags, focus mode), pas de l'état d'ancrage. Le store reste pur et testable hors VS Code.

### `KanbanColumnStore.ts`

**Responsabilités** :
- Stocke les colonnes Kanban (`KanbanColumn[]` de `src/common/types.ts:26`) hors du store d'annotations.
- Persistance via VS Code `Memento` (workspace state) ou fichier dédié.
- `getColumns() / setColumns(cols) / moveAnnotation(annId, columnId)`.
- Émet `onDidChange` (remplace `'kanbanColumnsChanged'`).

**Dépendances** : `vscode`.

**Pourquoi séparé** : les colonnes Kanban sont un état UI, pas un état d'ancrage. L'isolation permet de faire évoluer le Kanban sans risquer le journal transactionnel.

### Récapitulatif "ce qui reste dans `AnnotationStore`"

Strictement :
- CRUD typé + journal d'ops.
- Edit-tracking offsets (cas A/B/C/D).
- Suspended buffer cut/paste.
- Mirror undo/redo.
- Validation invariants.
- Sérialisation JSON v2.

**Pas dans le store** : I/O fichier, navigation UI, filtres display, colonnes Kanban, AI adapter, chat participant, templates, snippets, commandes.

---

## 5. Plan de ramping ligne-par-ligne — 5 fichiers HIGH/MEDIUM

Les pointeurs `file:line` sont issus de `consumer-migration-map.md`. Format : ligne courante → action.

### 5.1 — `src/extension.ts` (HIGH bcs entry-point)

| Ligne | Avant | Après |
|---|---|---|
| `:9` | `import { AnnotationManager } from './managers/AnnotationManager'` | `import { AnnotationStore } from './transactional/AnnotationStore'` + imports services (`AnnotationPersistence`, `AnnotationNavigation`, `VisibilityFilter`, `KanbanColumnStore`) |
| `:18` | `import { AnnotationManagerErrorHandling }` | conserver ; rename en `AnnotationErrorHandling` optionnel |
| `:21` | `let annotationManager: AnnotationManager \| undefined` | `let annotationStore: AnnotationStore \| undefined` + variables pour services (persistence, nav, visibility, kanbanStore) |
| `:42` | `annotationManager = new AnnotationManager(context)` | `annotationStore = new AnnotationStore({ journalCapacity: 1024, suspendTtlMs: 30_000 })` + instancier les 4 services |
| `:58` | `context.subscriptions.push(annotationManager)` | `context.subscriptions.push(annotationStore, persistence, navigation, visibility, kanbanStore)` |
| `:93` | `await annotationManager.loadAnnotations()` | `await persistence.load(annotationStore, workspaceFolder)` |
| `:94` | `await annotationManager.refreshAnnotations()` | retirer (les observateurs s'abonnent à `store.onDidChange`) |
| `:100` | `await annotationManager.waitUntilInitialized()` | `await annotationStore.waitUntilInitialized()` |
| `:102` | `annotationManager.createChatParticipant(context)` | `chatParticipant.register(context, annotationStore)` |
| `:131` | `annotationManager.annotations.values()` | `annotationStore.list()` |
| `:146` | `Array.from(annotationManager.annotations.values())` | `annotationStore.list()` |
| `:155` | payload Kanban : `line: annotation.line` | `line: annotationStore.offsetToLine(annotation.startOffset, document)` (passer `document` ou wrapper getter) |
| `:164` | `annotationManager.on('annotationChanged', updateKanban)` | `annotationStore.onDidChange(_ops => updateKanban())` |
| `:179` | `annotationManager.on('kanbanColumnsChanged', updateColumns)` | `kanbanColumnStore.onDidChange(updateColumns)` |
| `:189, :210, :236` | `annotationManager.handleError(...)` | `errorHandler.handle(...)` (module utilitaire conservé/renommé) |
| `:271-291` | `annotationManager.addAnnotation(args)` (commande générique) | handler dédié `commands/addAnnotation.ts` → `annotationStore.add(draft, opts, document)` |
| `:278` | `annotationManager.ensureAiConfigured()` | `unifiedAIAdapter.ensureConfigured()` (l'adapter est déjà injecté ailleurs) |
| `:347` | `annotationManager.dispose()` | déjà dans `context.subscriptions.push(...)` ; ligne supprimée |

**Volume** : ~15-20 lignes touchées.

### 5.2 — `src/managers/LinkedAnnotationManager.ts` (HIGH)

| Ligne | Avant | Après |
|---|---|---|
| `:4` | `import { AnnotationManager }` | `import { AnnotationStore }` + import `AnnotationsTreeDataProvider` (DI explicite à `:284-285`) + import `AnnotationNavigation` (pour `:174`) |
| `:23-24` | `extends EventEmitter ; private annotationManager: AnnotationManager` | retirer `extends EventEmitter` (composition plutôt) ; `private store: AnnotationStore`, `private navigation: AnnotationNavigation`, `private treeProvider: AnnotationsTreeDataProvider` |
| `:27` | constructor signature | accepte `store, navigation, treeProvider` |
| `:41` | `this.annotationManager.on('annotationChanged', cb)` | `this.store.onDidChange(_ops => cb())` |
| `:55, :111, :144, :188` | `this.annotationManager.annotations.get(sourceId)` | `this.store.get(sourceId)` |
| `:95, :128` | `await this.annotationManager.saveAnnotations()` | `await this.persistence.save(this.store, ...)` (injecter persistence aussi) — *ou* émettre un `notifyChanged` et laisser un orchestrateur sauver |
| `:104, :137` | `this.annotationManager.emit('annotationChanged')` | `this.store.notifyChanged()` |
| `:171` | `this.annotationManager.navigationStack.push(...)` | `this.navigation.stack.push(...)` |
| `:174` | `this.annotationManager.focusAnnotationInPanel(...)` | `this.navigation.focusInPanel(...)` |
| `:198, :224, :235, :339, :347, :362, :376, :401, :425, :432, :458, :483, :516` | `this.annotationManager.annotations.values()` ou `.get()` | `this.store.list()` ou `this.store.get(id)` |
| `:284-285` | `this.annotationManager.annotationsTreeDataProvider.refresh()` | `this.treeProvider.refresh()` |
| `:60-280` (`targetLine`) | `link.targetLine` (lecture seule) | inchangé tant que `LinkedAnnotation.targetLine` reste un nombre — décision §6.2 ci-dessous : **on conserve `targetLine` en v2** ; pas de migration breaking sur ce sous-type |

**Volume** : ~50 lignes.

**Note** : la décision de NE PAS introduire `targetOffset?` sur `LinkedAnnotation` simplifie. La résolution `targetLine` se fait via `findAnchor` côté display si l'annotation cible a bougé — le store offre `getByFile + offsetToLine` pour faciliter la résolution.

### 5.3 — `src/providers/UnifiedAIAdapter.ts` (HIGH)

| Ligne | Avant | Après |
|---|---|---|
| `:3` | `import { AnnotationManager }` | `import { AnnotationStore }` + `import { LinkedAnnotationManager }` (élimine `as any` à `:610`) |
| `:14, :46` | field `annotationManager` + constructor | `private store: AnnotationStore`, `private linkedManager: LinkedAnnotationManager` |
| `:610` | `(this.annotationManager as any).linkedAnnotationManager` | `this.linkedManager` (injecté propre) |
| `:617, :692` | `Array.from(this.annotationManager.annotations.values())` | `this.store.list()` |
| `:625` | `${ann.file}:${ann.line}` (display) | `${ann.file}:${this.store.offsetToLine(ann.startOffset, doc)}` ou maintenir un getter `lineNumber` côté annotation enrichie (cf. §6.3) |
| `:651` | `selected[j].annotation.line` | idem getter |
| `:693` | `ann.line === currentLine` | `this.store.offsetToLine(ann.startOffset, doc) === currentLine` |
| `:702` | `this.annotationManager.annotations.set(annotation.id, updatedAnnotation)` | **`this.store.upsert(updatedAnnotation)`** — passage obligatoire par le journal |
| `:850, :898` | `await this.annotationManager.populateAnchor(annotation, document, annotation.line)` | `await this.store.populateAnchor(annotation, document, line)` (le store recalcule lineHash + context + offsets) |
| `:865` | `manager.emit('annotationChanged')` | retirer (l'`upsert` à `:702` émet `onDidChange` automatiquement) |
| `:880, :917` | `${ann.line}` display | idem `:625` |

**Volume** : ~30-35 lignes.

**Risque clé** : `:702`. Le contrat de `upsert` doit garantir que toute mutation passe par le journal — sans quoi on perd l'undo cohérent. Test EDH dédié dans round 2 worktree C.

### 5.4 — `src/tree/AnnotationsTree.ts` (MEDIUM)

| Ligne | Avant | Après |
|---|---|---|
| `:2` | `import { AnnotationManager }` | `import { AnnotationStore }` + `import { VisibilityFilter }` |
| `:11` | `constructor(private annotationManager: AnnotationManager)` | `constructor(private store: AnnotationStore, private visibility: VisibilityFilter)` |
| `:12` | `this.annotationManager.on('annotationChanged', this.refresh.bind(this))` | `this.store.onDidChange(() => this.refresh())` + `this.visibility.onDidChange(() => this.refresh())` |
| `:24` | `await this.annotationManager.waitUntilInitialized()` | `await this.store.waitUntilInitialized()` |
| `:25` | `Array.from(this.annotationManager.annotations.values())` | `this.store.list()` |
| `:26` | `.filter(a => this.annotationManager.shouldAnnotationBeVisible(a))` | `.filter(a => this.visibility.isVisible(a))` |
| `:35` | `arr.sort((a, b) => a.line - b.line)` | `arr.sort((a, b) => a.startOffset - b.startOffset)` (offset = autorité) |
| `:64` | `constructor(public readonly annotation: Annotation, private annotationManager?: AnnotationManager)` | `private store?: AnnotationStore` |
| `:84` | `Array.from(this.annotationManager.annotations.values()).filter(...)` | `this.store.list().filter(...)` |
| `:86` | `link.targetFile === annotation.file && link.targetLine === annotation.line` | inchangé si `targetLine` reste numérique ; le panneau lit `annotation.line` via getter dérivé (cf. §6.3) — sinon : `... && link.targetLine === doc.positionAt(annotation.startOffset).line` |
| `:95, :101, :111-128` | `annotation.line + 1` (display 1-based) | inchangé sous getter, sinon `doc.positionAt(annotation.startOffset).line + 1` |
| `:170` | `constructor(private annotationManager: AnnotationManager)` (DragDropController) | `private store: AnnotationStore` |
| `:187` | `this.annotationManager.annotations.get(id)` | `this.store.get(id)` |
| `:215-216` | `Array.from(...).filter(a => a.file === draggedFile)` | `this.store.listForFile(draggedFile)` |
| `:235` | `this.annotationManager.setAnnotationLine(a, i)` | `this.store.setAnnotationLine(a.id, i, document)` (document récupéré via `vscode.workspace.openTextDocument(uri)`) |
| `:238` | `this.annotationManager.saveAnnotations()` | `this.persistence.save(this.store, ...)` (DI persistence) |
| `:239` | `this.annotationManager.refreshAnnotations()` | retirer (l'observation onDidChange suffit) |
| `:240` | `this.annotationManager.emit('annotationChanged')` | retirer (déjà émis par `setAnnotationLine`) |

**Volume** : ~15-20 lignes.

### 5.5 — `src/managers/ReviewModeManager.ts` (MEDIUM)

| Ligne | Avant | Après |
|---|---|---|
| `:4` | `import { AnnotationManager }` | `import { AnnotationStore }` + `import { ConfigurationManager }` (pour `:222`) + `import { AnnotationNavigation }` (pour `:379`) + `import { AnnotationPersistence }` (pour `:229`) |
| `:38` | constructor | accepte `store, configurationManager, navigation, persistence` |
| `:54` | `this.annotationManager.on('annotationChanged', cb)` | `this.store.onDidChange(_ops => cb())` |
| `:214` | `this.annotationManager.annotations.get(id)` | `this.store.get(id)` |
| `:222` | `this.annotationManager.config.username` | `this.configurationManager.get().username` |
| `:229` | `await this.annotationManager.saveAnnotations()` | `await this.persistence.save(this.store, workspaceFolder)` |
| `:265, :305, :597` | `this.annotationManager.annotations.values()` | `this.store.list()` |
| `:365` | `return a.line - b.line` | `return a.startOffset - b.startOffset` |
| `:379` | `this.annotationManager.navigateToAnnotation(annotation.id, false)` | `await this.navigation.navigateTo(annotation.id, false)` |
| `:533` | template HTML `${annotation.line}` | `${doc.positionAt(annotation.startOffset).line + 1}` ou getter dérivé |

**Volume** : ~10-12 lignes.

---

## 6. Tests d'intégration EDH — Lot 5

Tous sous `src/test/suite/transactional/`. Préfixés `lot5-` pour les distinguer des EDH §7.x du lot 4.

### 6.1 — `lot5-tree-display.integration.test.ts`
Couvre worktree A.
- **Scénario 1** : créer 3 annotations dans 2 fichiers, ouvrir l'`AnnotationsTreeDataProvider`, vérifier que tous apparaissent groupés par fichier.
- **Scénario 2** : muter `annotation.severity` via `store.update`, vérifier que `_onDidChangeTreeData` se déclenche et que la severity affichée se met à jour.
- **Scénario 3** : `setAnnotationLine` (drag-drop reorder), vérifier que `startOffset` est recalculé et que `onDidChange` émet.
- **Scénario 4** : filtre `VisibilityFilter` (désactiver tag) → l'annotation tagée disparaît du tree sans toucher le store.

### 6.2 — `lot5-kanban-columns.integration.test.ts`
Couvre worktree A + isolation `KanbanColumnStore`.
- **Scénario 1** : déplacer une annotation entre colonnes Kanban via webview message, vérifier que `KanbanColumnStore` est muté et que `onDidChange` émet.
- **Scénario 2** : muter une annotation via `store.update` → la webview reçoit le bon payload (line dérivée de `offsetToLine`).
- **Scénario 3** : recharger le workspace, vérifier que les colonnes sont restaurées via `Memento`.

### 6.3 — `lot5-ai-adapter.integration.test.ts`
Couvre worktree C — **test critique** car `:702` est l'unique site de mutation directe historique.
- **Scénario 1** : invoquer `unifiedAIAdapter.suggestAnnotation(...)` → vérifier que `store.upsert` est appelé et qu'un `OpEntry` `add` apparaît dans `store.getJournal()`.
- **Scénario 2** : suggérer 5 annotations en série, vérifier que le journal contient 5 ops, ordre préservé, et que un `mirrorUndo` les inverse correctement.
- **Scénario 3** : `populateAnchor` réécrit lineHash + contextBefore + contextAfter sans changer l'id ni l'origine.

### 6.4 — `lot5-linked-navigation.integration.test.ts`
Couvre worktree B.
- **Scénario 1** : créer une annotation source + une cible liée (`linkedAnnotations`), invoquer `navigateTo(targetId)`, vérifier que `vscode.window.activeTextEditor` pointe sur le bon fichier et offset.
- **Scénario 2** : muter le fichier cible (insertion avant l'annotation), `targetLine` doit refléter le nouvel offset au prochain affichage.
- **Scénario 3** : `focusInPanel(id)` → `treeView.reveal(...)` est appelé.

### 6.5 — `lot5-end-to-end.integration.test.ts`
Smoke run round 3.
- Création annotation via UI command → édition document (cas A) → cut+paste (cas D + resume) → drag-drop reorder → undo (mirror) → reload workspace → `validate()` retourne `valid: true`.

### 6.6 — Régression : 14 §7.x EDH tests existants

Les tests `cut.integration.test.ts`, `paste.integration.test.ts`, `edit-tracking.integration.test.ts`, `undo.integration.test.ts` du lot 4 doivent rester verts **après** câblage de `applyDocumentChange` dans `extension.ts:onDidChangeTextDocument`. Test smoke à ajouter : ouvrir un fichier, taper du texte, vérifier que le store reçoit l'event (vérifié via `journal.length` post-mutation).

### 6.7 — F5 manuel utilisateur — checklist scénarios §7.x

Imprimable dans `INSTRUCTIONS_TEST_REEL.md`.

| § | Scénario | Validation visuelle |
|---|---|---|
| 7.1 | édition avant annotation | annotation reste sur la bonne ligne |
| 7.2 | édition intra-annotation | annotation s'étend, badge visible |
| 7.3 | cut sans paste | annotation grisée (suspended), TTL 30s puis disparait |
| 7.4 | cut puis paste même offset | annotation revient |
| 7.5 | cut puis paste autre offset | annotation suit |
| 7.6 | copy puis paste | nouvelle annotation cloné, lien `origin.sourceOpId` visible |
| 7.7 | undo cut | annotation re-active |
| 7.8 | redo après undo | annotation re-suspended |
| 7.9 | drag-drop reorder | ordre tree mis à jour, offset recalculé |
| 7.10 | reload workspace | toutes les actives persistées, suspended perdues (acceptable) |
| 7.11 | suppression manuelle | annotation supprimée, `mirrorUndo` la restaure |
| 7.12 | édition multi-cursor | toutes les annotations affectées suivent |
| 7.13 | save concurrent (file watcher) | `deserialize` recharge sans perte |
| 7.14 | annotation sur ligne vide à la création | `walkForward` capture la ligne suivante non-vide |

---

## 7. Plan d'extinction (round 3, ordre strict)

### Pré-conditions

Avant toute suppression, vérifier :
- [ ] `npm run typecheck` ✓ avec **zéro** import résiduel de `'./managers/AnnotationManager'` ou `'../anchoring/anchor'` (hormis dans les fichiers utilitaires extraits).
- [ ] `npm run lint:ci` ✓.
- [ ] `npm run test:unit` ✓.
- [ ] `npm test` ✓.
- [ ] Smoke E2E `lot5-end-to-end.integration.test.ts` ✓.

### Ordre de suppression

1. **`src/managers/AnnotationManager.ts`** (5567 lignes) — DELETE intégral. Aucun fichier ne doit l'importer (vérifié à la pré-condition).
2. **`src/anchoring/anchor.ts`** (487 lignes) :
   - **Avant DELETE** : extraire dans `src/transactional/internal/` :
     - `hashing.ts` ← `hashLine`, `EMPTY_LINE_HASH`, `normalizeLine`, `isEmptyLineHash` (~60 lignes).
     - `anchor-fallback.ts` ← `captureAnchor`, `findAnchor`, `reanchor`, `TextDocumentLike`, `AnchorData`, `MovedBlock`, `CaptureOptions`, `FindAnchorOptions`, `ReanchorStatus`, `ReanchorResult`, `ReanchorInput`, `detectMoves` (~280 lignes au total après nettoyage).
   - Mettre à jour les imports du store : `import from '../anchoring/anchor'` → `import from './internal/hashing'` (et `./internal/anchor-fallback`).
   - DELETE `src/anchoring/anchor.ts` + `src/anchoring/__tests__/` complet (les tests sont déplacés en step 3).
3. **`src/anchoring/__tests__/anchor.test.ts`** (700 lignes) — MOVE vers :
   - `src/transactional/internal/__tests__/hashing.test.ts`
   - `src/transactional/internal/__tests__/anchor-fallback.test.ts`
4. **`src/test/integration/annotationManager.integration.test.ts`** (3340 lignes) — DELETE.
   - Justification : redondant avec `src/test/suite/transactional/*.integration.test.ts` (les §7.x déjà couverts en lot 4 + nouveaux lot 5).
   - Vérifier d'abord que chaque scénario de l'ancien fichier a un équivalent dans la nouvelle suite — produire un audit avant suppression.
5. **`src/test/suite/unit/annotationManager.unit.test.ts`** (632 lignes) — REWRITE/MOVE vers :
   - `src/transactional/__tests__/store-edge-cases.unit.test.ts` pour les tests algorithmiques toujours pertinents.
   - DELETE pour les tests qui exercent l'API publique disparue (`addAnnotation`, `setAnnotationLine` style ancien).
6. **`src/test/suite/annotationReanchor.integration.test.ts`** (333 lignes) — UPDATE en place : commentaires + assertions sur le store. Pas de DELETE.
7. **`src/anchoring/`** dossier entier — DELETE après step 3 (vide après le MOVE).

### Renommings optionnels (round 3 ou plus tard)

- `src/managers/AnnotationManagerErrorHandling.ts` → `src/managers/AnnotationErrorHandling.ts` (cohérence sémantique). Aucun consommateur ne change si l'import path reste un alias temporaire — sinon update à `extension.ts:18`.
- Le namespace `src/managers/` peut être renommé en `src/services/` mais hors scope du Lot 5.

---

## 8. Décisions transverses

### D1 — Pas de changement breaking sur `LinkedAnnotation.targetLine`

`consumer-migration-map.md` propose d'introduire `targetOffset?: number` sur `LinkedAnnotation` (`types.ts:3-7`). **Décision : pas en lot 5**. La résolution `targetLine` se fait au moment de l'affichage via `findAnchor` ; introduire `targetOffset` créerait une dette de migration sur les annotations existantes. À considérer pour un Lot 6 si la robustesse insuffisante apparaît à l'usage.

### D2 — Pas d'EventEmitter Node.js sur le store

L'ancien `AnnotationManager extends EventEmitter`. Le store v2 utilise `vscode.Event`-style. **Décision** : tous les consommateurs migrent vers `onDidChange(...)`. La méthode `notifyChanged()` est ajoutée pour les sites qui faisaient `emit('annotationChanged')` sans payload — cela fire `_onDidChange.fire([])`. Pas de double EventEmitter API à maintenir.

### D3 — Getter dérivé `annotation.line` ?

**Option** : ajouter un getter `line` à un type `AnnotationView` exposé aux consommateurs display-only (Tree/Kanban/HTML templates), distinct du `AnnotationV2` brut.

```typescript
class AnnotationView {
    constructor(private ann: AnnotationV2, private doc: vscode.TextDocument) {}
    get line(): number { return this.doc.positionAt(this.ann.startOffset).line; }
    get id(): string { return this.ann.id; }
    // ... délégation des champs métier
}
```

**Décision** : **PAS en lot 5**. Cela ajoute une couche d'objet pour un confort marginal. Les consommateurs Tree/Kanban/HTML appellent directement `store.offsetToLine(ann.startOffset, document)` quand ils ont besoin de la ligne. À reconsidérer en lot 6 si la verbosité devient pénible.

### D4 — `commands/` dossier extracté ?

L'API `AnnotationManager` exposait ~25 méthodes "commande" (`addAnnotation`, `deleteAnnotationCommand`, etc.). **Décision** : extraire dans un dossier `src/commands/` un fichier par commande. Hors scope strict du Lot 5 mais **fortement recommandé** pour ne pas reconcentrer 25 commandes dans `extension.ts`. Worktree D peut les créer en parallèle.

---

## 9. Récapitulatif (livrables attendus du présent doc)

| Item | Réponse |
|---|---|
| **(a) Chemin du document** | `docs/architecture/lot5-migration-plan.md` |
| **(b) Recommandation finale** | **Option C — Hybride**. Justification : le gap d'API du store impose de toucher au store de toute façon (élargir avec list/upsert/dispose) ; 9/13 fichiers consommateurs sont triviaux (≤20 lignes) ce qui rend un adapter complet sur-dimensionné ; les services extraits sont l'architecture finale, pas un palliatif ; pas de couche transitoire à supprimer. |
| **(c) Ordonnancement** | 3 rounds : R1 séquentiel (enrichir store + créer 4 services) → R2 parallèle 4 worktrees indépendants (A: tree+display, B: linked+review+snippet, C: AI+codelens, D: extension+tests) → R3 séquentiel (suppression AnnotationManager + anchor.ts + smoke E2E + F5 manuel). |
| **(d) Nouveaux services** | `AnnotationPersistence` (load/save/watcher), `AnnotationNavigation` (navigateTo/focusInPanel + composition NavigationStack), `VisibilityFilter` (filtres tag/severity/focus mode), `KanbanColumnStore` (colonnes hors store annotations). Tous sous `src/transactional/`. Plus extraction utilitaires : `internal/hashing.ts` + `internal/anchor-fallback.ts` après dissolution de `src/anchoring/anchor.ts`. |
| **(e) Estimation rounds** | **3 rounds** au total. Round 2 parallélise 4× ⇒ équivalent à ~7 unités d'agent en effort cumulé. Round 3 inclut le smoke E2E + F5 manuel utilisateur (étape humaine bloquante). |
