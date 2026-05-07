# Audit codebase — Refonte Option C (phase 1/2)

Inventaire architectural exhaustif du code à remplacer/recâbler dans la
refonte d'AnnotationManager (spec §1-§10, 14 cas §7.1-§7.14).

Read-only, pas d'architecture cible. Format machine-readable.

---

## 1. `src/managers/AnnotationManager.ts` (5532 lignes)

### 1.1 Méthodes publiques (44)

| Méthode | Signature | Sous-domaine | Intent |
|---|---|---|---|
| `waitUntilInitialized` | `(): Promise<void>` | lifecycle | Attendre fin init |
| `config` (getter) | `() => ExtensionConfig` | persistence | Snapshot config courante |
| `getTemplateManager` | `(): TemplateManager` | ui-bridge | Délégué templates |
| `getSnippetManager` | `(): SnippetManager` | ui-bridge | Délégué snippets |
| `resetSearch` | `(): Promise<void>` | query | Reset filtre panel |
| `configureProviderAndKeys` | `(): Promise<void>` | ai | Configurer provider + clé |
| `ensureAiConfigured` | `(): boolean` | ai | Garde précondition AI |
| `createChatParticipant` | `(ctx): void` | ai | Enregistre participant chat |
| `createLinkedAnnotation` | `(srcId, targetFile, targetLine): Promise<void>` | linked | Délégué LinkedAnnotationManager |
| `navigateToLinked` | `(annotationId): Promise<void>` | linked | Saut vers annotation liée |
| `applyTemplate` | `(template, vars): Promise<string>` | ui-bridge | Substitue variables template |
| `createTemplate` | `(template): Promise<AnnotationTemplate>` | ui-bridge | Crée template |
| `getTemplates` | `(): AnnotationTemplate[]` | ui-bridge | Liste templates |
| `addSnippet` | `(annotation, code, lang): Promise<Annotation>` | ui-bridge | Délégué snippet add |
| `applySnippet` | `(annotation, editor): Promise<boolean>` | ui-bridge | Délégué snippet apply |
| `previewSnippet` | `(annotation, editor): Promise<any>` | ui-bridge | Délégué snippet preview |
| `getSnippets` | `(): SnippetHistoryEntry[]` | ui-bridge | Délégué snippet history |
| `moveAnnotationUp` | `(annotationId): Promise<void>` | mutation | -1 ligne + recapture anchor |
| `moveAnnotationDown` | `(annotationId): Promise<void>` | mutation | +1 ligne + recapture anchor |
| `searchAnnotationById` | `(annotationId): Promise<void>` | query | Focus annotation par id |
| `searchAnnotationsByFilter` | `(type, value): Promise<void>` | query | Filtre tag/sev/auteur |
| `addAnnotation` | `(args?: {line}): Promise<void>` | mutation | Crée annotation depuis curseur |
| `setAnnotationLine` | `(annotation, newLine, doc?): void` | anchoring | Repositionner + recapture |
| `importAnnotationsJSON` | `(): Promise<void>` | persistence | Import bulk JSON |
| `exportAnnotationsJSON` | `(): Promise<void>` | persistence | Export bulk JSON |
| `saveAnnotations` | `(): Promise<void>` | persistence | Persiste Map → disque |
| `loadAnnotations` | `(): Promise<void>` | persistence | Charge disque → Map |
| `navigateToAnnotation` | `(id, record?): Promise<void>` | navigation | Open + cursor + push stack |
| `focusAnnotationInPanel` | `(id): void` | ui-bridge | Focus dans webview panel |
| `dispose` | `(): void` | lifecycle | Nettoie timers + decorations |
| `getAnnotationsForFile` | `(fileName): Annotation[]` | query | Annotations d'un fichier |
| `shouldAnnotationBeVisible` | `(annotation): boolean` | query | Filtre + disabledTags |
| `computeResolvedAnchor` | `(doc, annotation): ResolvedAnnotationAnchor` | anchoring | Recalcule status à refresh |
| `populateAnchor` | `(annotation, doc, cursorLine): Promise<void>` | anchoring | Capture initial à création |
| `deleteAnnotationCommand` | `(): Promise<void>` | mutation | Suppression depuis raccourci |
| `editAnnotationCommand` | `(): Promise<void>` | mutation | Édition depuis raccourci |
| `moveUpCommand` / `moveDownCommand` | `(): Promise<void>` | mutation | Wrappers raccourcis |
| `toggleAnnotationsDisplay` | `(): void` | lifecycle | Bascule global on/off |
| `initializeStatusBar` | `(): void` | ui-bridge | Compteur status bar |
| `refreshAnnotations` | `(): Promise<void>` | lifecycle | Recompute decorations tous editors |
| `resolveAnnotation` | `(id?): Promise<void>` | mutation | Marque résolue |

