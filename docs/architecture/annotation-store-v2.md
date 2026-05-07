# AnnotationStore v2 — Architecture détaillée (Option C)

**Statut** : draft d'architecture (Phase 1).
**Auteur** : APU (architecte transactionnel).
**Date** : 2026-05-06.
**Scope** : refonte complète du sous-système d'ancrage et de persistance des annotations.
**Backward compatibility** : *aucune*. Pas d'ancien fichier à migrer (rien en production). Le nouveau format JSON v2 est la seule source de vérité.

---

## 0. Vue d'ensemble

L'AnnotationStore v2 remplace l'ancrage `(file, line)` par un ancrage **offset-based hybride** persisté nativement par les events VS Code (`TextDocumentContentChangeEvent.rangeOffset` + `rangeLength` + `text.length`), redondé par un triplet `(lineHash, contextBefore, contextAfter)` pour la robustesse aux éditions externes (hors process VS Code).

Le store devient **transactionnel** : toute mutation passe par un `OpEntry` enregistré dans un journal cyclique. Les transactions internes sont atomiques. Les opérations d'édition de document sont mirrorées (limite L1 documentée : la pile undo de VS Code n'accepte pas de mutations d'objets en mémoire ; on émule via `event.reason === Undo|Redo`).

Le cut/copy/paste est géré par un **buffer suspendu extension-local** indexé par hash du bloc supprimé (limite L2 documentée : le clipboard OS sort du process et ne peut pas porter d'identifiant interne).

### Limites architecturales acceptées

| Code | Limite | Mitigation |
|------|--------|-----------|
| **L1** | La pile undo VS Code ne peut pas contenir des mutations d'objets extension. | `mirrorUndo()` / `mirrorRedo()` rejoue/inverse le journal sur réception de `event.reason === Undo|Redo`. Atomicité best-effort, non bloquante côté éditeur. |
| **L2** | Le clipboard OS est out-of-process : l'identité d'un bloc cut ne peut être portée par le clipboard. | Buffer extension-local `Map<blockHash, SuspendedAnnotation[]>` avec TTL configurable. Match à la réception d'un `paste` (rangeLength === 0 && text.length > 0). |
| **L3** | Les éditions externes (hors VS Code) invalident les offsets sans event. | À l'`onDidChangeTextDocument` post-reload, refallback sur `(lineHash + context)` via la pipeline existante de `src/anchoring/anchor.ts`. |

---

## 1. Types TypeScript (contenu de `src/transactional/types.ts`)

```typescript
// SPDX-License-Identifier: MPL-2.0
import type { Comment, LinkedAnnotation, ReviewState } from '../common/types';

/** Format version literal — bump iff the on-disk schema changes. */
export const ANNOTATION_SCHEMA_VERSION = 2 as const;

/**
 * Lifecycle state of an annotation inside the store.
 *
 * - `active`    : tracked against a live offset range in its document.
 * - `suspended` : the underlying text has been removed (cut) and the
 *                 annotation is parked in the cut/copy buffer awaiting
 *                 a matching paste or TTL expiry.
 * - `disposed`  : terminal state. Removed by user or TTL-expired suspension.
 *                 Kept transiently in the journal for undo replay only.
 */
export type AnnotationLifecycle = 'active' | 'suspended' | 'disposed';

/**
 * Provenance of an annotation. Mandatory at creation time, never inferred.
 *
 * - `manual`  : created by user action (UI command, gesture).
 * - `paste`   : created by paste-after-copy or paste-after-cut. `sourceOpId`
 *               points back to the OpEntry that produced it (origin chain).
 * - `restore` : created by mirrorUndo replay of a prior `disposed` state.
 */
export interface AnnotationOrigin {
    kind: 'manual' | 'paste' | 'restore';
    /** OpEntry.opId of the operation that spawned this annotation. */
    sourceOpId?: string;
}

/**
 * Persistent annotation record (schema v2). Replaces `Annotation` from
 * src/common/types.ts. Offsets are the authoritative anchor; line/context
 * are redundant fallbacks for external edits and human readability.
 *
 * INVARIANTS (validated by AnnotationStore.validate()):
 *   - id is RFC4122 v4 UUID, globally unique across the store.
 *   - 0 <= startOffset <= endOffset (zero-width allowed for caret anchors).
 *   - schemaVersion === ANNOTATION_SCHEMA_VERSION.
 *   - state === 'suspended' iff annotation is present in the cut buffer.
 *   - origin is always set; for migration of a brand-new install, all
 *     annotations begin with origin.kind === 'manual'.
 */
export interface AnnotationV2 {
    /** RFC4122 v4 UUID — generated at creation, never mutated. */
    id: string;

    /** Format discriminator. Always === 2 for this version. */
    schemaVersion: typeof ANNOTATION_SCHEMA_VERSION;

    // ── Anchoring (authoritative) ────────────────────────────────────────
    /** Document URI string (vscode.Uri.toString()). Authoritative scope. */
    fileUri: string;
    /** Display path relative to workspace root. Display-only metadata. */
    file: string;
    /** Inclusive UTF-16 code-unit offset to the start of the anchored range. */
    startOffset: number;
    /** Exclusive UTF-16 code-unit offset to the end of the anchored range. */
    endOffset: number;

    // ── Anchoring (redundant fallback for external edits) ────────────────
    /** FNV-1a hash of the normalized line at startOffset. */
    lineHash: string;
    /** Up to 3 normalized lines preceding the anchor line. */
    contextBefore: string[];
    /** Up to 3 normalized lines following the anchor line. */
    contextAfter: string[];

    // ── Lifecycle ────────────────────────────────────────────────────────
    state: AnnotationLifecycle;
    origin: AnnotationOrigin;

    // ── Business fields (preserved from src/common/types.ts) ─────────────
    /** Annotation body. Source: src/common/types.ts:71 */
    message: string;
    /** Author handle. Source: src/common/types.ts:72 */
    author?: string;
    /** ISO-8601 creation timestamp. Source: src/common/types.ts:73 */
    timestamp: string;
    /** Threaded discussion. Source: src/common/types.ts:74 */
    thread?: Comment[];
    /** Free-form tags. Source: src/common/types.ts:75 */
    tags?: string[];
    /** Sticky to top of list. Source: src/common/types.ts:76 */
    pinned?: boolean;
    /** Numeric priority. Source: src/common/types.ts:77 */
    priority?: number;
    /** Severity label (info|warn|error|...). Source: src/common/types.ts:78 */
    severity?: string;
    /** Resolution flag. Source: src/common/types.ts:79 */
    resolved?: boolean;
    /** Cross-file links. Source: src/common/types.ts:80 */
    linkedAnnotations?: LinkedAnnotation[];
    /** Template id used at creation. Source: src/common/types.ts:81 */
    template?: string;
    /** Review state record. Source: src/common/types.ts:82 */
    reviewState?: ReviewState;
    /** Kanban column id. Source: src/common/types.ts:83 */
    kanbanColumn?: string;
    /** Code snippet captured at creation. Source: src/common/types.ts:84-87 */
    snippet?: { code: string; language: string };
    /** Document language id at creation. Source: src/common/types.ts:99 */
    languageId?: string;
}

/** Discriminator for journal entries. */
export type OpKind = 'add' | 'remove' | 'update' | 'suspend' | 'resume';

/**
 * Inverse operation that exactly undoes an OpEntry. Stored at journaling
 * time so mirrorUndo() can replay without re-deriving the inverse.
 */
export interface InverseOp {
    kind: OpKind;
    /** Snapshot of the previous AnnotationV2 state, or null for `add`. */
    previous?: Readonly<AnnotationV2>;
    /** New state to restore — used by `update`/`suspend`/`resume`. */
    next?: Readonly<AnnotationV2>;
    /** Annotation id targeted by the inverse. */
    annotationId: string;
}

/**
 * Journal entry. The journal is an append-only list of OpEntry instances.
 * Entries are NEVER mutated post-commit. Immutable shape allows safe
 * sharing between the journal, mirrorUndo replay, and serialization.
 */
export interface OpEntry {
    /** RFC4122 v4 UUID for the operation. */
    opId: string;
    /** ISO-8601 timestamp at which the op was committed. */
    timestamp: string;
    /** Op discriminator. */
    kind: OpKind;
    /** Annotation id touched by the op. */
    annotationId: string;
    /** Snapshot of the annotation BEFORE the op (null for `add`). */
    before: Readonly<AnnotationV2> | null;
    /** Snapshot of the annotation AFTER the op (null for `remove`). */
    after: Readonly<AnnotationV2> | null;
    /** Inverse op pre-computed at commit time. */
    inverse: InverseOp;
    /**
     * vscode.TextDocument.version observed at op time. Used to align
     * mirrorUndo replay with the editor's own undo cursor.
     */
    documentVersionAtOp: number;
    /**
     * fileUri scope of the op. Mirrored from the annotation's fileUri at
     * journaling time so suspended/disposed annotations remain routable.
     */
    fileUri: string;
}

/**
 * Cyclic buffer of recent OpEntry. Bounded length avoids unbounded growth
 * across long sessions; the buffer is reset on workspace reload.
 *
 * Capacity is configured via `outOfCodeInsights.journal.capacity` (default 1024).
 */
export interface JournalSnapshot {
    capacity: number;
    /** Newest at tail, oldest at head. */
    entries: ReadonlyArray<OpEntry>;
    /** Index (within entries) of the next entry that mirrorUndo would target. */
    cursor: number;
}

/** Suspended-annotation buffer entry indexed by content hash of the cut block. */
export interface SuspendedEntry {
    annotation: Readonly<AnnotationV2>;
    /** Hash of the cut text. Acts as the resume key. */
    blockHash: string;
    /** Wall-clock ms epoch at which suspension started. */
    suspendedAt: number;
    /** opId of the suspend op (links back into the journal). */
    suspendOpId: string;
}

/** Result of validate(). */
export interface ViolationReport {
    code:
        | 'duplicate-id'
        | 'invalid-offset-range'
        | 'invalid-schema-version'
        | 'orphan-suspended'
        | 'state-mismatch'
        | 'missing-anchor';
    annotationId?: string;
    detail: string;
}

export interface ValidationResult {
    valid: boolean;
    violations: ViolationReport[];
}

/** Stored JSON envelope (schema v2). */
export interface AnnotationStoreFileV2 {
    schemaVersion: typeof ANNOTATION_SCHEMA_VERSION;
    annotations: AnnotationV2[];
}
```

> **Note Comment / LinkedAnnotation / ReviewState** : ces types sont importés tels quels depuis `src/common/types.ts` (lignes 3-7, 20-24, 115-120). Ils ne changent pas en v2.

> **Champ `anchor` legacy abandonné** : `AnnotationAnchor` et `ResolvedAnnotationAnchor` (`src/common/types.ts:37-65`) sont supprimés. Leurs informations symboliques (symbolName/Kind/Signature) ne sont pas portées en v2 — l'ancrage offset rend la résolution symbolique redondante. Le champ `resolvedAnchor` (transient) disparaît.

> **Champ `line` legacy abandonné** : `Annotation.line` (`src/common/types.ts:70`) est remplacé par `(startOffset, endOffset)`. Aucun `line` numérique n'est persisté.

---

## 2. Signature de l'AnnotationStore (contenu de `src/transactional/AnnotationStore.ts`)

```typescript
// SPDX-License-Identifier: MPL-2.0
import * as vscode from 'vscode';
import type {
    AnnotationV2,
    AnnotationStoreFileV2,
    OpEntry,
    JournalSnapshot,
    ValidationResult,
    SuspendedEntry,
} from './types';

/** Options accepted by AnnotationStore.add. Either line OR offset is required. */
export interface AddOptions {
    /** Document line number (0-based) when adding via UI gesture. */
    line?: number;
    /** Pre-computed UTF-16 offset when adding via paste resume or programmatic flow. */
    offset?: number;
    /** Length of the anchored range. Defaults to length of the line at `line`. */
    length?: number;
}

/** Optional patch applied by update(). All fields are optional. */
export type AnnotationPatch = Partial<
    Omit<AnnotationV2, 'id' | 'schemaVersion' | 'startOffset' | 'endOffset' | 'state' | 'origin'>
>;

export interface AnnotationStoreEvents {
    onDidChange: vscode.Event<readonly OpEntry[]>;
    onDidSuspend: vscode.Event<SuspendedEntry>;
    onDidResume: vscode.Event<{ annotationId: string; opId: string }>;
}

export class AnnotationStore implements AnnotationStoreEvents {
    constructor(opts: { journalCapacity?: number; suspendTtlMs?: number });

    // ── Public events ────────────────────────────────────────────────────
    readonly onDidChange: vscode.Event<readonly OpEntry[]>;
    readonly onDidSuspend: vscode.Event<SuspendedEntry>;
    readonly onDidResume: vscode.Event<{ annotationId: string; opId: string }>;

    // ── CRUD ─────────────────────────────────────────────────────────────
    /**
     * Insert a new annotation.
     *
     * Contract: exactly ONE of `opts.line` or `opts.offset` MUST be provided.
     * Passing neither — or both — throws `RangeError`. This eliminates the
     * §1.4 ambiguity (line auto-derivation from offset and vice-versa).
     *
     * Returns the committed AnnotationV2 (frozen).
     * Emits an `add` OpEntry on onDidChange.
     */
    add(
        annotation: Omit<AnnotationV2, 'id' | 'schemaVersion' | 'startOffset' | 'endOffset' | 'state' | 'lineHash' | 'contextBefore' | 'contextAfter'>,
        opts: AddOptions,
        document: vscode.TextDocument
    ): Readonly<AnnotationV2>;

    /** Remove an annotation. Emits a `remove` OpEntry. Idempotent: no-op when id is unknown. */
    remove(id: string): void;

    /**
     * Patch arbitrary business fields. Refuses to mutate id, schemaVersion,
     * offsets, state, or origin (those flow through dedicated methods).
     * Emits an `update` OpEntry on success.
     */
    update(id: string, patch: AnnotationPatch): Readonly<AnnotationV2>;

    /** Lookup by id. Returns frozen snapshot or undefined. */
    get(id: string): Readonly<AnnotationV2> | undefined;

    /** Snapshot of all active+suspended annotations. */
    getAll(): ReadonlyArray<Readonly<AnnotationV2>>;

    /** All annotations whose fileUri matches. Excludes disposed. */
    getByFile(fileUri: string): ReadonlyArray<Readonly<AnnotationV2>>;

    // ── Document-driven anchor maintenance ───────────────────────────────
    /**
     * Apply a vscode.TextDocumentChangeEvent to every annotation in the
     * affected document. Implements the four-case offset-adjustment
     * algorithm specified in §3.
     *
     * MUST be called exactly once per `onDidChangeTextDocument` event.
     * Coalescing multiple events into a single call is a programming error
     * because each ContentChange is sequential and offsets accumulate.
     */
    applyDocumentChange(event: vscode.TextDocumentChangeEvent): void;

    // ── Transactional semantics ──────────────────────────────────────────
    /**
     * Begin an in-store transaction. Calls to add/remove/update inside
     * the transaction are buffered. commit() flushes them as a single
     * journal entry batch (still N OpEntry instances, but committed
     * atomically with respect to listeners).
     *
     * NOTE — atomicity scope: the transaction is atomic INSIDE the store.
     * It is NOT atomic with respect to vscode's own undo stack (limit L1).
     */
    beginTransaction(): void;
    commit(): void;
    rollback(): void;

    // ── Undo/Redo mirroring (limit L1) ───────────────────────────────────
    /**
     * Replay the journal in reverse to mirror an editor undo. Triggered
     * exclusively from `applyDocumentChange` when
     * `event.reason === vscode.TextDocumentChangeReason.Undo`.
     */
    mirrorUndo(documentVersion: number, fileUri: string): void;

    /**
     * Replay the journal forward to mirror an editor redo. Triggered when
     * `event.reason === vscode.TextDocumentChangeReason.Redo`.
     */
    mirrorRedo(documentVersion: number, fileUri: string): void;

    // ── Suspended buffer (limit L2 — cut/copy) ───────────────────────────
    /** Move an annotation to the suspended buffer keyed by blockHash. */
    suspend(id: string, blockHash: string): void;

    /**
     * Move a previously-suspended annotation back to active state at the
     * given offset. Recomputes lineHash + context against the document.
     */
    resume(id: string, document: vscode.TextDocument, atOffset: number): Readonly<AnnotationV2>;

    /** Inspect the suspended buffer (used by paste-detection logic). */
    getSuspendedByHash(blockHash: string): ReadonlyArray<SuspendedEntry>;

    // ── Validation ───────────────────────────────────────────────────────
    /**
     * Run all invariants over the store. Pure: never mutates state.
     * Invariants checked:
     *   I1 unicité ID
     *   I2 0 <= startOffset <= endOffset
     *   I3 schemaVersion === 2
     *   I4 state === 'suspended' ⇔ entry présente dans le buffer
     *   I5 lineHash + contextBefore + contextAfter non absents pour les actives
     *   I6 origin.kind === 'paste' ⇒ origin.sourceOpId résolvable dans le journal
     */
    validate(): ValidationResult;

    // ── Persistence ──────────────────────────────────────────────────────
    /** Produce the on-disk envelope. Disposed entries are excluded. */
    serialize(): AnnotationStoreFileV2;

    /**
     * Replace store contents from an envelope. Throws on
     * schemaVersion !== 2 (no migration path — refonte complète).
     */
    deserialize(file: AnnotationStoreFileV2): void;

    // ── Journal access (read-only) ───────────────────────────────────────
    getJournal(): JournalSnapshot;
}
```

> **Pas d'API publique pour pousser un OpEntry directement** : tous les OpEntry sont émis par les mutateurs (`add`/`remove`/`update`/`suspend`/`resume`). Cela garantit que chaque entrée a son `before`/`after`/`inverse` cohérents.

---

## 3. Algorithme d'ajustement d'offset

À chaque `vscode.TextDocumentContentChangeEvent` reçu via `applyDocumentChange`, pour chaque annotation `ann` dont `ann.fileUri === document.uri.toString() && ann.state === 'active'` :

```
let R0 = change.rangeOffset
let R1 = change.rangeOffset + change.rangeLength
let delta = change.text.length - change.rangeLength
let A0 = ann.startOffset
let A1 = ann.endOffset
```

**Cas A — édition strictement avant l'annotation** (`R1 <= A0`)
```
ann.startOffset = A0 + delta
ann.endOffset   = A1 + delta
// lineHash + context inchangés (le contenu de la ligne ancrée n'a pas bougé).
// → recalculer SI la ligne contenant startOffset a changé d'index :
//    if (change.text.includes('\n') || change.rangeLength contenait '\n')
//        recompute lineHash + context via document.lineAt(positionAt(ann.startOffset).line)
```

**Cas B — édition strictement après l'annotation** (`R0 >= A1`)
```
no-op
```

**Cas C — édition strictement intérieure** (`R0 >= A0 && R1 <= A1`)
```
// L'annotation grandit/rétrécit avec le contenu inséré/supprimé en son sein.
// Résout §7.2 (insertion intra-annotation préserve l'ancre).
ann.endOffset = A1 + delta
// lineHash + context inchangés si la ligne d'ancrage n'a pas elle-même
// été modifiée par cet event :
//    if (R0 < ligneStart de positionAt(A0)) → recompute lineHash + context
```

**Cas D — recouvrement partiel ou total** (`(R0 < A0 && R1 > A0) || (R0 < A1 && R1 > A1) || (R0 <= A0 && R1 >= A1)`)
```
let blockHash = hashLine(change.rangeLength > 0
    ? document.getText(new Range(positionAt(R0), positionAt(R1)))
    : '')
suspend(ann.id, blockHash)
// L'annotation entre dans le buffer suspendu ; elle ne porte plus
// d'offsets actifs. Pas d'orphan persistent au sens v1 — le concept
// d'"orphelin" disparaît : suspended OU disposed.
```

### Recalcul de `lineHash` + `contextBefore` + `contextAfter`

Quand un cas A ou C requiert un refresh (changement de structure de lignes), on délègue à `captureAnchor` de `src/anchoring/anchor.ts` :

```typescript
const lineIdx = document.positionAt(ann.startOffset).line;
const refreshed = captureAnchor(document, lineIdx, { walkForward: 0, walkBackward: 0 });
ann.lineHash = refreshed.lineHash;
ann.contextBefore = refreshed.contextBefore;
ann.contextAfter = refreshed.contextAfter;
```

> **Pourquoi `walkForward: 0` / `walkBackward: 0`** : à ce stade, l'offset est l'autorité ; on ne veut pas que captureAnchor saute à une ligne voisine. Le walk est réservé à la création (`add`) où le curseur peut tomber sur une ligne vide.

### Ordre d'application

`vscode.TextDocumentChangeEvent.contentChanges` est livré dans l'ordre **inverse** des positions du document (du plus loin vers le plus proche du début) — cf. doc VS Code. `applyDocumentChange` itère donc dans l'ordre fourni (chaque event est sans recoupement avec les autres dans le même batch), MAIS chaque ContentChange est appliquée séparément à toutes les annotations affectées, sans cumul du `delta` d'une ContentChange à l'autre — chaque ContentChange porte ses propres `rangeOffset/rangeLength/text` indépendants.

---

## 4. Cut / Copy / Paste

### Buffer suspendu

```typescript
class SuspendedBuffer {
    private readonly entries = new Map<string /*blockHash*/, SuspendedEntry[]>();
    private readonly ttlMs: number;

    add(entry: SuspendedEntry): void;
    /** Returns matches for blockHash and removes them from the buffer. */
    pop(blockHash: string): SuspendedEntry[];
    /** Sweep entries older than TTL. Called on a vscode.Disposable timer. */
    sweep(now: number): SuspendedEntry[];
}
```

- Clé : `blockHash = hashLine(cutText)` (FNV-1a 32 bits, normalisé via `normalizeLine`).
- TTL par défaut : **30 000 ms** (`outOfCodeInsights.suspendedTtlMs`). À l'expiration, l'entrée passe à `disposed` (l'OpEntry `suspend` reste dans le journal pour permettre un éventuel undo qui reviendrait avant la suppression).
- Plusieurs annotations peuvent partager un blockHash (deux annotations dans le même bloc cut). `pop` retourne la liste complète et toutes sont resumées au même paste.

### Détection cut

Lors d'un `applyDocumentChange` qui matche le **Cas D** :
1. Calculer `blockHash` du texte supprimé (`document.getText` sur le range AVANT de laisser l'event muter le buffer — donc capture du texte fait dans `onWillChangeTextDocument` si possible, sinon depuis `event.contentChanges[i].rangeLength` matérialisé en texte via un cache court-terme du contenu de ligne).
2. Pour chaque annotation recouverte → `suspend(ann.id, blockHash)`.

### Détection copy (sans suppression)

Le copy n'émet PAS de change event. La détection passe par `vscode.commands.executeCommand` interception ou `vscode.env.clipboard` polling — **non implémenté en Phase 1**, traité comme dégradé acceptable : seule la séquence cut → paste est supportée pour la Phase 1. Le copy → paste **standard** crée des annotations via une voie dédiée :

### Paste — résolution

Lors d'un `applyDocumentChange` où `change.rangeLength === 0 && change.text.length > 0` :
1. `pasteHash = hashLine(change.text)` (le hash porte sur le bloc inséré entier ; voir note sur les blocs multilignes ci-dessous).
2. `matches = suspendedBuffer.pop(pasteHash)`.
3. Si `matches.length > 0` (cas paste-after-cut) :
   - Pour chaque `entry` dans `matches` → `resume(entry.annotation.id, document, change.rangeOffset)`.
   - L'opération `resume` ré-attache à `startOffset = change.rangeOffset` et recalcule lineHash/context.
4. Si `matches.length === 0` ET le paste correspond à un copy interne récent (détecté via le journal — ann.origin.kind === 'manual' avec snippet matchant `change.text`) → cas **paste-after-copy** :
   - Pour chaque annotation `src` matchante → `add({...src, message: src.message, ..., origin: { kind: 'paste', sourceOpId: <opId du add original> } }, { offset: change.rangeOffset + (src.startOffset - sourceBlockStart) }, document)`.
   - Nouveau UUID, ancrage indépendant. **Respect §4 et §7.6** : deux entités distinctes, IDs différents, mais lien de traçabilité via `origin.sourceOpId`.

### Hash multilignes

Les blocs cut sont rarement monoligne. Pour les blocs >1 ligne :
- `blockHash = hashLine(text)` où `hashLine` est appliqué au texte entier après `normalizeLine` (collapse des whitespaces). Cela suffit pour identifier un bloc (collisions FNV-1a 32 bits acceptables sur la durée du TTL).

---

## 5. Format JSON v2 — exemple complet

Fichier `<workspace>/.out-of-code-insights/annotations.json` :

```json
{
  "schemaVersion": 2,
  "annotations": [
    {
      "id": "8a4f9b1d-2c1e-4a4a-9e3a-7c0a3b1f2d5a",
      "schemaVersion": 2,
      "fileUri": "file:///e:/sources/out-of-code-insights/src/extension.ts",
      "file": "src/extension.ts",
      "startOffset": 1820,
      "endOffset": 1865,
      "lineHash": "5b8a91e0",
      "contextBefore": [
        "import * as vscode from 'vscode';",
        "import { AnnotationManager } from './managers/AnnotationManager';"
      ],
      "contextAfter": [
        "export function activate(context: vscode.ExtensionContext) {",
        "    const manager = new AnnotationManager(context);"
      ],
      "state": "active",
      "origin": { "kind": "manual" },
      "message": "Polyfill must run before any other import.",
      "author": "jacques",
      "timestamp": "2026-05-06T09:14:00.000Z",
      "tags": ["arch", "polyfill"],
      "pinned": true,
      "priority": 1,
      "severity": "info",
      "resolved": false,
      "snippet": {
        "code": "import 'node-abort-controller/polyfill';",
        "language": "typescript"
      },
      "languageId": "typescript"
    },
    {
      "id": "f3c2d1e9-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
      "schemaVersion": 2,
      "fileUri": "file:///e:/sources/out-of-code-insights/src/managers/AnnotationManager.ts",
      "file": "src/managers/AnnotationManager.ts",
      "startOffset": 12450,
      "endOffset": 12450,
      "lineHash": "a1b2c3d4",
      "contextBefore": ["    private async loadAnnotations() {"],
      "contextAfter": ["        const file = await this.path();"],
      "state": "active",
      "origin": { "kind": "paste", "sourceOpId": "31a8e6b4-9f1d-4c2a-88a3-2e0b6c7d9f00" },
      "message": "Pasted from src/extension.ts L42 — keep IO at root.",
      "timestamp": "2026-05-06T09:30:00.000Z"
    }
  ]
}
```

Notes :
- Le journal et le buffer suspendu **ne sont pas persistés** sur disque (volatiles, perdus à la fermeture de la fenêtre VS Code). Conséquence : un cut suivi d'un reload de fenêtre passe les annotations recouvertes à `disposed` au prochain sweep. Documenté comme dégradation acceptable pour la Phase 1.
- L'absence de `endOffset` strictement supérieur à `startOffset` (cf. seconde annotation : 12450/12450) est valide pour un ancrage en caret.

---

## 6. Points de remplacement dans les consommateurs

Cette section sera **alimentée par worker-2** (mapping file:line des sites qui lisent `Annotation.line` / `Annotation.id` / appellent `AnnotationManager.add/remove/update`). À NE PAS ré-auditer ici.

Forme attendue de la livraison worker-2 :

| Site (file:line) | Lecture/écriture | Substitution |
|------------------|------------------|--------------|
| `src/managers/AnnotationManager.ts:NNN` | écrit `ann.line` | `store.applyDocumentChange` |
| `src/views/AnnotationsTreeDataProvider.ts:NNN` | lit `ann.line` | `document.positionAt(ann.startOffset).line` |
| `src/decorations/...:NNN` | lit `ann.line` | identique |
| `src/test/...` | crée des annotations avec `{ line }` | `store.add(..., { line })` |

Le présent document inclura le tableau définitif livré par worker-2 lors de la consolidation Phase 1.

---

## 7. Plan de lots (7 batches)

Critère vert pour CHAQUE lot : `npm run typecheck` ✓ + `npm run lint:ci` ✓ (0 warnings) + `npm run test:unit` ✓ + `npm test` ✓.

Chaque lot livre ses tests d'intégration EDH **failing-test-first** avant l'implémentation.

### Lot 1 — Types et squelette du store
- **Fichiers créés** : `src/transactional/types.ts`, `src/transactional/AnnotationStore.ts` (squelette avec stubs `throw new Error('not implemented')`), `src/transactional/__tests__/types.test.ts`.
- **Tests EDH** : aucun (lot infra).
- **Tests unitaires** : sérialisation/désérialisation envelope, refus de schemaVersion ≠ 2, validation des invariants I1-I3 sur fixtures statiques.
- **Dépendances** : aucune.
- **§ couverts** : §10 (schéma versionné).

### Lot 2 — CRUD + journal
- **Fichiers** : `AnnotationStore.ts` (add/remove/update/get/getAll/getByFile, journal append, événements).
- **Tests EDH** : `src/test/suite/transactional/crud.integration.test.ts`.
- **Tests unitaires** : `add` exige line XOR offset (RangeError sur 0 ou 2), update refuse mutation des champs immuables, journal capacity respectée (cyclic), événements `onDidChange` émis.
- **Dépendances** : Lot 1.
- **§ couverts** : §1, §2, §6.1, §10.

### Lot 3 — applyDocumentChange (Cas A/B/C)
- **Fichiers** : `AnnotationStore.ts` (offset adjustment), `src/transactional/__tests__/applyDocumentChange.test.ts`.
- **Tests EDH** : `src/test/suite/transactional/edit-tracking.integration.test.ts` — édition en amont, en aval, intra-annotation. Citer §7.1 (édition avant) et §7.2 (édition intra).
- **Tests unitaires** : delta correct sur 3 cas, lineHash refresh ssi structure de lignes change.
- **Dépendances** : Lot 2.
- **§ couverts** : §3, §7.1, §7.2.

### Lot 4 — Cas D (recouvrement) + suspended buffer + cut
- **Fichiers** : `AnnotationStore.ts` (suspend/resume), `src/transactional/SuspendedBuffer.ts`, tests dédiés.
- **Tests EDH** : `src/test/suite/transactional/cut.integration.test.ts` — cut d'un bloc contenant une annotation, vérifie `state === 'suspended'`. Couvre §7.3 (cut sans paste : annotation reste suspended jusqu'à TTL).
- **Tests unitaires** : suspend déplace bien l'entrée, sweep TTL passe à disposed, hash multiligne stable.
- **Dépendances** : Lot 3.
- **§ couverts** : §3 cas D, §7.3, §7.4.

### Lot 5 — Paste (resume) + paste-after-copy
- **Fichiers** : `AnnotationStore.ts` (resume), `PasteRouter` (heuristique paste-after-cut vs paste-after-copy).
- **Tests EDH** : `src/test/suite/transactional/paste.integration.test.ts` — cut+paste à un autre offset, copy+paste = nouvelle entité avec `origin.kind === 'paste'`. Couvre §7.5 (paste-after-cut au bon offset) et §7.6 (paste-after-copy crée une nouvelle entité).
- **Tests unitaires** : pop du buffer atomique (deux pastes du même hash ne récupèrent pas deux fois), nouveaux UUIDs pour copy+paste, `origin.sourceOpId` résolvable dans le journal.
- **Dépendances** : Lot 4.
- **§ couverts** : §4, §7.5, §7.6.

### Lot 6 — Mirroring undo/redo + transactions
- **Fichiers** : `AnnotationStore.ts` (beginTransaction/commit/rollback/mirrorUndo/mirrorRedo), tests.
- **Tests EDH** : `src/test/suite/transactional/undo.integration.test.ts` — éditeur fait Undo après cut → annotation revient à `active` au bon offset. Couvre §7.7 (undo cut).
- **Tests unitaires** : transaction rollback ne laisse pas d'entrée journal partielle, mirrorUndo replay inverse l'op pointée par cursor, alignment via `documentVersionAtOp`.
- **Dépendances** : Lot 5.
- **§ couverts** : §5, §7.7, §7.8, L1.

### Lot 7 — Substitution dans les consommateurs (mapping worker-2)
- **Fichiers** : tous les sites listés en §6 (typiquement `src/managers/AnnotationManager.ts`, `src/views/*`, `src/decorations/*`, tests existants). Suppression définitive du champ `Annotation.line` et des chemins legacy `lineHash`/`contextBefore`/`contextAfter` *en tant qu'ancres autoritatives*.
- **Tests EDH** : la suite intégrée existante tourne au vert, plus le smoke-test cross-feature `src/test/suite/transactional/end-to-end.integration.test.ts` (création → édition → cut → paste → undo → reload workspace).
- **Tests unitaires** : `loadAnnotations`/`saveAnnotations` refusent un fichier schemaVersion ≠ 2 ; `Annotation` legacy ne compile plus (regression test sur les imports).
- **Dépendances** : Lots 1-6 + livraison worker-2.
- **§ couverts** : §8, §9, intégration globale.

---

## 8. Décisions sur ambiguïtés de spec

### D1 — §6.2 « duplication implicite interdite » vs §4 « copy = nouvelle entité »

**Décision** : implémenter §4. Une copie utilisateur (copy+paste) produit une **nouvelle annotation** avec UUID distinct et `origin.kind === 'paste' + sourceOpId`.

**Raisonnement** :
- §6.2 vise la duplication *implicite* — un bug de code qui dupliquerait un id sans action utilisateur (ex. `getAll().forEach(a => store.add(a))`). C'est un invariant de cohérence interne (validé par I1).
- §4 décrit une duplication *explicite*, intentionnelle, avec sémantique claire (l'utilisateur veut deux annotations à deux endroits).
- Ces deux règles sont compatibles : l'invariant I1 (unicité ID) reste vrai puisque le UUID v4 généré est nouveau. Le lien sémantique remonte via `origin.sourceOpId`, sans collision d'identité.
- Côté UI, le rendu peut afficher un badge « copie de #abcd... » pour signaler la traçabilité, mais ce n'est pas requis par §4.

### D2 — §7.4 « annotation gelée stockée avec le bloc »

**Décision** : implémenter via le buffer suspendu extension-local indexé par hash de bloc. **Pas** de tentative d'attacher l'annotation au clipboard OS.

**Raisonnement** :
- Limite L2 : le clipboard OS est out-of-process et n'accepte pas de payload structuré transversal aux applications.
- Stocker dans un buffer extension-local couvre 95 %+ des cas (cut → paste dans la même session VS Code).
- TTL configurable (30 s par défaut) limite la rétention de blocs morts.
- Cas non couvert : cut → fermeture de fenêtre → réouverture → paste. Documenté comme dégradation acceptable (§7.4 implique stockage *en mémoire de l'éditeur*, pas persistance disque).

### D3 — §7.5 « paste après cut au bon offset »

**Décision** : implémenter via match `pasteHash === blockHash` calculé sur le texte inséré, suivi de `resume(annId, document, change.rangeOffset)`.

**Raisonnement** :
- L'event `onDidChangeTextDocument` du paste fournit `rangeOffset` (point d'insertion) et `text` (contenu inséré). Le hash du contenu inséré est l'identité du bloc cut côté contenu.
- Match déterministe tant que le contenu n'a pas été réédité entre le cut et le paste — ce qui est le cas standard.
- Si l'utilisateur édite le clipboard externe entre cut et paste, le hash divergera et le buffer expirera silencieusement (TTL). Documenté.
- L'offset `startOffset` post-resume = `change.rangeOffset + (oldStartOffset - oldBlockStart)` pour préserver la position relative dans le bloc. Le `endOffset` suit la même translation. Algorithme exact dans `resume()`.

---

## 9. Conformité conventions repo

- **TypeScript strict** : tous les types sont explicites, aucun `any` ; les retours sont typés, `noImplicitReturns` respecté.
- **Lint zéro warning** : pas d'unused imports, pas de `console.log` (logging via `getLogger()` de `src/utils/logger.ts`).
- **MPL-2.0** : header SPDX en tête de chaque nouveau fichier.
- **Conventional Commits par lot** :
  - Lot 1 → `feat(transactional): add AnnotationStore types and skeleton`
  - Lot 2 → `feat(transactional): implement CRUD and journal`
  - Lot 3 → `feat(transactional): handle in-document edit cases A/B/C`
  - Lot 4 → `feat(transactional): suspend annotations on overlapping deletes`
  - Lot 5 → `feat(transactional): resume on paste and clone on copy-paste`
  - Lot 6 → `feat(transactional): mirror editor undo/redo into the journal`
  - Lot 7 → `refactor(annotations): switch consumers to AnnotationStore v2`
- **CHANGELOG.md** : entrée `[Unreleased]` à chaque lot sous `### Changed` (lots 7) ou `### Added` (lots 1-6).
- **Tests** : intégration via `src/test/suite/transactional/*.integration.test.ts` (compilés vers `out/`), unitaires sous `src/transactional/__tests__/`. Coverage attendue ≥ thresholds c8 (15/15/10).

---

## 10. Glossaire

- **L1 / L2 / L3** : limites architecturales acceptées (cf. §0).
- **Buffer suspendu** : `Map<blockHash, SuspendedEntry[]>` extension-local, indexé par hash du bloc cut, TTL configurable.
- **Journal** : liste cyclique d'`OpEntry`, append-only, bornée par `journalCapacity`.
- **OpEntry** : enregistrement immuable d'une mutation du store (kind + before + after + inverse).
- **Origin chain** : chaîne `origin.sourceOpId` reliant une annotation paste à l'OpEntry source (pour audit / UI badge).
- **schemaVersion 2** : seul format accepté en lecture/écriture par le store v2. Pas de migration depuis v1.
