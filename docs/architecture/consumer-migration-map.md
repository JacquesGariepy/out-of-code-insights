# Consumer Migration Map — AnnotationStore (Option C)

Read-only audit. Inputs for Lot 5 (consumer migration). Every entry cites `file:line`.

Greps used (zéro échantillon — exhaustifs sur `src/`) :

- `\bannotation\.line\b|\bann\.line\b|\ba\.line\b` → 167 hits / 16 fichiers
- `\bannotation\.lineHash\b|\.lineHash\b` → 120+ hits, dominés par `AnnotationManager.ts` + tests
- `\bcontextBefore\b|\bcontextAfter\b` → 256 hits / 6 fichiers
- `\bannotation\.anchor\b|AnnotationAnchor` → 27 hits / 3 fichiers
- `from .*AnnotationManager` → 9 fichiers importateurs
- `from .*anchoring/anchor` → 4 fichiers importateurs
- `\.on\(['"]annotationChanged|\.emit\(['"]annotationChanged` → 4 listeners + 19 emitters

---

## (1) Cartographie file:line → action

### `src/extension.ts` (363 lignes) — IMPACT MEDIUM

| file:line | usage actuel | migration |
|---|---|---|
| `extension.ts:9` | `import { AnnotationManager } from './managers/AnnotationManager'` | remplacer par `import { AnnotationStore } from './store/AnnotationStore'` |
| `extension.ts:18` | `import { AnnotationManagerErrorHandling }` | conserver tel quel (utilitaires d'erreurs, hors scope refonte) ou renommer en `AnnotationStoreErrorHandling` |
| `extension.ts:21` | `let annotationManager: AnnotationManager \| undefined` | `let annotationStore: AnnotationStore \| undefined` |
| `extension.ts:42` | `annotationManager = new AnnotationManager(context)` | `annotationStore = new AnnotationStore(context)` |
| `extension.ts:58` | `context.subscriptions.push(annotationManager)` | identique (Store reste `Disposable`) |
| `extension.ts:93-94` | `annotationManager.loadAnnotations() / refreshAnnotations()` | `annotationStore.load() / refresh()` (à exposer en miroir) |
| `extension.ts:100` | `annotationManager.waitUntilInitialized()` | `annotationStore.waitUntilInitialized()` (API en miroir) |
| `extension.ts:102` | `annotationManager.createChatParticipant(context)` | extraire vers un module séparé `ChatParticipant` (le Store ne devrait pas porter cette responsabilité) |
| `extension.ts:131` | `annotationManager.annotations.values()` | `annotationStore.list()` (collection lecture seule) |
| `extension.ts:146` | `Array.from(annotationManager.annotations.values())` | idem |
| `extension.ts:155` | `line: annotation.line` (payload Kanban) | reste compat si `annotation.line` est un getter dérivé de `positionAt(startOffset).line` |
| `extension.ts:164` | `annotationManager.on('annotationChanged', updateKanban)` | `annotationStore.on('changed', updateKanban)` ou conserver le nom `annotationChanged` pour compat |
| `extension.ts:179` | `annotationManager.on('kanbanColumnsChanged', updateColumns)` | déplacer vers un `KanbanColumnStore` séparé (les colonnes Kanban ne sont pas annotation-state) |
| `extension.ts:278` | `annotationManager.ensureAiConfigured()` | déplacer vers `UnifiedAIAdapter.ensureConfigured()` |
| `extension.ts:347` | `annotationManager.dispose()` | `annotationStore.dispose()` |

**Volume estimé** : ~12-15 lignes touchées + 4 renommings.

---

### `src/tree/AnnotationsTree.ts` (243 lignes) — IMPACT LOW-MEDIUM

| file:line | usage actuel | migration |
|---|---|---|
| `AnnotationsTree.ts:2` | `import { AnnotationManager }` | `import { AnnotationStore }` |
| `AnnotationsTree.ts:11` | `constructor(private annotationManager: AnnotationManager)` | `constructor(private store: AnnotationStore)` |
| `AnnotationsTree.ts:12` | `this.annotationManager.on('annotationChanged', this.refresh.bind(this))` | `this.store.on('changed', this.refresh.bind(this))` |
| `AnnotationsTree.ts:24` | `await this.annotationManager.waitUntilInitialized()` | identique sur Store |
| `AnnotationsTree.ts:25` | `Array.from(this.annotationManager.annotations.values())` | `this.store.list()` |
| `AnnotationsTree.ts:26` | `.filter(a => this.annotationManager.shouldAnnotationBeVisible(a))` | `.filter(a => this.store.isVisible(a))` |
| `AnnotationsTree.ts:35` | `arr.sort((a, b) => a.line - b.line)` | reste compat (line = getter dérivé) |
| `AnnotationsTree.ts:64` | `constructor(public readonly annotation: Annotation, private annotationManager?: AnnotationManager)` | `private store?: AnnotationStore` |
| `AnnotationsTree.ts:84` | `Array.from(this.annotationManager.annotations.values()).filter(...)` | `this.store.list().filter(...)` |
| `AnnotationsTree.ts:86` | `link.targetFile === annotation.file && link.targetLine === annotation.line` | si `targetLine` reste un nombre dérivé : compat ; sinon, étendre `LinkedAnnotation` avec `targetOffset?` |
| `AnnotationsTree.ts:95` | `annotation.line + 1` (display 1-based) | compat |
| `AnnotationsTree.ts:101` | `annotation.line + 1` | compat |
| `AnnotationsTree.ts:108` | `annotation.linkedAnnotations!.length` | compat |
| `AnnotationsTree.ts:111-128` | `link.targetLine` accès | compat |
| `AnnotationsTree.ts:170` | `constructor(private annotationManager: AnnotationManager)` (DragDropController) | `private store: AnnotationStore` |
| `AnnotationsTree.ts:187` | `this.annotationManager.annotations.get(id)` | `this.store.get(id)` |
| `AnnotationsTree.ts:215-216` | `Array.from(this.annotationManager.annotations.values()).filter(a => a.file === draggedFile)` | `this.store.listForFile(draggedFile)` |
| `AnnotationsTree.ts:235` | `this.annotationManager.setAnnotationLine(a, i)` | `this.store.reorderAnnotation(a.id, i)` (le tree drag-and-drop est une **réordination logique** dans le panneau, pas un déplacement de la ligne ancrée — clarifier l'API) |
| `AnnotationsTree.ts:238` | `this.annotationManager.saveAnnotations()` | `this.store.save()` |
| `AnnotationsTree.ts:239` | `this.annotationManager.refreshAnnotations()` | `this.store.refresh()` |
| `AnnotationsTree.ts:240` | `this.annotationManager.emit('annotationChanged')` | si Store expose un EventEmitter typé, `this.store.notifyChanged()` |

**Volume estimé** : ~15-20 lignes (constructor injection + ~6 method renames + 5 listing helpers).

---

### `src/tree/NavigationStackTree.ts` (45 lignes) — IMPACT LOW

| file:line | usage actuel | migration |
|---|---|---|
| `NavigationStackTree.ts:3` | `import { AnnotationManager }` | `import { AnnotationStore }` |
| `NavigationStackTree.ts:10` | `constructor(private annotationManager: AnnotationManager)` | `constructor(private store: AnnotationStore)` |
| `NavigationStackTree.ts:11` | `this.annotationManager.navigationStack.onDidChange(...)` | conserver `navigationStack` exposé par le Store (ou injecter NavigationStack séparément) |
| `NavigationStackTree.ts:23` | `await this.annotationManager.waitUntilInitialized()` | idem Store |
| `NavigationStackTree.ts:24` | `this.annotationManager.navigationStack.getStack()` | idem |
| `NavigationStackTree.ts:27` | `this.annotationManager.annotations.get(id)` | `this.store.get(id)` |
| `NavigationStackTree.ts:37` | `annotation.line + 1` | compat |

**Volume estimé** : ~5 lignes.

---

### `src/views/KanbanView.ts` (953 lignes) — IMPACT LOW (display only)

| file:line | usage actuel | migration |
|---|---|---|
| `KanbanView.ts:43` | commentaire `// Get current columns from AnnotationManager` | mettre à jour la mention |
| `KanbanView.ts:170` | `line: annotation.line` (postMessage payload) | compat (getter dérivé) |
| `KanbanView.ts:814` | `${annotation.line}` (HTML template literal) | compat |

**Volume estimé** : 0-3 lignes (uniquement commentaires si `line` reste un getter).

---

### `src/managers/AnnotationManager.ts` (5567 lignes) — **À SUPPRIMER ENTIÈREMENT**

API publique consommée par d'autres modules (à reproduire dans `AnnotationStore`) :

| Membre | Visibilité | Consommateurs externes |
|---|---|---|
| `annotations: Map<string, Annotation>` | `public` (`:57`) | `extension.ts:131,146` ; `tree/AnnotationsTree.ts:25,84,116,187,215` ; `tree/NavigationStackTree.ts:27` ; `providers/UnifiedAIAdapter.ts:617,692,702` ; `managers/LinkedAnnotationManager.ts:55,111,144,188,198,224,235,339,347,362,376,401,425,432,458,483,516` ; `managers/ReviewModeManager.ts:214,265,305,597` |
| `navigationStack: NavigationStack` | `public` (`:51`) | `tree/NavigationStackTree.ts:11,24` ; `managers/LinkedAnnotationManager.ts:171` |
| `annotationsTreeDataProvider` | `public` | `managers/LinkedAnnotationManager.ts:284-285` |
| `annotationsEnabled: boolean` | `public` | `providers/AnnotationCodeLensProvider.ts:8` |
| `config: ExtensionConfig` | `public get` (`:149`) | `providers/AnnotationCodeLensProvider.ts:8` ; `managers/ReviewModeManager.ts:222` |
| `clipboardWindowMs: number` | `public` (`:80`) | tests d'intégration uniquement |
| `deletedRecentlyTtlMs: number` | `public` (`:100`) | tests d'intégration uniquement |
| `loadAnnotations()` | `public async` (`:1863`) | `extension.ts:93` |
| `refreshAnnotations()` | `public async` (`:5012`) | `extension.ts:94` ; `tree/AnnotationsTree.ts:239` |
| `saveAnnotations()` | `public async` (`:1824`) | `tree/AnnotationsTree.ts:238` ; `managers/LinkedAnnotationManager.ts:95,128` ; `managers/ReviewModeManager.ts:229` |
| `waitUntilInitialized()` | `public async` (`:145`) | `extension.ts:100` ; `tree/AnnotationsTree.ts:24` ; `tree/NavigationStackTree.ts:23` |
| `dispose()` | `public` (`:3173`) | `extension.ts:347` |
| `createChatParticipant(context)` | `public` (`:312`) | `extension.ts:102` |
| `ensureAiConfigured()` | `public async` (`:270`) | `extension.ts:278` |
| `setAnnotationLine(annotation, newLine, doc?)` | `public` (`:1696`) | `tree/AnnotationsTree.ts:235` |
| `populateAnchor(annotation, document, line)` | `public async` (`:3356`) | `providers/UnifiedAIAdapter.ts:850,898` |
| `getAnnotationsForFile(fileName)` | `public` (`:3685`) | `providers/AnnotationCodeLensProvider.ts:12` |
| `shouldAnnotationBeVisible(annotation)` | `public` (`:4910`) | `providers/AnnotationCodeLensProvider.ts:17` ; `tree/AnnotationsTree.ts:26` |
| `focusAnnotationInPanel(id)` | `public` (`:2117`) | `managers/LinkedAnnotationManager.ts:174` |
| `navigateToAnnotation(id, record?)` | `public async` (`:2085`) | `managers/ReviewModeManager.ts:379` |
| `getLinkedAnnotationManager()` | `public` (`:158`) | utilisé via accès `as any` à `:610` de `UnifiedAIAdapter.ts` |
| `handleError(message, error)` | `public` (`:5420`) | `extension.ts:189,210,236` |
| `searchAnnotationById(id)` | `public async` (`:599`) | dispatch via VS Code command |
| `searchAnnotationsByFilter(...)` | `public async` (`:604`) | dispatch |
| `createLinkedAnnotation(...)` | `public async` (`:638`) | dispatch |
| `navigateToLinked(id)` | `public async` (`:642`) | dispatch |
| `applyTemplate(...)`, `createTemplate(...)`, `getTemplates()`, `addSnippet(...)`, `applySnippet(...)`, `previewSnippet(...)`, `getSnippets()` | `public` (`:647-673`) | dispatch + délégation à TemplateManager / SnippetManager |
| `moveAnnotationUp(id)`, `moveAnnotationDown(id)`, `moveUpCommand()`, `moveDownCommand()` | `public` (`:1378-5211`) | dispatch via commands |
| `addAnnotation(args?)` | `public async` (`:1635`) | dispatch + `extension.ts:271-291` (générique) |
| `deleteAnnotationCommand()`, `editAnnotationCommand()`, `toggleAnnotationsDisplay()`, `importAnnotationsJSON()`, `exportAnnotationsJSON()`, `resolveAnnotation(id?)` | `public` | dispatch via commands |
| `computeResolvedAnchor(...)` | `public` (`:3448`) | tests d'intégration uniquement |
| `initializeStatusBar()` | `public` (`:5511`) | dispatch interne |
| `configureProviderAndKeys()` | `public async` (`:237`) | dispatch via command |
| `resetSearch()` | `public async` (`:115`) | dispatch via command |
| `getTemplateManager()` | `public` (`:154`) | uniquement interne (mais `public`) |
| `getSnippetManager()` | `public` (`:162`) | uniquement interne (mais `public`) |
| `emit('annotationChanged')` (EventEmitter) | hérité (`:46` extends `EventEmitter`) | `tree/AnnotationsTree.ts:240` ; `managers/LinkedAnnotationManager.ts:104,137` ; `providers/UnifiedAIAdapter.ts:865` |

**Émetteurs internes de `'annotationChanged'`** (14 sites) : `:196, :452, :1077, :1108, :1113, :1129, :1172, :1625, :1686, :1804, :1957, :1981, :2013, :4109, :5287, :5301`. À reproduire de façon centralisée par le Store sur chaque mutation persistée.

**Émission `'kanbanColumnsChanged'`** : à grep séparément (existe au moins en `extension.ts:179` côté listener).

**Volume** : DELETE (~5567 lignes). À remplacer par `AnnotationStore` neuf.

---

### `src/managers/SnippetManager.ts` (504 lignes) — IMPACT LOW

| file:line | usage actuel | migration |
|---|---|---|
| `SnippetManager.ts:3` | `import { Annotation } from '../common/types'` | identique (le Store ne change PAS le type `Annotation`, il l'enrichit) |
| `SnippetManager.ts:114` | `const line = annotation.line - 1` | compat (getter dérivé) |
| `SnippetManager.ts:151` | `const line = annotation.line - 1` | compat |

**N'importe PAS `AnnotationManager`.** Volume estimé : 0-3 lignes (seulement si l'on étend `Annotation` de manière breaking).

---

### `src/managers/LinkedAnnotationManager.ts` (544 lignes) — IMPACT HIGH

| file:line | usage actuel | migration |
|---|---|---|
| `LinkedAnnotationManager.ts:4` | `import { AnnotationManager }` | `import { AnnotationStore }` |
| `LinkedAnnotationManager.ts:23-24` | `extends EventEmitter` ; `private annotationManager: AnnotationManager` | `private store: AnnotationStore` |
| `LinkedAnnotationManager.ts:27` | constructor signature | mise à jour |
| `LinkedAnnotationManager.ts:41` | `this.annotationManager.on('annotationChanged', () => {...})` | `this.store.on('changed', ...)` |
| `LinkedAnnotationManager.ts:55,111,144,188` | `this.annotationManager.annotations.get(sourceId)` | `this.store.get(sourceId)` |
| `LinkedAnnotationManager.ts:95,128` | `await this.annotationManager.saveAnnotations()` | `await this.store.save()` |
| `LinkedAnnotationManager.ts:104,137` | `this.annotationManager.emit('annotationChanged')` | `this.store.notifyChanged()` (ou laisser le Store gérer l'émission après mutation) |
| `LinkedAnnotationManager.ts:171` | `this.annotationManager.navigationStack.push(...)` | `this.store.navigationStack.push(...)` ou injection séparée de `NavigationStack` |
| `LinkedAnnotationManager.ts:174` | `this.annotationManager.focusAnnotationInPanel(...)` | extraire `focusAnnotationInPanel` vers un service UI dédié |
| `LinkedAnnotationManager.ts:198,224,235,362,376,401,425,432,483,516` | `this.annotationManager.annotations.{values,iter}` | `this.store.list()` ou itérateurs équivalents |
| `LinkedAnnotationManager.ts:284-285` | `this.annotationManager.annotationsTreeDataProvider.refresh()` | injecter `AnnotationsTreeDataProvider` directement, ou émettre un event auquel le tree s'abonne |
| `LinkedAnnotationManager.ts:339,347,458` | `annotations.{get,size}` | idem |
| `LinkedAnnotationManager.ts:60-280` (15 hits) | `targetLine`, `annotation.line`, `link.targetLine` | compat tant que `line` reste dérivé ; mais si `LinkedAnnotation` doit gagner `targetOffset?`, mise à jour du schéma `types.ts:3-7` |

**Volume estimé** : ~50 lignes (constructor + ~25 call-sites). Un des plus gros consommateurs.

---

### `src/managers/ReviewModeManager.ts` (714 lignes) — IMPACT MEDIUM

| file:line | usage actuel | migration |
|---|---|---|
| `ReviewModeManager.ts:4` | `import { AnnotationManager }` | `import { AnnotationStore }` |
| `ReviewModeManager.ts:38` | constructor | rename |
| `ReviewModeManager.ts:54` | `this.annotationManager.on('annotationChanged', ...)` | `this.store.on('changed', ...)` |
| `ReviewModeManager.ts:214` | `this.annotationManager.annotations.get(id)` | `this.store.get(id)` |
| `ReviewModeManager.ts:222` | `this.annotationManager.config.username` | exposer `config` sur Store ou injecter `ConfigurationManager` séparément |
| `ReviewModeManager.ts:229` | `await this.annotationManager.saveAnnotations()` | `this.store.save()` |
| `ReviewModeManager.ts:265,305,597` | `this.annotationManager.annotations.values()` | `this.store.list()` |
| `ReviewModeManager.ts:365` | `return a.line - b.line` (sort) | compat |
| `ReviewModeManager.ts:379` | `this.annotationManager.navigateToAnnotation(annotation.id, false)` | déplacer vers un `NavigationService` ou conserver sur Store |
| `ReviewModeManager.ts:533` | `${annotation.line}` (HTML) | compat |

**Volume estimé** : ~10-12 lignes.

---

### `src/providers/UnifiedAIAdapter.ts` (1183 lignes) — IMPACT MEDIUM-HIGH

| file:line | usage actuel | migration |
|---|---|---|
| `UnifiedAIAdapter.ts:3` | `import { AnnotationManager }` | `import { AnnotationStore }` |
| `UnifiedAIAdapter.ts:14,46` | field + constructor | rename |
| `UnifiedAIAdapter.ts:285,508,511,691,775,787` | `position.line`, `selection.start.line`, etc. (FALSE POSITIVES — ce sont `vscode.Position`/`vscode.Selection`, pas `Annotation`) | aucun |
| `UnifiedAIAdapter.ts:610` | `(this.annotationManager as any).linkedAnnotationManager` | accès cassé par hack `as any` ; à proprement injecter `LinkedAnnotationManager` |
| `UnifiedAIAdapter.ts:617,692` | `Array.from(this.annotationManager.annotations.values())` | `this.store.list()` |
| `UnifiedAIAdapter.ts:625` | `${ann.file}:${ann.line}` (display) | compat |
| `UnifiedAIAdapter.ts:651` | `selected[j].annotation.line` (payload) | compat |
| `UnifiedAIAdapter.ts:693` | `ann.line === currentLine` | compat |
| `UnifiedAIAdapter.ts:702` | `this.annotationManager.annotations.set(annotation.id, updatedAnnotation)` | **mutation directe Map** → remplacer par `this.store.upsert(updatedAnnotation)` (le Store doit owner les mutations pour garantir le journal transactionnel et l'émission d'event) |
| `UnifiedAIAdapter.ts:837` | `line: suggestion.line ?? lineNumber` (payload AI) | compat |
| `UnifiedAIAdapter.ts:850,898` | `await this.annotationManager.populateAnchor(annotation, document, annotation.line)` | `await this.store.populateAnchor(annotation, document, annotation.line)` ou centraliser le calcul d'ancre dans le Store |
| `UnifiedAIAdapter.ts:865` | `manager.emit('annotationChanged')` | retirer (l'émission devrait être implicite après `upsert`) |
| `UnifiedAIAdapter.ts:880,917` | `${ann.line}` display | compat |

**Volume estimé** : ~30-35 lignes (notamment `:702` qui est un `set` direct sur la Map, et `:610` qui est un cheat).

---

### `src/providers/UnifiedAIProvider.ts` (465 lignes) — IMPACT NONE-LOW

| file:line | usage actuel | migration |
|---|---|---|
| `UnifiedAIProvider.ts:352` | `line: ann.line ? (ann.line - 1) : baseLineNumber` (parsing JSON AI) | compat (champ `line` dans JSON parsé, pas dans `Annotation` typé) |

**N'importe PAS `AnnotationManager`. Aucune dépendance vers le Store.** Volume estimé : 0 ligne.

---

### `src/providers/AnnotationCodeLensProvider.ts` (37 lignes) — IMPACT LOW

| file:line | usage actuel | migration |
|---|---|---|
| `AnnotationCodeLensProvider.ts:2` | `import { AnnotationManager }` | `import { AnnotationStore }` |
| `AnnotationCodeLensProvider.ts:5` | `constructor(private annotationManager: AnnotationManager)` | `private store: AnnotationStore` |
| `AnnotationCodeLensProvider.ts:8` | `this.annotationManager.annotationsEnabled \|\| this.annotationManager.config.codelens.enable` | `this.store.isEnabled() && this.store.getConfig().codelens.enable` |
| `AnnotationCodeLensProvider.ts:12` | `this.annotationManager.getAnnotationsForFile(document.fileName)` | `this.store.listForFile(document.fileName)` |
| `AnnotationCodeLensProvider.ts:17` | `this.annotationManager.shouldAnnotationBeVisible(annotation)` | `this.store.isVisible(annotation)` |
| `AnnotationCodeLensProvider.ts:18` | `const line = annotation.line` | compat |
| `AnnotationCodeLensProvider.ts:21` | `annotations.filter(a => a.line === line)` | compat |

**Volume estimé** : ~7 lignes (très petit fichier).

---

### `src/providers/ClaudeCodeProvider.ts` (392 lignes) — IMPACT NONE

| file:line | usage actuel | migration |
|---|---|---|
| `ClaudeCodeProvider.ts:322` | `line: baseLineNumber + (ann.line \|\| 0)` (parsing JSON AI) | compat |

**N'importe PAS `AnnotationManager` ni `anchor.ts`. Non-impacté.**

---

### `src/anchoring/anchor.ts` (487 lignes) — **À SUPPRIMER ENTIÈREMENT (ou réduire à un facade)**

Exports actuels :

| Symbol | Localisation | Importé par | Volume usage |
|---|---|---|---|
| `normalizeLine` | `:30` | `anchoring/__tests__/anchor.test.ts:8` | 1 fichier |
| `hashLine` | `:42` | `managers/AnnotationManager.ts:24` ; `test/integration/annotationManager.integration.test.ts:15` ; `test/suite/unit/annotationManager.unit.test.ts:15` ; `anchoring/__tests__/anchor.test.ts:9` | 4 fichiers |
| `isEmptyLineHash` | `:54` | `anchoring/__tests__/anchor.test.ts:15` | 1 fichier |
| `EMPTY_LINE_HASH` | `:23` | `managers/AnnotationManager.ts:25` ; `anchoring/__tests__/anchor.test.ts:14` | 2 fichiers |
| `captureAnchor` | `:109` | `managers/AnnotationManager.ts:21` ; `test/integration/annotationManager.integration.test.ts:12` ; `test/suite/unit/annotationManager.unit.test.ts:16` ; `anchoring/__tests__/anchor.test.ts:10` | 4 fichiers |
| `findAnchor` | `:238` | idem 4 fichiers | 4 fichiers |
| `detectMoves` | `:340` | `managers/AnnotationManager.ts:23` ; `test/integration/annotationManager.integration.test.ts:14` ; `test/suite/unit/annotationManager.unit.test.ts:18` ; `anchoring/__tests__/anchor.test.ts:12` | 4 fichiers |
| `reanchor` | `:455` | `managers/AnnotationManager.ts:28` ; `test/suite/unit/annotationManager.unit.test.ts:19` ; `anchoring/__tests__/anchor.test.ts:13` | 3 fichiers (intégration test n'a PAS migré) |
| `TextDocumentLike` (interface) | `:8` | tests + (`AnnotationManager.ts` n'utilise PAS, mais expose `vscode.TextDocument`) | 3 fichiers |
| `AnchorData` (interface) | `:59` | `managers/AnnotationManager.ts:26` ; tests | 3 fichiers |
| `MovedBlock` (interface) | `:323` | `managers/AnnotationManager.ts:27` ; `test/integration/annotationManager.integration.test.ts:18` | 2 fichiers |
| `CaptureOptions`, `FindAnchorOptions`, `ReanchorStatus`, `ReanchorResult`, `ReanchorInput` | `:77,176,398,412,425` | non importés (types internes/auxiliaires) | 0 fichier |

**Volume** : DELETE (~487 lignes). Si on conserve `hashLine`/`reanchor` comme outillage de fallback dans le Store, replier dans `src/store/internal/hashing.ts` et `src/store/internal/anchor-fallback.ts` (≤100 lignes total).

---

### `src/extension.ts` (déjà couvert ci-dessus)

---

### `src/common/types.ts` (176 lignes) — IMPACT MEDIUM

| file:line | usage actuel | migration |
|---|---|---|
| `types.ts:3-7` | `LinkedAnnotation { targetFile, targetLine, relationship }` | étendre avec `targetOffset?: number` (optionnel pour compat backward) |
| `types.ts:37-57` | `AnnotationAnchor { kind, originalLine, targetLine, symbolName?, anchorTextHash, contextBefore[], contextAfter[] }` | compléter avec `startOffset?`, `endOffset?` (modèle hybride recommandé phase 1) |
| `types.ts:67-113` | `Annotation { id, file, line, message, ..., lineHash?, contextBefore?, contextAfter?, fileUri?, anchor?, ... }` | ajouter `startOffset?: number`, `endOffset?: number`, `schemaVersion?: number` ; `line` reste mais devient dérivable |

**Aucun import depuis `AnnotationManager.ts` ou `anchor.ts`** (schéma pur). Volume estimé : ~10-30 lignes (extensions de schéma).

---

### Tests (impact divers)

#### `src/test/integration/annotationManager.integration.test.ts` (3340 lignes) — IMPACT HIGH

- `:11-19` import `captureAnchor, findAnchor, detectMoves, hashLine, TextDocumentLike, AnchorData, MovedBlock` (PAS de `reanchor`)
- 67 hits sur `.line` ; 125 hits sur `contextBefore/After` ; 100+ hits sur `.lineHash`
- Fichier auto-suffisant : **mirroir** de la pipeline AnnotationManager (helpers `applyDocumentChange`, `tryRestoreFromDeletedRecently` dupliqués)

**Stratégie migration** : remplacer ENTIÈREMENT par tests basés sur `AnnotationStore`, ou conserver comme tests "algorithmiques" si `hashLine`/`captureAnchor`/`findAnchor` survivent comme outillage interne. Volume ~3340 lignes (à arbitrer : suppression vs réécriture).

#### `src/test/suite/annotationReanchor.integration.test.ts` (333 lignes) — IMPACT MEDIUM

- Test black-box d'extension activée. Mentions `AnnotationManager` dans commentaires uniquement (`:11,15,22,156,196,261`).
- Volume estimé : ~50 lignes (mise à jour des commentaires + assertions sur le Store si l'API publique change de nom).

#### `src/test/suite/unit/annotationManager.unit.test.ts` (632 lignes) — IMPACT MEDIUM

- Imports anchor.ts (`:14-22`) + 19 tests (17 préexistants + 2 régressions ajoutées en lot précédent).
- Stratégie déclarée du fichier (`:1-12`) : ne PAS instancier `AnnotationManager`, exercer les algorithmes en isolation.
- Si `hashLine`/`captureAnchor`/`reanchor` deviennent des helpers internes du Store, les imports doivent être réorientés (`from '../../../store/internal/...'`).
- Volume estimé : ~30-50 lignes (imports + suite supplémentaire pour offset-based).

#### `src/anchoring/__tests__/anchor.test.ts` (700 lignes) — IMPACT HIGH

- Tests purs des fonctions exportées par `anchor.ts`. Si le module est dissous : déplacer les tests pertinents vers `src/store/internal/__tests__/` ; supprimer ceux qui testent du code mort.
- Volume : ~700 lignes (DELETE/MOVE).

#### `src/test/suite/annotations.test.ts`, `src/test/suite/extension.test.ts`, `src/test/suite/utils.test.ts`, `src/test/suite/unit/utils.unit.test.ts`

- Aucune référence à `Annotation.line` / `lineHash` / `contextBefore` / `AnnotationAnchor` / `AnnotationManager` (sauf une mention en commentaire dans `utils.test.ts:49`).
- **NON-IMPACTÉ.** Aucun lot 5 nécessaire.

---

### Autres modules détectés — NON-IMPACTÉS (mention explicite pour ne pas les oublier)

| Fichier | Statut |
|---|---|
| `src/managers/AIProfileManager.ts` | seulement chaîne `'Annotation Prefix'` (`:166`) — non-impacté |
| `src/managers/ConfigurationManager.ts` | gère `maxAnnotationsPerFile` etc. via `vscode.workspace.getConfiguration` ; **aucune référence à `AnnotationManager` ni à `anchor.ts`** — non-impacté |
| `src/managers/LocalizationManager.ts` | utilitaires i18n — non-impacté |
| `src/managers/NavigationStack.ts` | structure de données pure — non-impacté ; sera composé par le Store |
| `src/managers/AnnotationManagerErrorHandling.ts` | utilitaires d'erreurs ; importé par `extension.ts:18` ; **aucune dépendance à `Annotation.line` / `anchor.ts`** — peut-être renommer mais pas besoin de refondre |
| `src/managers/TemplateManager.ts` | seul `'annotation.templates'` comme storage key — non-impacté |
| `src/managers/UserProfileManager.ts` | profils utilisateur ; aucune ref — non-impacté |
| `src/providers/ClaudeSDKWrapper.ts` | wrapper SDK Claude ; aucune ref `Annotation` — non-impacté |
| `src/common/localize.ts`, `src/common/utils.ts` | utilitaires ; non-impacté |
| `src/test/suite/index.ts` | bootstrap Mocha — non-impacté |

---

## (3) Surface API publique d'AnnotationStore (à dimensionner en miroir)

Synthèse des **API publiques** d'AnnotationManager **effectivement consommées hors classe** (donc obligatoires pour le Store) :

```typescript
class AnnotationStore extends EventEmitter implements vscode.Disposable {
    // Collection (read-only public)
    readonly navigationStack: NavigationStack;        // ext, NavStackTree, LinkedAnnotationManager
    isEnabled(): boolean;                              // CodeLensProvider
    getConfig(): ExtensionConfig;                      // CodeLensProvider, ReviewMode

    // Lifecycle
    async load(): Promise<void>;                       // extension.ts
    async save(): Promise<void>;                       // tree, LinkedAnno, ReviewMode
    async refresh(): Promise<void>;                    // extension.ts, tree
    async waitUntilInitialized(): Promise<void>;       // extension.ts, trees
    dispose(): void;                                   // extension.ts

    // Read accessors (replace direct Map access)
    list(): readonly Annotation[];                     // tree, AI, Linked, Review, ext
    listForFile(file: string): readonly Annotation[];  // tree drag-drop, CodeLens
    get(id: string): Annotation | undefined;           // tree, NavStack, Linked
    size(): number;                                    // Linked stats

    // Write API (replaces Map.set + private mutations)
    upsert(annotation: Annotation): Promise<void>;     // AI adapter (currently Map.set direct)
    setAnnotationLine(annotation, line): void;         // tree drag-drop reorder
    populateAnchor(annotation, document, line): Promise<void>;  // AI adapter

    // Display predicates
    isVisible(annotation: Annotation): boolean;        // tree, CodeLens

    // Navigation / focus
    navigateToAnnotation(id, record?): Promise<void>;  // ReviewMode
    focusAnnotationInPanel(id): void;                  // Linked

    // Events (EventEmitter)
    // 'changed' (formerly 'annotationChanged')
    // 'kanbanColumnsChanged' — CONSIDER moving to KanbanColumnStore
}
```

**Méthodes à NE PAS exposer sur le Store** (à extraire vers d'autres modules) :
- `createChatParticipant(...)` → module `ChatParticipant`
- `ensureAiConfigured()` → `UnifiedAIAdapter`
- `applyTemplate, createTemplate, getTemplates` → `TemplateManager` (déjà existant, juste injecter)
- `addSnippet, applySnippet, previewSnippet, getSnippets` → `SnippetManager`
- Toutes les commandes (`addAnnotation, deleteAnnotationCommand, ...`) → handlers de commande dédiés dans `extension.ts` ou `commands/` qui injectent le Store

**Mutation directe à éliminer** : `UnifiedAIAdapter.ts:702` fait `this.annotationManager.annotations.set(...)` — c'est l'unique site externe de mutation directe de la Map. Doit obligatoirement passer par `store.upsert(...)`.

---

## (4) Listeners `'annotationChanged'` à réabonner

| Subscriber | file:line | Action après mutation |
|---|---|---|
| Kanban update payload | `extension.ts:164` | re-post payload au webview |
| AnnotationsTree refresh | `tree/AnnotationsTree.ts:12` | `_onDidChangeTreeData.fire()` |
| LinkedAnnotationManager cache | `managers/LinkedAnnotationManager.ts:41` | invalidation cache liens |
| ReviewModeManager refresh | `managers/ReviewModeManager.ts:54` | recalcul état revue |

**Total : 4 abonnés** (le Store doit garantir au moins une émission après chaque mutation persistée).

**Émetteurs externes à reroter** :
- `tree/AnnotationsTree.ts:240` (post drag-drop) → `store.notifyChanged()` ou laisser le Store émettre après `setAnnotationLine`
- `managers/LinkedAnnotationManager.ts:104, 137` → idem après mutation des liens
- `providers/UnifiedAIAdapter.ts:865` → retirer (le Store émet implicitement après `upsert`)

---

## (5) Volume de modifications par fichier — arbitrage parallélisme Lot 5

| Fichier | Lignes totales | Lignes touchées (estimation) | Effort | Parallélisable ? |
|---|---:|---:|---|---|
| `src/managers/AnnotationManager.ts` | 5567 | DELETE | XL | non — bloquant racine |
| `src/anchoring/anchor.ts` | 487 | DELETE / réduire à ≤100 | M | dépend du Store |
| `src/test/integration/annotationManager.integration.test.ts` | 3340 | rewrite ou suppress | XL | indépendant ; peut commencer |
| `src/anchoring/__tests__/anchor.test.ts` | 700 | DELETE/MOVE | L | indépendant |
| `src/test/suite/unit/annotationManager.unit.test.ts` | 632 | ~30-50 | M | indépendant |
| `src/managers/LinkedAnnotationManager.ts` | 544 | ~50 | L | dépend du Store |
| `src/test/suite/annotationReanchor.integration.test.ts` | 333 | ~50 | M | dépend du Store |
| `src/providers/UnifiedAIAdapter.ts` | 1183 | ~30-35 | M | dépend du Store + `LinkedAnnotationManager` |
| `src/managers/ReviewModeManager.ts` | 714 | ~10-12 | S | dépend du Store |
| `src/extension.ts` | 363 | ~12-15 | S | dépend du Store + `KanbanColumnStore` |
| `src/tree/AnnotationsTree.ts` | 243 | ~15-20 | S | dépend du Store |
| `src/views/KanbanView.ts` | 953 | 0-3 (commentaires) | XS | trivial |
| `src/providers/AnnotationCodeLensProvider.ts` | 37 | ~7 | XS | dépend du Store |
| `src/tree/NavigationStackTree.ts` | 45 | ~5 | XS | dépend du Store |
| `src/managers/SnippetManager.ts` | 504 | 0-3 | XS | trivial (n'importe pas AM) |
| `src/common/types.ts` | 176 | ~10-30 | S | indépendant ; peut commencer |
| `src/providers/UnifiedAIProvider.ts` | 465 | 0 | none | non-impacté |
| `src/providers/ClaudeCodeProvider.ts` | 392 | 0 | none | non-impacté |
| `src/managers/AnnotationManagerErrorHandling.ts` | — | rename optionnel | XS | trivial |
| `src/managers/{AIProfileManager, ConfigurationManager, LocalizationManager, NavigationStack, TemplateManager, UserProfileManager}.ts` | — | 0 | none | non-impacté |
| `src/test/suite/{annotations.test, extension.test, utils.test, unit/utils.unit.test}.ts` | — | 0 | none | non-impacté |

### Recommandation parallélisme Lot 5

**Étape 1 (séquentiel)** : implémenter `AnnotationStore` + extension du schéma `types.ts` → débloque tout le reste.

**Étape 2 (parallélisable, 4 worktrees)** :
- Worktree A : `AnnotationsTree.ts` + `NavigationStackTree.ts` + `KanbanView.ts` (display + tree)
- Worktree B : `LinkedAnnotationManager.ts` + `ReviewModeManager.ts` (managers consommateurs)
- Worktree C : `UnifiedAIAdapter.ts` + `AnnotationCodeLensProvider.ts` + `SnippetManager.ts` (providers + AI)
- Worktree D : `extension.ts` + tests d'intégration (smoke)

**Étape 3 (séquentiel)** : suppression `AnnotationManager.ts` + `anchor.ts` après que tous les imports ont été migrés.

**Tests** : peuvent être réécrits **en parallèle de l'étape 1** (worktree dédié) puisque indépendants de l'implémentation Store tant que l'API publique est figée par contrat.

---

## Annexes — comptages exhaustifs (pour QA de complétude)

| Pattern | Total hits | Fichiers |
|---|---:|---:|
| `\bannotation\.line\b\|\bann\.line\b\|\ba\.line\b\|\.targetLine\b` | 167 | 16 |
| `\bannotation\.lineHash\b\|\.lineHash\b` | ~120 | 5 |
| `\bcontextBefore\b\|\bcontextAfter\b` | 256 | 6 |
| `\bannotation\.anchor\b\|AnnotationAnchor` | 27 | 3 |
| `import.*AnnotationManager\b` | 9 | 9 |
| `from .*anchoring/anchor` | 4 | 4 |
| `\.on\(['"]annotationChanged` | 4 | 4 |
| `\.emit\(['"]annotationChanged` | 19 | 4 |
| `annotationManager\.\w+` | 68 | 7 |

**Total fichiers consommateurs uniques** : 13 fichiers `src/` non-test + 4 fichiers de test directement impactés + 6 modules `managers/` non-impactés explicitement listés.

Audit clos. Aucun fichier de code modifié — uniquement ce document créé.