Méthodes privées notables (recensées par l'audit Explore, ~87 au total) :
`promptAnnotationMessage`, `aiSuggestAnnotation`, `replyToAnnotation`,
`changeSeverity`, `editAnnotationTags`, `convertAnnotationToIssue`,
`modifyAnnotation`, `handleDocumentChange` (le hook
`onDidChangeTextDocument` historique), `repairBlankLineTrackingAnchors`,
`resolveTrackingAnchor`, `migrateLegacyAnnotation`,
`deduplicateLegacyAnnotations`, `snapshotDocument`,
`tryRestoreFromDeletedRecently`, `showCutExpiredToast`,
`highlightLineTemporarily`, `getAnnotationsPanelHtml`,
`updateStatusBar`, `saveKanbanColumns`, `loadKanbanColumns`.

### 1.2 Événements émis (1 channel via `EventEmitter` héritage)

| Event | Payload | Émis depuis | Description |
|---|---|---|---|
| `annotationChanged` | `(annotation? \| undefined)` | `initialize`, `addAnnotation`, `aiSuggestAnnotation`, `changeSeverity`, `editAnnotationTags`, `deleteAnnotation`, `replyToAnnotation`, `convertAnnotationToIssue`, `modifyAnnotation` | Broadcast generic |
| `kanbanColumnsChanged` | `void` | (mutations colonnes Kanban) | Notifie webview Kanban |

`extension.ts` consomme ces deux events via `manager.on(...)` /
`manager.removeListener(...)`.

### 1.3 Champs/propriétés d'état (15 structures majeures)

| Champ | Type | Visibilité | Rôle |
|---|---|---|---|
| `annotations` | `Map<string, Annotation>` | public | Source de vérité in-memory |
| `kanbanColumns` | `Map<string, string>` | private | Mapping `id → column` (todo/...) |
| `documentSnapshots` | `Map<string, string[]>` | private | Snapshot pre-change pour move detection |
| `recentDeletions` | `Map<string, {annotation, deletedAt, offsetInBlock, ...}>` | private | Buffer cut TTL=`clipboardWindowMs` (5000) |
| `deletedRecently` | `Map<string, {annotation, removedAt}>` | private | Buffer undo silencieux TTL=`deletedRecentlyTtlMs` (30000) |
| `decorationTypes` | `Map<string, TextEditorDecorationType>` | private | Cache decoration par annotation |
| `annotationsTreeView` | `TreeView<TreeItem> \| undefined` | public | Référence tree panel |
| `annotationsTreeDataProvider` | `AnnotationsTreeDataProvider \| undefined` | public | Provider tree |
| `stackTreeView` | `TreeView<TreeItem> \| undefined` | public | Référence navigation stack tree |
| `stackDataProvider` | `NavigationStackDataProvider \| undefined` | public | Provider stack |
| `navigationStack` | `NavigationStack` | public | Historique back/forward (10 max) |
| `annotationsPanel` | `WebviewPanel \| undefined` | private | Panel webview |
| `linkedAnnotationManager` | `LinkedAnnotationManager?` | private | Délégué (legacy R2) |
| `templateManager` | `TemplateManager` | private | Délégué templates |
| `reviewModeManager` | `ReviewModeManager?` | private | Délégué (legacy R2) |
| `snippetManager` | `SnippetManager` | private | Délégué snippets singleton |
| `legacyEmptyStoreForRetiredManagers` | `AnnotationStore?` | private | Store vide back-compat (R2) |
| `currentUser` | `string` | private | Username effectif |
| `currentFilter` | `string` | private | Filtre webview ('all', 'severity:X', 'keyword:Y', tag) |
| `currentSort` | `string` | private | Tri webview |
| `annotationsEnabled` | `boolean` | public | Kill switch global |
| `clipboardWindowMs` | `number` | public | TTL cut buffer (5000) |
| `deletedRecentlyTtlMs` | `number` | public | TTL undo buffer (30000) |

### 1.4 Responsabilités par sous-domaine

- **storage**: charge/sauve `.out-of-code-insights/annotations.json`
  (Map JSON), import/export bulk, persiste `kanbanColumns` via
  `globalState`.
- **anchoring**: capture `lineHash`+`contextBefore`+`contextAfter` à
  création (`populateAnchor`), recompute à save (`setAnnotationLine`),
  recompute resolved status à refresh (`computeResolvedAnchor`),
  symbol-aware enrichment via `DocumentSymbolProvider` pour blank-line
  anchors (`repairBlankLineTrackingAnchors`).
- **transactional**: buffer cut avec TTL `clipboardWindowMs`, toast Undo
  pour cut-expired (`showCutExpiredToast`), restore deleted-recently
  quand contenu réapparaît (`tryRestoreFromDeletedRecently`), snapshot
  pre-change (`snapshotDocument`).
- **persistence/migration**: dédup pass1 (timestamp) + pass2 (content),
  migrate legacy sans `fileUri`, marque `stale` quand empty-hash + no
  context, garde anti-fuite cross-file (.ts dans .py).
- **mutation**: add/modify/delete/move/severity/tags/resolve.
- **events**: 1 EventEmitter unique (`annotationChanged`,
  `kanbanColumnsChanged`).
- **lifecycle**: init managers + load, refresh decorations tous
  visible editors, toggle on/off, dispose timers/decorations/managers.
- **query**: search by id/filter, list per-file, visibility test
  (filter + disabledTags).
- **linked**: créer/supprimer liens inter-annotations (délégué).
- **review**: walkthrough mode review (délégué).
- **kanban**: `annotation.kanbanColumn` + colonnes persistées
  globalState.
- **navigation**: `navigateToAnnotation` open+cursor, push/pop
  navigation stack, highlight ligne temporaire.
- **ui-bridge**: HTML webview annotations panel (filtering+sorting
  in-place), `postMessage` panel↔extension, statusbar count, focus
  panel from tree.
- **ai**: configure provider+key, `ensureAiConfigured`, `aiSuggestAnnotation`,
  chat participant.

### 1.5 TODO/FIXME

Aucun `TODO`/`FIXME` brut dans le fichier. Plusieurs blocs commentaires
"Lot 5 R2 transition" annoncent retrait planifié (lignes 53-69, 147-157,
190-194, 587-593, 705-710, 1157-1163, 3487-3492).

---

## 2. Module d'ancrage `src/anchoring/`

### 2.1 `anchor.ts` (487 lignes) — surface publique

| Symbole | Signature | Rôle |
|---|---|---|
| `EMPTY_LINE_HASH` | `'811c9dc5'` (const) | FNV-1a offset basis = hash d'une ligne vide; sentinel anti-corruption |
| `normalizeLine` | `(text: string): string` | Trim + collapse internal whitespace |
| `hashLine` | `(text: string): string` | FNV-1a 32-bit, 8 hex chars lowercase |
| `isEmptyLineHash` | `(hash?: string \| null): boolean` | Garde sentinel |
| `captureAnchor` | `(doc, line, opts? \| contextSize?): AnchorData` | Snapshot anchor; walk blank → forward (5) puis backward (3) |
| `findAnchor` | `(doc, anchor, storedLine=-1, opts?): number \| null` | Vote hash + context, threshold adaptatif (4 ou 2), opt-in `allowUniqueHashFallback` |
| `detectMoves` | `(oldLines: string[], newLines: string[]): MovedBlock[]` | Diff (Myers via `diff` package); paire blocs identiques normalisés |
| `reanchor` | `(annotation: ReanchorInput, doc): ReanchorResult` | Pipeline `matched`/`moved`/`orphan`; pure (jamais mutate) |

### 2.2 Types/contracts exportés

| Type | Champs | Note |
|---|---|---|
| `TextDocumentLike` | `{ lineCount; lineAt(i): {text} }` | Duck-type, `vscode.TextDocument` compatible |
| `AnchorData` | `{ lineHash; contextBefore[]; contextAfter[]; targetLine?; originalLine? }` | Output `captureAnchor` |
| `CaptureOptions` | `{ contextSize?=3; walkForward?=5; walkBackward?=3 }` | |
| `FindAnchorOptions` | `{ allowUniqueHashFallback?=false }` | |
| `MovedBlock` | `{ oldStart, oldEnd, newStart, newEnd }` | Indices inclusifs |
| `ReanchorStatus` | `'matched' \| 'moved' \| 'orphan'` | |
| `ReanchorResult` | `{ status; newLine?; newHash?; newContextBefore?; newContextAfter? }` | |
| `ReanchorInput` | `{ line; lineHash?; contextBefore?; contextAfter? }` | Subset structurel `Annotation` |

### 2.3 Algorithme `findAnchor` (verrouillé par tests)

1. Reject empty-hash + no meaningful context → `null` (anti-corruption).
2. Fast path: si `storedLine` hash matches → return immédiatement.
3. Scan complet doc: pour chaque ligne avec hash matching, score
   `+2/ligne contexte non-vide matchante`.
4. Threshold: `4` si ≥2 contextes ou empty-hash; sinon `2`.
5. Opt-in `allowUniqueHashFallback` + 1 seul candidat + hash non-empty
   → return ce candidat (gère Alt+Up/Down).

### 2.4 `__tests__/anchor.test.ts` (701 lignes) — coverage actuel

| Suite | Tests | Couvrir |
|---|---|---|
| `normalizeLine` | 3 | trim, collapse, blank |
| `hashLine` | 4 | déterminisme, format hex, distinct, indent-insensible |
| `captureAnchor` | 3 | hash target, contexte normalisé, clamp boundaries |
| `findAnchor` | 6 | fast-path, scoring move, unique-hash fallback (3 cas), no-match → null |
| `EMPTY_LINE_HASH` | 8 | regression données corrompues, walk forward/backward, options legacy, fast-path empty avec contexte |
| `regression: 10-scenario` | 7 | Tests 1, 2, 3, 4, 5, 6, 8, 10 (subset pure-logic) |
| `detectMoves` | 3 | move 5-line, no moves on insertion, re-indent move |
| `reanchor` | 5 | (a) match insertion above, (b) match deletion above, (c) re-indent + neighbour edit, (d) orphan no-mutation, (e) BUG REPRO drag-down past shorter block |

Diff stats: `+378` / `-...` lignes (anchor.test.ts), `+127` / `-36`
(anchor.ts) — ajouts massifs `reanchor` + suite EMPTY_LINE_HASH.

---

## 3. `src/transactional/` (nouveau, 12 fichiers)

### 3.1 Inventaire des fichiers

| Fichier | LOC | Intent |
|---|---|---|
| `types.ts` | 220 | Schéma v2: `AnnotationV2`, `OpEntry`, `InverseOp`, `JournalSnapshot`, `SuspendedEntry`, `ValidationResult`, `AnnotationStoreFileV2`, lifecycle `'active'\|'suspended'\|'disposed'`, origin `'manual'\|'paste'\|'restore'`, `ANNOTATION_SCHEMA_VERSION = 2` |
| `AnnotationStore.ts` | 1492 | Cœur v2: store offset-based, journal cyclique (`journalCapacity=1024`), undo/redo mirroring, suspended buffer (`suspendTtlMs=30000`), Cas A/B/C/D dans `applyDocumentChange`, paste detection (resume vs clone), Lot 5 ergonomics (`upsert`, `list`, `listForFile`, `getLineForAnnotation`, `notifyChanged`, `markInitialized`, `populateAnchor`, `setAnnotationLine`, `dispose`) |
| `AnnotationPersistence.ts` | 124 | Load/save envelope v2 (defaults `.out-of-code-insights/annotations.json`), guard path traversal, ENOENT→empty envelope, schemaVersion check, `onDidLoad`/`onDidSave` events |
| `AnnotationNavigation.ts` | 67 | `navigateToAnnotation(id)` + `focusAnnotationInPanel(id)` via DI `NavigationVsCodeApi` (`openTextDocumentAt`, optional `revealAnnotationInPanel`), push `NavigationStackLike` |
| `VisibilityFilter.ts` | 110 | `isGloballyEnabled()` + `isVisible(annotation)`; filtre `'all'`/`'keyword:'`/`'severity:'`/tag/file fallback; getter `getConfig` injecté |
| `KanbanColumnStore.ts` | 77 | Map `annotationId → columnId` persistée via `MementoLike` (key `outOfCodeInsights.kanban.annotationColumns`); `getColumn`/`setColumn`/`clearColumn`/`getAllColumns` + `onDidChange` |
| `internal/event-emitter.ts` | 30 | `TypedEventEmitter<T>` minimaliste sans dep `vscode` runtime |
| `__tests__/AnnotationStore.unit.test.ts` | (non audité) | Suite unitaire pure-Node (offsets, journal, suspended, undo/redo) |
| `__tests__/AnnotationPersistence.unit.test.ts` | (non audité) | Round-trip disque tmpdir |
| `__tests__/AnnotationNavigation.unit.test.ts` | (non audité) | DI mocks |
| `__tests__/VisibilityFilter.unit.test.ts` | (non audité) | Branches filtre |
| `__tests__/KanbanColumnStore.unit.test.ts` | (non audité) | Memento mock round-trip |

### 3.2 API publique `AnnotationStore` (méthodes)

| Méthode | Signature | Rôle |
|---|---|---|
| `add` | overloaded: `(draft, opts, document)` ou `(draftRaw)` | Insert annotation, journal `add` |
| `remove` | `(id): void` | Idempotent, journal `remove` |
| `update` | `(id, patch): AnnotationV2` | Patch + journal `update` |
| `upsert` | `(annotation): AnnotationV2` | Insert-or-update, journal `upsert` |
| `get` | `(id): AnnotationV2 \| undefined` | Lookup actif OU suspended |
| `getAll` / `list` | `(): readonly AnnotationV2[]` | Actifs uniquement |
| `getByFile` / `listForFile` | `(fileUri): readonly AnnotationV2[]` | Actifs + suspended d'un fichier |
| `size` | `(): number` | Cardinal map active |
| `getLineForAnnotation` | `(id, doc \| docs): number \| null` | Display line via `positionAt(startOffset).line` |
| `offsetToLine` / `lineToOffset` | `(o\|l, doc): n` | Conversion utilitaire |
| `populateAnchor` | `(annotation, doc): AnnotationV2` | Recapture lineHash/context |
| `setAnnotationLine` | `(id, line, doc): AnnotationV2` | Repositionne + recapture |
| `beginTransaction` / `commit` / `rollback` | `(): void` | Batch atomique |
| `applyDocumentChange` | `(event): void` | Cas A/B/C/D + paste detect + TTL sweep + undo/redo dispatch |
| `suspend` / `resume` | `(id, ...): void / AnnotationV2` | Lifecycle suspended |
| `getSuspendedByHash` | `(blockHash): readonly SuspendedEntry[]` | Lookup paste-resume |
| `mirrorUndo` / `mirrorRedo` | `(version, fileUri): void` | Best-effort sync editor undo (limit L1) |
| `validate` | `(): ValidationResult` | Invariants I1-I4 |
| `serialize` / `deserialize` | `(): file / (file): void` | I/O envelope |
| `getJournal` | `(): JournalSnapshot` | Lecture seule journal |
| `markInitialized` / `waitUntilInitialized` | `(): void / Promise<void>` | Gate init |
| `notifyChanged` | `(): void` | Fire onDidChange empty batch |
| `dispose` | `(): void` | Idempotent |

### 3.3 Events `AnnotationStore`

| Event | Payload | Quand |
|---|---|---|
| `onDidChange` | `readonly OpEntry[]` | Après `commit()` ou single-op `commitOrQueue` |
| `onDidSuspend` | `SuspendedEntry` | À chaque `suspend()` |
| `onDidResume` | `{annotationId, opId}` | À chaque `resume()` |
| `onDidDispose` | `{annotationId, reason: 'ttl-expired' \| 'explicit'}` | TTL sweep ou dispose explicite |

### 3.4 Limites architecturales documentées

- **L1**: VS Code n'accepte pas mutations extension-side dans son
  undo stack. `mirrorUndo`/`mirrorRedo` réconcilient *après* via
  `event.reason === Undo|Redo`. Best-effort.
- **L2**: clipboard OS hors-process — pas d'id annotation traversant.
  Paste detection = match line-hash via `SuspendedBuffer` local + TTL.

---

## 4. `src/common/types.ts` (176 lignes) — type `Annotation`

### 4.1 Champs (legacy v1, conservé pour back-compat)

| Champ | Type | Optionnel | Documentation |
|---|---|---|---|
| `id` | `string` | non | Identifiant (legacy: timestamp+random; v2: UUID v4) |
| `file` | `string` | non | Chemin display (relatif workspace) |
| `line` | `number` | non | 1-based legacy (NB: AnnotationV2 supprime ce champ au profit de `startOffset`) |
| `message` | `string` | non | Body annotation |
| `author` | `string` | oui | Handle auteur |
| `timestamp` | `string` | non | ISO-8601 création |
| `thread` | `Comment[]` | oui | Discussion threadée |
| `tags` | `string[]` | oui | Free-form |
| `pinned` | `boolean` | oui | Sticky top |
| `priority` | `number` | oui | Numeric priority |
| `severity` | `string` | oui | `info`/`warn`/`error`/... |
| `resolved` | `boolean` | oui | Flag résolution |
| `linkedAnnotations` | `LinkedAnnotation[]` | oui | Cross-file links |
| `template` | `string` | oui | Id template appliqué |
| `reviewState` | `ReviewState` | oui | `{viewed, viewedBy, viewedAt}` |
| `kanbanColumn` | `string` | oui | Colonne kanban |
| `snippet` | `{code, language}` | oui | Snippet code attaché |
| `lineHash` | `string` | oui | FNV-1a normalisé (legacy anchor) |
| `contextBefore` | `string[]` | oui | 3 lignes avant normalisées |
| `contextAfter` | `string[]` | oui | 3 lignes après normalisées |
| `fileUri` | `string` | oui | URI authoritative; fallback `file` quand absent |
| `languageId` | `string` | oui | `typescript`/`python`/... à création |
| `anchor` | `AnnotationAnchor` | oui | Anchor structurel symbol-aware |
| `origin` | `{kind:'copy-paste', sourceId, sourceFile?, sourceFileUri?, sourceLine, pastedAtLine}` | oui | Métadonnées copy-paste |
| `resolvedAnchor` | `ResolvedAnnotationAnchor` | oui | État runtime transient (jamais persisté) |

### 4.2 Sous-types

| Type | Champs |
|---|---|
| `LinkedAnnotation` | `{targetFile; targetLine; relationship: 'implements'\|'references'\|'related'\|string}` |
| `AnnotationTemplate` | `{id; name; content; variables: Array<{name, description, defaultValue}>}` |
| `ReviewState` | `{viewed: boolean; viewedBy: string; viewedAt: string}` |
| `KanbanColumn` | `{id; name; annotations: string[]}` |
| `Comment` | `{id; message; author?; timestamp}` |
| `AnnotationAnchor` | `{kind: 'symbol'\|'line'\|'file'; originalLine; targetLine; symbolName?; symbolKind?; symbolSignature?; anchorTextHash; contextBefore[]; contextAfter[]}` |
| `ResolvedAnnotationAnchor` | `{status: 'attached'\|'moved'\|'orphaned'\|'ambiguous'\|'stale'; line: number\|null; confidence; reason}` |
| `ExtensionConfig` | `{colors{light,dark}; debounceDelay; maxAnnotationsPerFile; username; codelens{enable, showCommands}; enableAnnotations; disabledTags[]; enableAiSuggest; defaultSeverity}` |
| `DEFAULT_CONFIG` | const `ExtensionConfig` (debounce=300, max=100, codelens on, AI off) |

### 4.3 Différences clés `Annotation` (v1) vs `AnnotationV2` (transactional/types.ts)

| Aspect | v1 `Annotation` | v2 `AnnotationV2` |
|---|---|---|
| Identifiant | `id: string` (timestamp+random) | `id: string` (UUID v4 obligatoire) |
| Anchor primaire | `line: number` (1-based) | `startOffset`/`endOffset` (UTF-16 code units, authoritative) |
| Lifecycle | implicit, deleted via map.delete | explicit `state: 'active'\|'suspended'\|'disposed'` |
| Provenance | `origin.kind: 'copy-paste'` (optional) | `origin: AnnotationOrigin` mandatory `'manual'\|'paste'\|'restore'` |
| Schema version | absent | `schemaVersion: 2` |
| `fileUri` | optional | mandatory |
| Anchor structuré | `anchor?: AnnotationAnchor` (symbol-aware) | retiré, fallback `lineHash`+`contextBefore`+`contextAfter` |
| `resolvedAnchor` | runtime transient | retiré |

---

## 5. Consommateurs d'AnnotationManager (10 fichiers)

Snapshot des dépendances actuelles (post-Lot 5 R2 — la plupart des
consommateurs sont déjà migrés vers `AnnotationStore`).

### 5.1 `src/extension.ts` (842 lignes)

Détient **les deux** stacks en parallèle (R2 transition).

| Cible | Méthodes appelées | Events consommés |
|---|---|---|
| `AnnotationManager` | `loadAnnotations`, `refreshAnnotations`, `waitUntilInitialized`, `createChatParticipant`, `dispose`, `ensureAiConfigured`, `handleError`, `navigationStack` (champ public), `on('annotationChanged')`, `on('kanbanColumnsChanged')`, `removeListener(...)` | `annotationChanged`, `kanbanColumnsChanged` |
| `AnnotationStore` | `list`, `remove`, `add`, `serialize`, `deserialize`, `markInitialized`, `applyDocumentChange`, `notifyChanged`, `onDidChange`, `dispose` | `onDidChange` (trigger debounced save 100ms) |
| `AnnotationPersistence` | `load`, `save`, `dispose` | — |
| `KanbanColumnStore` | `setColumn`, `clearColumn`, `getAllColumns`, `dispose` | — |
| `VisibilityFilter` | `dispose` | — |

Patches transitoires : `stubLegacyAnnotationManagerIO()` neutralise
`loadAnnotations`/`saveAnnotations` du legacy pour éviter race sur
`.out-of-code-insights/annotations.json`. Commands enregistrées :
`annotations.add`, `annotations.clearAll`, `annotations.kanban.*`
(7 sous-commandes), `annotations.showKanban`, `annotations.addKanbanColumn`,
`annotations.<24 mappings legacy>`.

### 5.2 `src/managers/LinkedAnnotationManager.ts` (515 lignes)

Migré R2 — n'utilise plus `AnnotationManager`.

| Cible | Méthodes/events |
|---|---|
| `AnnotationStore` | `get(id)`, `update(id, {linkedAnnotations})`, `getAll`, `getLineForAnnotation`, `onDidChange` |
| `AnnotationNavigation` | `navigateToAnnotation`, `focusAnnotationInPanel` (optionnel) |
| EventEmitter (héritage) | émet `linkCreated`, `linkRemoved`, ... |

### 5.3 `src/managers/NavigationStack.ts` (82 lignes)

Standalone (pas de dépendance `AnnotationManager`). Persiste via
`workspaceState`. API : `push(id)`, `back()`, `forward()`, `getStack()`,
`removeId(id)`, event `onDidChange`. Limit 10 entries.

### 5.4 `src/managers/ReviewModeManager.ts` (705 lignes)

Migré R2.

| Cible | Méthodes/events |
|---|---|
| `AnnotationStore` | `getAll`, `update(id, {reviewState})`, `onDidChange` |
| `AnnotationNavigation` (optionnel) | `navigateToAnnotation` |
| `getUsername: () => string` (DI) | snapshot username |

Tri par `startOffset` (vu que `line` n'existe plus en v2).

### 5.5 `src/managers/SnippetManager.ts` (514 lignes)

Singleton, type-swap `Annotation` → `AnnotationV2`. Pas de dépendance
runtime sur `AnnotationStore` — opère sur snapshot passé en argument.
Méthodes : `addSnippet`, `previewSnippet`, `applySnippet`, `getSnippets`.
Line resolution via `editor.document.positionAt(annotation.startOffset).line`.

### 5.6 `src/providers/AnnotationCodeLensProvider.ts` (114 lignes)

Migré R2.

| Cible | Méthodes/events |
|---|---|
| `AnnotationStore` | `listForFile(uri)`, `onDidChange`, `onDidSuspend`, `onDidResume`, `onDidDispose` |
| `VisibilityFilter` | `isGloballyEnabled`, `isVisible`, `onDidChange` |

Refire `onDidChangeCodeLenses` sur tout signal store ou config.

### 5.7 `src/providers/UnifiedAIAdapter.ts` (1304 lignes)

Migration partielle. Garde référence sur `AnnotationManager` ET `AnnotationStore` (optionnel).

| Cible | Méthodes / sites concrets |
|---|---|
| `AnnotationManager` | `annotations.values()` (lignes 636, 711), `annotations.set(id, updated)` (lignes 881, 1240), `populateAnchor(annotation, doc, line)` (lignes 869, 917), `emit('annotationChanged')` (ligne 884) |
| `AnnotationStore` | `upsert(annotation)` (chemin migré site :702 — délégué via `persistAnnotationUpdate`) |

Bridge ligne 27 : "Surgical injection of the new AnnotationStore...
the first such migration is the snippet-attach path at the legacy
line 702 — see `attachSnippetToAnnotation()` below". Fallback
manager.annotations quand `store` non câblé.

### 5.8 `src/tree/AnnotationsTree.ts` (403 lignes)

Migré R2.

| Cible | Méthodes/events |
|---|---|
| `AnnotationStore` | `list`, `getLineForAnnotation`, `waitUntilInitialized`, `onDidChange`, `onDidSuspend`, `onDidResume`, `onDidDispose` |
| `VisibilityFilter` | `isVisible`, `onDidChange` |
| `AnnotationPersistence` | (drag-and-drop reorder save path) |

Group by `annotation.file`, sort by `annotation.startOffset`.

### 5.9 `src/tree/NavigationStackTree.ts` (80 lignes)

Migré R2.

| Cible | Méthodes/events |
|---|---|
| `AnnotationStore` | `get(id)`, `getLineForAnnotation`, `waitUntilInitialized`, `onDidChange`, `onDidDispose` |
| `NavigationStack` | `getStack`, `removeId`, `onDidChange` |

`onDidDispose` purge l'id du stack (résout le tombstone).

### 5.10 `src/views/KanbanView.ts` (958 lignes)

Migré R2 (partial).

| Cible | Méthodes/events |
|---|---|
| `AnnotationStore` | injecté en constructeur, `list()` via extension.ts |
| Commands routées | `annotations.kanban.{moveToColumn, addColumn, updateColumns, deleteColumn, removeFromKanban, getColumns, refresh}` |

Webview drag-and-drop émet `moveCard` → command
`annotations.kanban.moveToColumn` → `KanbanColumnStore.setColumn` →
`store.notifyChanged()`.

---

## 6. Tests modifiés et fixtures

### 6.1 Tests modifiés (`git diff --numstat`)

| Fichier | +adds | -dels | Statut |
|---|---|---|---|
| `src/anchoring/anchor.ts` | 127 | 36 | M (refonte `findAnchor` thresholds + `reanchor` ajouté) |
| `src/anchoring/__tests__/anchor.test.ts` | 378 | (~200) | M (suites EMPTY_LINE_HASH, regression 10-scenario, reanchor a-e) |
| `src/managers/AnnotationManager.ts` | 138 | 175 | M (Lot 5 R2 transition comments, retraits commands) |
| `src/test/suite/unit/annotationManager.unit.test.ts` | 142 | 0 | M (algorithme tests, no host) |
| `src/extension.ts` | 537 | (~) | M (bootstrap transactional stack, Kanban commands, `stubLegacyAnnotationManagerIO`) |
| `src/managers/LinkedAnnotationManager.ts` | 686 | (~) | M (rewrite vers store) |
| `src/managers/ReviewModeManager.ts` | 430 | (~) | M (rewrite vers store) |
| `src/managers/SnippetManager.ts` | 36 | (~) | M (type-swap v1→v2) |
| `src/providers/AnnotationCodeLensProvider.ts` | 119 | (~) | M (rewrite vers store) |
| `src/providers/UnifiedAIAdapter.ts` | 133 | (~) | M (bridge `store` injection) |
| `src/tree/AnnotationsTree.ts` | 384 | (~) | M (rewrite vers store + persistence) |
| `src/tree/NavigationStackTree.ts` | 63 | (~) | M (rewrite vers store + nav stack) |
| `src/views/KanbanView.ts` | 49 | (~) | M (type-swap, command routing) |
| `src/managers/NavigationStack.ts` | 19 | 0 | M (`removeId` ajouté) |

### 6.2 Tests d'intégration nouveaux (non commités)

| Fichier | LOC | Cas couverts |
|---|---|---|
| `src/test/suite/annotationStore.integration.test.ts` | 1452 | §7.1, §7.2, wiring, JSON v2; §7.7, §7.8, §7.9, transactional batch; §7.4 (cut), §7.4 TTL, §7.5, §7.6, §7.10, §7.12, §7.13 |
| `src/test/suite/annotationReanchor.integration.test.ts` | 127 | Reanchor pipeline live EDH (move/copy/cut-paste regression) |
| `src/test/suite/lot5-runtime.integration.test.ts` | 865 | 9 tests : activation, add flow disk, upsert, persistence load/save+v1 reject, manual checklist, e2e lifecycle, persistence round-trip, TTL purge, KanbanColumnStore round-trip |
| `src/test/suite/lot5-display.integration.test.ts` | 440 | TreeProvider grouping/refresh/visibility, CodeLens line/disabled, NavStack purge, DragDrop contract, getLineForAnnotation (4 cas) |
| `src/test/suite/lot5-managers.integration.test.ts` | 326 | LinkedAnnotation create/cycle/incoming, Review mark/stats, Snippet add/preview/missing |
| `src/test/suite/lot5-ai-adapter.integration.test.ts` | 351 | Site :702 store.upsert, fallback legacy, bridge non-tracked |

### 6.3 Fixtures (`test-fixtures/lot*.ts`, 40 fichiers)

Snippets de code source courts (~10 lignes) servant d'inputs aux tests.
Le nom encode le cas : `lotN-§X.Y-description.ts`.

| Lot | Fichiers | Cas spec couvert |
|---|---|---|
| **lot1** (4) | `lot1-7-1-insertion-before.ts`, `lot1-7-2-insertion-on-line.ts`, `lot1-roundtrip-fixture.ts`, `lot1-wiring-handler.ts` | §7.1, §7.2, JSON round-trip, wiring `onDidChangeTextDocument` |
| **lot2** (4) | `lot2-7-7-undo-paste.ts`, `lot2-7-8-redo-paste.ts`, `lot2-7-9-undo-cut-paste.ts`, `lot2-tx-batch.ts` | §7.7, §7.8, §7.9, transactional batch |
| **lot4** (10) | `lot4-7-3-delete-anchored-line.ts`, `lot4-7-4-cut-no-paste.ts`, `lot4-7-4-ttl-expiry.ts`, `lot4-7-5-paste-after-cut.ts`, `lot4-7-6-copy-paste.ts`, `lot4-7-10-multi-paste.ts`, `lot4-7-11-partial-line-paste.ts`, `lot4-7-12-block-delete.ts`, `lot4-7-13-block-cut-paste.ts`, `lot4-7-14-save-reload.ts` | §7.3, §7.4 (cut + TTL), §7.5, §7.6, §7.10, §7.11, §7.12, §7.13, §7.14 |
| **lot5** (22) | `lot5-r2-{add-flow,e2e-lifecycle,tree-ttl}.ts`; `lot5-display-{codelens-disabled,codelens-line,getline-direct,getline-listed,getline-nodoc,navstack-purge,tree-grouping,tree-refresh,tree-visibility}.ts`; `lot5-mgr-{linked-create,linked-cycle,linked-incoming,review-mark,review-stats,snippet-add,snippet-missing,snippet-preview}.ts`; `lot5-ai-adapter-{fallback,orphan,snippet}.ts` | R2 wiring/UI/managers/AI adapter |
| autres | `reanchor-scenario-{copy,cut,move}.ts`, `sample.ts` | Reanchor scenarios |

Tous les fichiers fixtures sont des stubs simples (8-12 lignes) servant
de cible pour `vscode.workspace.applyEdit`.

---

## Métriques

| Métrique | Valeur |
|---|---|
| Lignes `AnnotationManager.ts` | 5532 |
| Lignes `anchoring/anchor.ts` | 487 |
| Lignes `anchoring/__tests__/anchor.test.ts` | 701 |
| Lignes `common/types.ts` | 176 |
| Lignes `transactional/AnnotationStore.ts` | 1492 |
| Lignes `transactional/types.ts` | 220 |
| Lignes `transactional/AnnotationPersistence.ts` | 124 |
| Lignes `transactional/AnnotationNavigation.ts` | 67 |
| Lignes `transactional/VisibilityFilter.ts` | 110 |
| Lignes `transactional/KanbanColumnStore.ts` | 77 |
| Lignes `transactional/internal/event-emitter.ts` | 30 |
| Lignes consommateurs cumulés | 5515 |
| Lignes tests intégration nouveaux | 3561 |
| Total LOC audité | ~17 600 |
| Méthodes publiques `AnnotationManager` | 44 |
| Méthodes privées `AnnotationManager` (estimé) | ~87 |
| Champs d'état `AnnotationManager` (Map/Set/array) | 15 |
| Events émis `AnnotationManager` | 2 (`annotationChanged`, `kanbanColumnsChanged`) |
| Méthodes publiques `AnnotationStore` | ~30 |
| Events émis `AnnotationStore` | 4 (`onDidChange`, `onDidSuspend`, `onDidResume`, `onDidDispose`) |
| Consommateurs distincts d'`AnnotationManager` | 10 (extension + 9 modules) |
| Consommateurs déjà migrés vers `AnnotationStore` | 8 (LinkedAnnotationManager, ReviewModeManager, SnippetManager, AnnotationCodeLensProvider, AnnotationsTree, NavigationStackTree, KanbanView, NavigationStack standalone) |
| Consommateurs partiellement migrés | 1 (`UnifiedAIAdapter` — bridge optionnel) |
| Consommateurs encore couplés | 2 (`extension.ts` — owner; `UnifiedAIAdapter` — fallback) |
| Fixtures `lot*` présentes | 40 |
| TODO/FIXME bruts dans `AnnotationManager.ts` | 0 |
| Marqueurs « Lot 5 R2 transition » dans `AnnotationManager.ts` | 7 blocs |
