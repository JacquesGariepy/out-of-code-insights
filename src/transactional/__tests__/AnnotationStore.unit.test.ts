// SPDX-License-Identifier: MPL-2.0
/**
 * Pure-Node unit tests for src/transactional/AnnotationStore.ts.
 *
 * The store imports `vscode` only as a type (`import type * as vscode`),
 * so this file can construct it without spawning the EDH. Documents and
 * change events are duck-typed mocks; the casts to `vscode.TextDocument`
 * and `vscode.TextDocumentChangeEvent` are erased at compile time.
 */
import * as assert from 'assert';
import type * as vscode from 'vscode';
import { hashLine } from '../../anchoring/anchor';
import { AnnotationStore, type AnnotationDraft } from '../AnnotationStore';
import { ANNOTATION_SCHEMA_VERSION, type AnnotationStoreFileV2, type AnnotationV2, type OpEntry } from '../types';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

interface MockPosition {
    line: number;
    character: number;
}

interface MockRange {
    start: MockPosition;
    end: MockPosition;
}

interface MockDoc {
    uri: { toString(): string };
    lineCount: number;
    languageId: string;
    fileName: string;
    version: number;
    getText(): string;
    lineAt(line: number): { text: string; lineNumber: number; range: MockRange };
    positionAt(offset: number): MockPosition;
    offsetAt(pos: MockPosition): number;
}

function makeDoc(text: string, uri = 'file:///test.ts', version = 1): MockDoc {
    const lines = text.split('\n');
    // lineStarts[i] = offset of the first character of line i
    const lineStarts: number[] = [0];
    for (let i = 0; i < lines.length; i++) {
        lineStarts.push(lineStarts[i] + lines[i].length + 1); // +1 for '\n'
    }
    return {
        uri: { toString: () => uri },
        lineCount: lines.length,
        languageId: 'typescript',
        fileName: '/test.ts',
        version,
        getText: () => text,
        lineAt: (line: number) => ({
            text: lines[line] ?? '',
            lineNumber: line,
            range: {
                start: { line, character: 0 },
                end: { line, character: lines[line]?.length ?? 0 },
            },
        }),
        positionAt: (offset: number) => {
            for (let i = 0; i < lineStarts.length - 1; i++) {
                const start = lineStarts[i];
                const next = lineStarts[i + 1];
                if (offset < next) {
                    return { line: i, character: offset - start };
                }
            }
            // Beyond end → last line, last character.
            const last = lines.length - 1;
            return { line: last, character: lines[last]?.length ?? 0 };
        },
        offsetAt: (pos: { line: number; character: number }) => {
            const start = lineStarts[pos.line] ?? 0;
            return start + pos.character;
        },
    };
}

function asDoc(d: MockDoc): vscode.TextDocument {
    return d as unknown as vscode.TextDocument;
}

interface MockChange {
    range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
    };
    rangeOffset: number;
    rangeLength: number;
    text: string;
}

function makeEvent(doc: MockDoc, changes: MockChange[], reason?: 1 | 2): vscode.TextDocumentChangeEvent {
    return {
        document: asDoc(doc),
        contentChanges: changes,
        reason,
    } as unknown as vscode.TextDocumentChangeEvent;
}

function defaultDraft(uri = 'file:///test.ts', file = 'test.ts'): AnnotationDraft {
    return {
        fileUri: uri,
        file,
        origin: { kind: 'manual' },
        message: 'test annotation',
        author: 'tester',
        timestamp: '2026-05-06T12:00:00.000Z',
    };
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

suite('AnnotationStore — construction', () => {
    test('default constructor stores empty map and zero-length journal', () => {
        const store = new AnnotationStore();
        assert.strictEqual(store.getAll().length, 0);
        const j = store.getJournal();
        assert.strictEqual(j.entries.length, 0);
        assert.strictEqual(j.cursor, 0);
        assert.strictEqual(j.capacity, 1024);
    });

    test('custom journal capacity is honoured', () => {
        const store = new AnnotationStore({ journalCapacity: 16 });
        assert.strictEqual(store.getJournal().capacity, 16);
    });

    test('rejects non-positive or non-integer journal capacity', () => {
        assert.throws(() => new AnnotationStore({ journalCapacity: 0 }), RangeError);
        assert.throws(() => new AnnotationStore({ journalCapacity: -1 }), RangeError);
        assert.throws(() => new AnnotationStore({ journalCapacity: 1.5 }), RangeError);
    });
});

// ---------------------------------------------------------------------------
// add — line XOR offset contract
// ---------------------------------------------------------------------------

suite('AnnotationStore — add (line XOR offset contract)', () => {
    test('throws RangeError when neither line nor offset is provided', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('hello\nworld');
        assert.throws(() => store.add(defaultDraft(), {}, asDoc(doc)), RangeError);
    });

    test('throws RangeError when both line and offset are provided', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('hello\nworld');
        assert.throws(() => store.add(defaultDraft(), { line: 0, offset: 0 }, asDoc(doc)), RangeError);
    });

    test('add via line: stores active annotation with schemaVersion=2 and UUID id', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('hello\nworld');
        const ann = store.add(defaultDraft(), { line: 0 }, asDoc(doc));
        assert.match(ann.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
        assert.strictEqual(ann.schemaVersion, ANNOTATION_SCHEMA_VERSION);
        assert.strictEqual(ann.state, 'active');
        assert.strictEqual(ann.startOffset, 0);
        assert.strictEqual(ann.endOffset, 'hello'.length);
    });

    test('add via offset: positionAt resolves the line correctly', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('hello\nworld');
        // 'world' starts at offset 6 (5 + 1 for the newline).
        const ann = store.add(defaultDraft(), { offset: 6 }, asDoc(doc));
        assert.strictEqual(ann.startOffset, 6);
        assert.strictEqual(ann.endOffset, 6 + 'world'.length);
    });

    test('explicit length overrides the line-length default', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('hello world');
        const ann = store.add(defaultDraft(), { line: 0, length: 5 }, asDoc(doc));
        assert.strictEqual(ann.startOffset, 0);
        assert.strictEqual(ann.endOffset, 5);
    });

    test('zero-length anchor (caret) is allowed', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('hello world');
        const ann = store.add(defaultDraft(), { line: 0, length: 0 }, asDoc(doc));
        assert.strictEqual(ann.startOffset, 0);
        assert.strictEqual(ann.endOffset, 0);
    });

    test('emits onDidChange with a single add OpEntry', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('hello\nworld');
        const events: ReadonlyArray<OpEntry>[] = [];
        const sub = store.onDidChange((batch) => events.push(batch));
        store.add(defaultDraft(), { line: 0 }, asDoc(doc));
        sub.dispose();
        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].length, 1);
        assert.strictEqual(events[0][0].kind, 'add');
        assert.strictEqual(events[0][0].before, null);
        assert.ok(events[0][0].after);
    });

    test('returned annotation is frozen (defensive against mutation)', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('hello');
        const ann = store.add(defaultDraft(), { line: 0 }, asDoc(doc));
        assert.ok(Object.isFrozen(ann));
    });
});

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

suite('AnnotationStore — remove', () => {
    test('removes an existing annotation and journals a remove OpEntry', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('hello');
        const ann = store.add(defaultDraft(), { line: 0 }, asDoc(doc));
        store.remove(ann.id);
        assert.strictEqual(store.get(ann.id), undefined);
        const journal = store.getJournal();
        assert.strictEqual(journal.entries.length, 2);
        assert.strictEqual(journal.entries[1].kind, 'remove');
        assert.ok(journal.entries[1].before);
        assert.strictEqual(journal.entries[1].after, null);
    });

    test('is idempotent on unknown id (no throw, no journal entry)', () => {
        const store = new AnnotationStore();
        store.remove('00000000-0000-4000-8000-000000000000');
        assert.strictEqual(store.getJournal().entries.length, 0);
    });
});

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

suite('AnnotationStore — update', () => {
    test('patches a business field and journals an update OpEntry', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('hello');
        const ann = store.add(defaultDraft(), { line: 0 }, asDoc(doc));
        const updated = store.update(ann.id, { message: 'patched', pinned: true });
        assert.strictEqual(updated.message, 'patched');
        assert.strictEqual(updated.pinned, true);
        const journal = store.getJournal();
        const last = journal.entries[journal.entries.length - 1];
        assert.strictEqual(last.kind, 'update');
        assert.strictEqual(last.before?.message, 'test annotation');
        assert.strictEqual(last.after?.message, 'patched');
    });

    test('throws Error on unknown id', () => {
        const store = new AnnotationStore();
        assert.throws(() => store.update('00000000-0000-4000-8000-000000000000', { message: 'x' }), /not found/);
    });
});

// ---------------------------------------------------------------------------
// getAll / getByFile
// ---------------------------------------------------------------------------

suite('AnnotationStore — getAll / getByFile', () => {
    test('getAll returns frozen snapshots for all annotations', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('hello\nworld');
        store.add(defaultDraft(), { line: 0 }, asDoc(doc));
        store.add(defaultDraft(), { line: 1 }, asDoc(doc));
        const all = store.getAll();
        assert.strictEqual(all.length, 2);
        for (const a of all) {
            assert.ok(Object.isFrozen(a));
        }
    });

    test('getByFile filters by fileUri', () => {
        const store = new AnnotationStore();
        const docA = makeDoc('hello', 'file:///a.ts');
        const docB = makeDoc('world', 'file:///b.ts');
        store.add(defaultDraft('file:///a.ts', 'a.ts'), { line: 0 }, asDoc(docA));
        store.add(defaultDraft('file:///b.ts', 'b.ts'), { line: 0 }, asDoc(docB));
        assert.strictEqual(store.getByFile('file:///a.ts').length, 1);
        assert.strictEqual(store.getByFile('file:///b.ts').length, 1);
        assert.strictEqual(store.getByFile('file:///c.ts').length, 0);
    });
});

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

suite('AnnotationStore — validate (I1-I3)', () => {
    test('empty store is valid', () => {
        const result = new AnnotationStore().validate();
        assert.strictEqual(result.valid, true);
        assert.strictEqual(result.violations.length, 0);
    });

    test('healthy add -> validate passes', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('hello world');
        store.add(defaultDraft(), { line: 0 }, asDoc(doc));
        const result = store.validate();
        assert.strictEqual(result.valid, true);
    });

    test('I2 — corrupted offset range is reported', () => {
        const store = new AnnotationStore();
        const corrupted: AnnotationV2 = {
            id: '00000000-0000-4000-8000-000000000001',
            schemaVersion: ANNOTATION_SCHEMA_VERSION,
            fileUri: 'file:///x.ts',
            file: 'x.ts',
            startOffset: 50,
            endOffset: 10, // start > end
            lineHash: '00000000',
            contextBefore: [],
            contextAfter: [],
            state: 'active',
            origin: { kind: 'manual' },
            message: 'corrupted',
            timestamp: '2026-05-06T12:00:00.000Z',
        };
        store.deserialize({
            schemaVersion: ANNOTATION_SCHEMA_VERSION,
            annotations: [corrupted],
        });
        const result = store.validate();
        assert.strictEqual(result.valid, false);
        assert.ok(result.violations.some((v) => v.code === 'invalid-offset-range'));
    });
});

suite('AnnotationStore — tracking diagnostics', () => {
    test('reports healthy open-document anchors without exposing source text', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('alpha\nbeta');
        const ann = store.add(defaultDraft(), { line: 1 }, asDoc(doc));
        const report = store.diagnose([asDoc(doc)]);

        assert.strictEqual(report.valid, true);
        assert.deepStrictEqual(report.counts, { total: 1, active: 1, suspended: 0, withIssues: 0 });
        assert.strictEqual(report.annotations[0].id, ann.id);
        assert.strictEqual(report.annotations[0].resolvedLine, 1);
        assert.strictEqual(report.annotations[0].hashMatches, true);
        assert.strictEqual(JSON.stringify(report).includes('beta'), false, 'source line content is never included');
    });

    test('flags closed documents, hash drift and suspended state', () => {
        const store = new AnnotationStore();
        const original = makeDoc('alpha\nbeta');
        const changed = makeDoc('alpha\nchanged');
        const active = store.add(defaultDraft(), { line: 1 }, asDoc(original));
        const suspended = store.add({ ...defaultDraft(), message: 'cut' }, { line: 0 }, asDoc(original));
        store.suspend(suspended.id, suspended.lineHash);

        const openReport = store.diagnose([asDoc(changed)]);
        assert.ok(openReport.annotations.find((item) => item.id === active.id)?.issues.includes('line-hash-mismatch'));
        assert.ok(openReport.annotations.find((item) => item.id === suspended.id)?.issues.includes('awaiting-paste'));

        const closedReport = store.diagnose();
        assert.ok(closedReport.annotations.every((item) => item.issues.includes('document-not-open')));
    });
});

// ---------------------------------------------------------------------------
// serialize / deserialize
// ---------------------------------------------------------------------------

suite('AnnotationStore — serialize / deserialize', () => {
    test('round-trip preserves annotation contents', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('hello\nworld');
        const ann = store.add(defaultDraft(), { line: 0 }, asDoc(doc));
        const file = store.serialize();
        assert.strictEqual(file.schemaVersion, ANNOTATION_SCHEMA_VERSION);
        assert.strictEqual(file.annotations.length, 1);

        const fresh = new AnnotationStore();
        fresh.deserialize(file);
        const restored = fresh.get(ann.id);
        assert.ok(restored);
        assert.strictEqual(restored.message, ann.message);
        assert.strictEqual(restored.startOffset, ann.startOffset);
        assert.strictEqual(restored.endOffset, ann.endOffset);
    });

    test('deserialize clears the existing map and journal', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('hello');
        store.add(defaultDraft(), { line: 0 }, asDoc(doc));
        store.deserialize({
            schemaVersion: ANNOTATION_SCHEMA_VERSION,
            annotations: [],
        });
        assert.strictEqual(store.getAll().length, 0);
        assert.strictEqual(store.getJournal().entries.length, 0);
    });

    test('refuses schemaVersion !== 2 at envelope level', () => {
        const store = new AnnotationStore();
        const bad = {
            schemaVersion: 1 as unknown as typeof ANNOTATION_SCHEMA_VERSION,
            annotations: [],
        } as AnnotationStoreFileV2;
        assert.throws(() => store.deserialize(bad), /schemaVersion/);
    });

    test('refuses schemaVersion !== 2 at per-annotation level', () => {
        const store = new AnnotationStore();
        const bad: AnnotationV2 = {
            id: '00000000-0000-4000-8000-000000000002',
            schemaVersion: 99 as unknown as typeof ANNOTATION_SCHEMA_VERSION,
            fileUri: 'file:///x.ts',
            file: 'x.ts',
            startOffset: 0,
            endOffset: 0,
            lineHash: '00000000',
            contextBefore: [],
            contextAfter: [],
            state: 'active',
            origin: { kind: 'manual' },
            message: 'bad',
            timestamp: '2026-05-06T12:00:00.000Z',
        };
        const file: AnnotationStoreFileV2 = {
            schemaVersion: ANNOTATION_SCHEMA_VERSION,
            annotations: [bad],
        };
        assert.throws(() => store.deserialize(file), /schemaVersion/);
    });
});

// ---------------------------------------------------------------------------
// applyDocumentChange — Cas A / B / C / D
// ---------------------------------------------------------------------------

suite('AnnotationStore — applyDocumentChange Cas A (edit before annotation)', () => {
    test('shifts both startOffset and endOffset by delta', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('abcdefghij'); // 10 chars on a single line
        const ann = store.add(defaultDraft(), { line: 0, length: 0 }, asDoc(doc));
        // Move the annotation manually to range [5, 7) ('fg') for the test.
        store.update(ann.id, {});
        // Direct mutation via the deserialize path keeps the test focused on
        // applyDocumentChange arithmetic without depending on a particular
        // add() input shape for sub-line positioning.
        const file = store.serialize();
        file.annotations[0].startOffset = 5;
        file.annotations[0].endOffset = 7;
        store.deserialize(file);

        // Replace 'abc' (range [0, 3), rangeOffset=0, rangeLength=3) with 'AB' (text='AB', delta=-1).
        const change: MockChange = {
            range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 3 },
            },
            rangeOffset: 0,
            rangeLength: 3,
            text: 'AB',
        };
        store.applyDocumentChange(makeEvent(doc, [change]));

        const updated = store.get(ann.id);
        assert.ok(updated);
        assert.strictEqual(updated.startOffset, 4);
        assert.strictEqual(updated.endOffset, 6);
    });

    test('insert at offset 0 (R1=A0 boundary still A) shifts offsets forward', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('hello world');
        const ann = store.add(defaultDraft(), { line: 0, length: 0 }, asDoc(doc));
        const file = store.serialize();
        file.annotations[0].startOffset = 5;
        file.annotations[0].endOffset = 11;
        store.deserialize(file);

        // Pure insert of 3 chars at offset 0: rangeLength=0, text='XYZ', delta=+3.
        // R1 = R0 + 0 = 0 <= A0=5 → Cas A.
        const change: MockChange = {
            range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 0 },
            },
            rangeOffset: 0,
            rangeLength: 0,
            text: 'XYZ',
        };
        store.applyDocumentChange(makeEvent(doc, [change]));
        const updated = store.get(ann.id);
        assert.ok(updated);
        assert.strictEqual(updated.startOffset, 8);
        assert.strictEqual(updated.endOffset, 14);
    });
});

suite('AnnotationStore — applyDocumentChange Cas B (edit after annotation)', () => {
    test('leaves offsets unchanged', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('abcdefghij');
        const ann = store.add(defaultDraft(), { line: 0, length: 0 }, asDoc(doc));
        const file = store.serialize();
        file.annotations[0].startOffset = 5;
        file.annotations[0].endOffset = 7;
        store.deserialize(file);

        // Replace 'j' at [9, 10) with 'J': rangeOffset=9, rangeLength=1, text='J', delta=0.
        const change: MockChange = {
            range: {
                start: { line: 0, character: 9 },
                end: { line: 0, character: 10 },
            },
            rangeOffset: 9,
            rangeLength: 1,
            text: 'J',
        };
        store.applyDocumentChange(makeEvent(doc, [change]));
        const updated = store.get(ann.id);
        assert.ok(updated);
        assert.strictEqual(updated.startOffset, 5);
        assert.strictEqual(updated.endOffset, 7);
    });
});

suite('AnnotationStore — applyDocumentChange Cas C (edit strictly inside)', () => {
    test('endOffset grows by delta, startOffset preserved', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('abcdefghij');
        const ann = store.add(defaultDraft(), { line: 0, length: 0 }, asDoc(doc));
        const file = store.serialize();
        file.annotations[0].startOffset = 5;
        file.annotations[0].endOffset = 7;
        store.deserialize(file);

        // Replace 'f' at [5, 6) (R0=5=A0, R1=6<=A1=7) with 'FF': delta=+1.
        const change: MockChange = {
            range: {
                start: { line: 0, character: 5 },
                end: { line: 0, character: 6 },
            },
            rangeOffset: 5,
            rangeLength: 1,
            text: 'FF',
        };
        store.applyDocumentChange(makeEvent(doc, [change]));
        const updated = store.get(ann.id);
        assert.ok(updated);
        assert.strictEqual(updated.startOffset, 5);
        assert.strictEqual(updated.endOffset, 8);
    });
});

suite('AnnotationStore — applyDocumentChange Cas D (overlap → suspend)', () => {
    test('boundary-crossing edit suspends the annotation, removes it from getAll()', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('abcdefghij');
        const ann = store.add(defaultDraft(), { line: 0, length: 0 }, asDoc(doc));
        const file = store.serialize();
        file.annotations[0].startOffset = 5;
        file.annotations[0].endOffset = 7;
        store.deserialize(file);

        // Replace [4, 6) — straddles A0=5 → boundary crossing → Cas D.
        const change: MockChange = {
            range: {
                start: { line: 0, character: 4 },
                end: { line: 0, character: 6 },
            },
            rangeOffset: 4,
            rangeLength: 2,
            text: 'XX',
        };
        assert.doesNotThrow(() => store.applyDocumentChange(makeEvent(doc, [change])));
        // Removed from active map but still reachable via get().
        assert.strictEqual(store.getAll().length, 0, 'no longer active');
        const fetched = store.get(ann.id);
        assert.ok(fetched, 'still reachable via get');
        assert.strictEqual(fetched.state, 'suspended');
    });

    test('full block deletion covering the annotation suspends it', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('abcdefghij');
        const ann = store.add(defaultDraft(), { line: 0, length: 0 }, asDoc(doc));
        const file = store.serialize();
        file.annotations[0].startOffset = 5;
        file.annotations[0].endOffset = 7;
        store.deserialize(file);

        // Delete [3, 9) — fully covers [5, 7).
        const change: MockChange = {
            range: {
                start: { line: 0, character: 3 },
                end: { line: 0, character: 9 },
            },
            rangeOffset: 3,
            rangeLength: 6,
            text: '',
        };
        store.applyDocumentChange(makeEvent(doc, [change]));
        const fetched = store.get(ann.id);
        assert.ok(fetched);
        assert.strictEqual(fetched.state, 'suspended');
    });

    test('emits onDidSuspend with the resume key (blockHash)', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('abcdefghij');
        const ann = store.add(defaultDraft(), { line: 0, length: 0 }, asDoc(doc));
        // Reposition to [5, 7) so a left-boundary edit unambiguously crosses A0.
        const file = store.serialize();
        file.annotations[0].startOffset = 5;
        file.annotations[0].endOffset = 7;
        store.deserialize(file);

        const events: { id: string; blockHash: string }[] = [];
        const sub = store.onDidSuspend((entry) => events.push({ id: entry.annotation.id, blockHash: entry.blockHash }));

        // Replace [3, 6) — straddles A0=5 → boundary crossing → Cas D.
        const change: MockChange = {
            range: {
                start: { line: 0, character: 3 },
                end: { line: 0, character: 6 },
            },
            rangeOffset: 3,
            rangeLength: 3,
            text: 'XX',
        };
        store.applyDocumentChange(makeEvent(doc, [change]));
        sub.dispose();
        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].id, ann.id);
        assert.strictEqual(events[0].blockHash, ann.lineHash);
    });
});

// ---------------------------------------------------------------------------
// resume / paste detection
// ---------------------------------------------------------------------------

suite('AnnotationStore — suspend / resume / getSuspendedByHash', () => {
    test('resume() restores a suspended annotation at a new offset, length preserved', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('abc\nfg\nbbb\n');
        const ann = store.add(defaultDraft(), { line: 1, length: 2 }, asDoc(doc));

        // Suspend manually (simulating a Cas D outcome).
        store.suspend(ann.id, ann.lineHash);
        assert.strictEqual(store.get(ann.id)?.state, 'suspended');

        // Resume at offset 0 in a fresh document.
        const docAfter = makeDoc('fg\nXXX\n');
        const resumed = store.resume(ann.id, asDoc(docAfter), 0);
        assert.strictEqual(resumed.state, 'active');
        assert.strictEqual(resumed.startOffset, 0);
        assert.strictEqual(resumed.endOffset, 2);
        assert.strictEqual(resumed.id, ann.id, 'same UUID after resume');
    });

    test('getSuspendedByHash returns entries indexed by blockHash', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('abc\nfg\n');
        const ann = store.add(defaultDraft(), { line: 1 }, asDoc(doc));
        store.suspend(ann.id, ann.lineHash);
        const entries = store.getSuspendedByHash(ann.lineHash);
        assert.strictEqual(entries.length, 1);
        assert.strictEqual(entries[0].annotation.id, ann.id);
        assert.strictEqual(entries[0].blockHash, ann.lineHash);
        assert.ok(entries[0].suspendOpId);
        assert.ok(entries[0].suspendedAt > 0);
    });

    test('suspend() is idempotent on an already-suspended id', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('abc\nfg\n');
        const ann = store.add(defaultDraft(), { line: 1 }, asDoc(doc));
        store.suspend(ann.id, ann.lineHash);
        assert.doesNotThrow(() => store.suspend(ann.id, ann.lineHash));
    });

    test('suspend() throws when the id is unknown to the active map', () => {
        const store = new AnnotationStore();
        assert.throws(() => store.suspend('unknown', 'hash'), /not found/);
    });

    test('resume() throws when the id is not in the suspended buffer', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('abc\n');
        assert.throws(() => store.resume('unknown', asDoc(doc), 0), /not found/);
    });
});

// ---------------------------------------------------------------------------
// Auto paste-resume / paste-clone
// ---------------------------------------------------------------------------

suite('AnnotationStore — auto paste detection', () => {
    test('cut → paste auto-resumes the SAME annotation id at the new offset', () => {
        const store = new AnnotationStore();
        const docBefore = makeDoc('abc\nfg\nbbb\n');
        const ann = store.add(defaultDraft(), { line: 1, length: 2 }, asDoc(docBefore));

        // Cut: replace [0, 7) with '' → boundary crosses [4, 6).
        const docMid = makeDoc('bbb\n');
        const cut: MockChange = {
            range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } },
            rangeOffset: 0,
            rangeLength: 7,
            text: '',
        };
        store.applyDocumentChange(makeEvent(docMid, [cut]));
        assert.strictEqual(store.get(ann.id)?.state, 'suspended');

        // Paste: insert 'abc\nfg\n' at offset 4 (after 'bbb\n').
        const docAfter = makeDoc('bbb\nabc\nfg\n');
        const paste: MockChange = {
            range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } },
            rangeOffset: 4,
            rangeLength: 0,
            text: 'abc\nfg\n',
        };
        store.applyDocumentChange(makeEvent(docAfter, [paste]));
        const restored = store.get(ann.id);
        assert.ok(restored);
        assert.strictEqual(restored.state, 'active');
        assert.strictEqual(restored.id, ann.id);
        // 'fg' starts at offset 8 in 'bbb\nabc\nfg\n'.
        assert.strictEqual(restored.startOffset, 8);
        assert.strictEqual(restored.endOffset, 10);
    });

    test('copy → paste creates a NEW annotation with origin.kind = paste', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('abc\nfg\nbbb\n');
        const original = store.add(defaultDraft(), { line: 1, length: 2 }, asDoc(doc));

        // Pure insert of 'fg\n' at end of doc — strictly after original (Cas B).
        const docAfter = makeDoc('abc\nfg\nbbb\nfg\n');
        const insert: MockChange = {
            range: { start: { line: 3, character: 0 }, end: { line: 3, character: 0 } },
            rangeOffset: 11,
            rangeLength: 0,
            text: 'fg\n',
        };
        store.applyDocumentChange(makeEvent(docAfter, [insert]));

        const all = store.getAll();
        assert.strictEqual(all.length, 2, 'original + clone');
        const clone = all.find((a) => a.id !== original.id);
        assert.ok(clone);
        assert.strictEqual(clone.origin.kind, 'paste');
        assert.ok(clone.origin.sourceOpId, 'sourceOpId references the source add op');
        assert.notStrictEqual(clone.id, original.id);
        assert.strictEqual(clone.startOffset, 11);
        assert.strictEqual(clone.endOffset, 13);
    });

    test('missed multi-line cut safety net moves a stale active source instead of cloning it', () => {
        const store = new AnnotationStore();
        const beforeCut = makeDoc('block top\nTARGET\nblock tail\npost\n');
        const original = store.add(defaultDraft(), { line: 1 }, asDoc(beforeCut));

        // Model an editor host that omitted/fragmented the deletion event:
        // the document is already cut down to "post\n", while the store
        // still considers the old source annotation active at its old offset.
        const afterPaste = makeDoc('post\nblock top\nTARGET\nblock tail\n', 'file:///test.ts', 2);
        store.applyDocumentChange(
            makeEvent(afterPaste, [
                {
                    range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } },
                    rangeOffset: 5,
                    rangeLength: 0,
                    text: 'block top\nTARGET\nblock tail\n',
                },
            ])
        );

        const all = store.getAll();
        assert.strictEqual(all.length, 1, 'stale source is moved, never duplicated');
        assert.strictEqual(all[0].id, original.id, 'move preserves annotation identity');
        assert.strictEqual(all[0].origin.kind, 'manual');
        assert.strictEqual(all[0].startOffset, 15);
        assert.strictEqual(all[0].endOffset, 21);
        assert.strictEqual(all[0].lineHash, hashLine('TARGET'));
    });

    test('copy → paste over a selection clones annotations and re-scopes destination metadata', () => {
        const store = new AnnotationStore();
        const source = makeDoc('source\nTARGET\n', 'file:///source.ts');
        const original = store.add(defaultDraft('file:///source.ts', 'source.ts'), { line: 1 }, asDoc(source));

        const destination = makeDoc('prefix\nTARGET\n', 'file:///nested/destination.ts', 2);
        const replace: MockChange = {
            range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } },
            rangeOffset: 7,
            rangeLength: 3,
            text: 'TARGET',
        };
        store.applyDocumentChange(makeEvent(destination, [replace]), 'nested/destination.ts');

        const clone = store.getAll().find((a) => a.id !== original.id);
        assert.ok(clone);
        assert.strictEqual(clone.fileUri, 'file:///nested/destination.ts');
        assert.strictEqual(clone.file, 'nested/destination.ts');
        assert.strictEqual(clone.languageId, 'typescript');
        assert.strictEqual(clone.startOffset, 7);
    });

    test('copy → paste carries every annotation co-located on the source line', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('aaa\nTARGET\nzzz\n');
        store.add({ ...defaultDraft(), message: 'first' }, { line: 1 }, asDoc(doc));
        store.add({ ...defaultDraft(), message: 'second' }, { line: 1 }, asDoc(doc));

        const after = makeDoc('aaa\nTARGET\nzzz\nTARGET\n', 'file:///test.ts', 2);
        store.applyDocumentChange(
            makeEvent(after, [
                {
                    range: { start: { line: 3, character: 0 }, end: { line: 3, character: 0 } },
                    rangeOffset: 15,
                    rangeLength: 0,
                    text: 'TARGET\n',
                },
            ])
        );

        const all = store.getAll();
        assert.strictEqual(all.length, 4, 'two originals + two co-located copies');
        assert.strictEqual(all.filter((a) => a.origin.kind === 'paste').length, 2);
        assert.deepStrictEqual(
            all.filter((a) => a.origin.kind === 'paste').map((a) => a.message).sort(),
            ['first', 'second']
        );
    });

    test('cut → cross-file paste moves every co-located annotation and updates file metadata', () => {
        const store = new AnnotationStore();
        const source = makeDoc('aaa\nTARGET\nzzz\n', 'file:///source.ts');
        const first = store.add({ ...defaultDraft('file:///source.ts', 'source.ts'), message: 'first' }, { line: 1 }, asDoc(source));
        const second = store.add({ ...defaultDraft('file:///source.ts', 'source.ts'), message: 'second' }, { line: 1 }, asDoc(source));

        const sourceAfterCut = makeDoc('aaa\nzzz\n', 'file:///source.ts', 2);
        store.applyDocumentChange(
            makeEvent(sourceAfterCut, [
                {
                    range: { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } },
                    rangeOffset: 4,
                    rangeLength: 7,
                    text: '',
                },
            ])
        );
        assert.strictEqual(store.get(first.id)?.state, 'suspended');
        assert.strictEqual(store.get(second.id)?.state, 'suspended');

        const destination = makeDoc('head\nTARGET\n', 'file:///nested/destination.ts', 2);
        store.applyDocumentChange(
            makeEvent(destination, [
                {
                    range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } },
                    rangeOffset: 5,
                    rangeLength: 0,
                    text: 'TARGET\n',
                },
            ]),
            'nested/destination.ts'
        );

        for (const id of [first.id, second.id]) {
            const moved = store.get(id);
            assert.ok(moved);
            assert.strictEqual(moved.state, 'active');
            assert.strictEqual(moved.fileUri, 'file:///nested/destination.ts');
            assert.strictEqual(moved.file, 'nested/destination.ts');
            assert.strictEqual(moved.startOffset, 5);
        }
    });

    test('FIFO precedence: oldest suspended wins when several share the hash', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('abc\nfg\n');
        const ann1 = store.add(defaultDraft(), { line: 1, length: 2 }, asDoc(doc));
        // Manually suspend with same hash for two distinct annotations.
        store.suspend(ann1.id, ann1.lineHash);
        const ann2 = store.add({
            ...defaultDraft(),
            startOffset: 0,
            endOffset: 2,
            lineHash: ann1.lineHash,
            contextBefore: [],
            contextAfter: [],
        });
        store.suspend(ann2.id, ann1.lineHash);

        const entries = store.getSuspendedByHash(ann1.lineHash);
        assert.strictEqual(entries.length, 2);

        // Paste a single 'fg' line — should resume ann1 (older).
        const docAfter = makeDoc('fg\n');
        const paste: MockChange = {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            rangeOffset: 0,
            rangeLength: 0,
            text: 'fg\n',
        };
        store.applyDocumentChange(makeEvent(docAfter, [paste]));
        assert.strictEqual(store.get(ann1.id)?.state, 'active');
        assert.strictEqual(store.get(ann2.id)?.state, 'suspended');
    });
});

// ---------------------------------------------------------------------------
// TTL sweep
// ---------------------------------------------------------------------------

suite('AnnotationStore — TTL sweep on suspended buffer', () => {
    test('expired suspended entry transitions to disposed and is unreachable', async () => {
        const store = new AnnotationStore({ suspendTtlMs: 5 });
        const doc = makeDoc('abc\nfg\n');
        const ann = store.add(defaultDraft(), { line: 1 }, asDoc(doc));
        store.suspend(ann.id, ann.lineHash);
        assert.strictEqual(store.get(ann.id)?.state, 'suspended');

        await new Promise((r) => setTimeout(r, 20));

        // Trigger sweep via an empty-changes event.
        store.applyDocumentChange(makeEvent(doc, []));
        assert.strictEqual(store.get(ann.id), undefined, 'disposed: not reachable');
        assert.strictEqual(store.getSuspendedByHash(ann.lineHash).length, 0);
    });

    test('non-expired entry survives the sweep', () => {
        const store = new AnnotationStore({ suspendTtlMs: 60_000 });
        const doc = makeDoc('abc\nfg\n');
        const ann = store.add(defaultDraft(), { line: 1 }, asDoc(doc));
        store.suspend(ann.id, ann.lineHash);
        store.applyDocumentChange(makeEvent(doc, []));
        assert.ok(store.get(ann.id), 'still reachable');
        assert.strictEqual(store.get(ann.id)?.state, 'suspended');
    });
});

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

suite('AnnotationStore — transactions (beginTransaction / commit / rollback)', () => {
    test('commit flushes pending ops to the journal with shared transactionId', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('hello\nworld');
        store.beginTransaction();
        const a1 = store.add(defaultDraft(), { line: 0 }, asDoc(doc));
        const a2 = store.add(defaultDraft(), { line: 1 }, asDoc(doc));
        // Pre-commit: journal is empty, ops are buffered in the transaction.
        assert.strictEqual(store.getJournal().entries.length, 0);
        store.commit();
        const j = store.getJournal();
        assert.strictEqual(j.entries.length, 2);
        const [t1, t2] = j.entries;
        assert.strictEqual(t1.transactionId, t2.transactionId, 'shared transactionId');
        assert.strictEqual(t1.annotationId, a1.id);
        assert.strictEqual(t2.annotationId, a2.id);
    });

    test('rollback reverts mutations and does NOT push to the journal', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('hello');
        const a0 = store.add(defaultDraft(), { line: 0 }, asDoc(doc));
        store.beginTransaction();
        store.update(a0.id, { message: 'pending' });
        const inserted = store.add(defaultDraft(), { line: 0 }, asDoc(doc));
        store.rollback();

        // Map: original message restored, freshly-added annotation gone.
        assert.strictEqual(store.get(a0.id)?.message, 'test annotation');
        assert.strictEqual(store.get(inserted.id), undefined);
        // Journal: only the pre-tx add op survives.
        assert.strictEqual(store.getJournal().entries.length, 1);
    });

    test('nested beginTransaction throws', () => {
        const store = new AnnotationStore();
        store.beginTransaction();
        assert.throws(() => store.beginTransaction(), /already inside a transaction/);
    });

    test('commit / rollback without active transaction throws', () => {
        const store = new AnnotationStore();
        assert.throws(() => store.commit(), /no active transaction/);
        assert.throws(() => store.rollback(), /no active transaction/);
    });

    test('implicit single-op mutation creates a fresh transactionId per op', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('hello\nworld');
        store.add(defaultDraft(), { line: 0 }, asDoc(doc));
        store.add(defaultDraft(), { line: 1 }, asDoc(doc));
        const j = store.getJournal();
        assert.strictEqual(j.entries.length, 2);
        assert.notStrictEqual(j.entries[0].transactionId, j.entries[1].transactionId);
    });

    test('emits onDidChange once per commit (batch), not once per inner op', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('hello\nworld');
        const batches: ReadonlyArray<OpEntry>[] = [];
        const sub = store.onDidChange((b) => batches.push(b));
        store.beginTransaction();
        store.add(defaultDraft(), { line: 0 }, asDoc(doc));
        store.add(defaultDraft(), { line: 1 }, asDoc(doc));
        assert.strictEqual(batches.length, 0, 'no event fired before commit');
        store.commit();
        sub.dispose();
        assert.strictEqual(batches.length, 1, 'exactly one batch fired at commit');
        assert.strictEqual(batches[0].length, 2);
    });
});

// ---------------------------------------------------------------------------
// Mirror undo / redo
// ---------------------------------------------------------------------------

suite('AnnotationStore — mirrorUndo / mirrorRedo', () => {
    test('add → mirrorUndo → annotation removed; mirrorRedo → restored with same id', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('hello\nworld');
        const ann = store.add(defaultDraft(), { line: 0 }, asDoc(doc));
        assert.ok(store.get(ann.id), 'sanity: present after add');

        store.mirrorUndo(doc.version, doc.uri.toString());
        assert.strictEqual(store.get(ann.id), undefined, 'undo removed');

        store.mirrorRedo(doc.version, doc.uri.toString());
        const restored = store.get(ann.id);
        assert.ok(restored, 'redo restored');
        assert.strictEqual(restored.id, ann.id, 'same UUID');
        assert.strictEqual(restored.message, ann.message);
    });

    test('remove → mirrorUndo → annotation re-emerges with original payload', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('hello');
        const ann = store.add(defaultDraft(), { line: 0 }, asDoc(doc));
        store.remove(ann.id);
        assert.strictEqual(store.get(ann.id), undefined);
        store.mirrorUndo(doc.version, doc.uri.toString());
        const restored = store.get(ann.id);
        assert.ok(restored);
        assert.strictEqual(restored.message, ann.message);
        assert.strictEqual(restored.startOffset, ann.startOffset);
        assert.strictEqual(restored.endOffset, ann.endOffset);
    });

    test('update → mirrorUndo → previous payload restored', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('hello');
        const ann = store.add(defaultDraft(), { line: 0 }, asDoc(doc));
        store.update(ann.id, { message: 'patched', pinned: true });
        assert.strictEqual(store.get(ann.id)?.message, 'patched');
        store.mirrorUndo(doc.version, doc.uri.toString());
        const restored = store.get(ann.id);
        assert.ok(restored);
        assert.strictEqual(restored.message, 'test annotation');
        assert.strictEqual(restored.pinned, undefined);
    });

    test('mirrorUndo on empty journal is a no-op', () => {
        const store = new AnnotationStore();
        assert.doesNotThrow(() => store.mirrorUndo(0, 'file:///x.ts'));
    });

    test('mirrorRedo without a prior mirrorUndo is a no-op', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('hello');
        store.add(defaultDraft(), { line: 0 }, asDoc(doc));
        const beforeJournal = store.getJournal().entries.length;
        store.mirrorRedo(doc.version, doc.uri.toString());
        assert.strictEqual(store.getJournal().entries.length, beforeJournal);
    });

    test('a transaction is undone/redone atomically (single mirrorUndo pops the whole batch)', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('hello\nworld');
        store.beginTransaction();
        const a1 = store.add(defaultDraft(), { line: 0 }, asDoc(doc));
        const a2 = store.add(defaultDraft(), { line: 1 }, asDoc(doc));
        store.commit();
        assert.strictEqual(store.getAll().length, 2);

        store.mirrorUndo(doc.version, doc.uri.toString());
        assert.strictEqual(store.get(a1.id), undefined);
        assert.strictEqual(store.get(a2.id), undefined);

        store.mirrorRedo(doc.version, doc.uri.toString());
        assert.ok(store.get(a1.id));
        assert.ok(store.get(a2.id));
    });

    test('a fresh mutation after mirrorUndo invalidates the redo stack', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('hello\nworld');
        const a1 = store.add(defaultDraft(), { line: 0 }, asDoc(doc));
        store.mirrorUndo(doc.version, doc.uri.toString());
        // New mutation: branches off, redo of a1 must no longer be reachable.
        store.add(defaultDraft(), { line: 1 }, asDoc(doc));
        store.mirrorRedo(doc.version, doc.uri.toString());
        assert.strictEqual(store.get(a1.id), undefined, 'redo is dead');
    });
});

// ---------------------------------------------------------------------------
// Cyclic capacity
// ---------------------------------------------------------------------------

suite('AnnotationStore — cyclic journal capacity', () => {
    test('appending capacity+1 ops drops the oldest', () => {
        const store = new AnnotationStore({ journalCapacity: 1024 });
        const doc = makeDoc('hello');
        const first = store.add(defaultDraft(), { line: 0 }, asDoc(doc));
        for (let i = 1; i < 1025; i++) {
            store.add(defaultDraft(), { line: 0 }, asDoc(doc));
        }
        const j = store.getJournal();
        assert.strictEqual(j.entries.length, 1024, 'capacity respected');
        assert.notStrictEqual(j.entries[0].annotationId, first.id, 'first op evicted');
    });

    test('small capacity still observes cyclic eviction', () => {
        const store = new AnnotationStore({ journalCapacity: 2 });
        const doc = makeDoc('hello');
        store.add(defaultDraft(), { line: 0 }, asDoc(doc));
        store.add(defaultDraft(), { line: 0 }, asDoc(doc));
        store.add(defaultDraft(), { line: 0 }, asDoc(doc));
        const j = store.getJournal();
        assert.strictEqual(j.entries.length, 2);
    });
});

// ---------------------------------------------------------------------------
// add raw (without document)
// ---------------------------------------------------------------------------

suite('AnnotationStore — add (raw, without document)', () => {
    test('accepts a fully pre-anchored draft', () => {
        const store = new AnnotationStore();
        const ann = store.add({
            ...defaultDraft(),
            startOffset: 0,
            endOffset: 5,
            lineHash: '5b8a91e0',
            contextBefore: ['before'],
            contextAfter: ['after'],
        });
        assert.strictEqual(ann.startOffset, 0);
        assert.strictEqual(ann.endOffset, 5);
        assert.strictEqual(ann.lineHash, '5b8a91e0');
    });

    test('rejects a raw draft with start > end', () => {
        const store = new AnnotationStore();
        assert.throws(
            () =>
                store.add({
                    ...defaultDraft(),
                    startOffset: 10,
                    endOffset: 5,
                    lineHash: '00',
                    contextBefore: [],
                    contextAfter: [],
                }),
            RangeError
        );
    });
});

// ---------------------------------------------------------------------------
// Lot 5 ergonomic surface
// ---------------------------------------------------------------------------

function rawDraft(id: string | undefined, overrides: Partial<AnnotationV2> = {}): AnnotationV2 {
    return {
        id: id ?? '00000000-0000-4000-8000-000000000000',
        schemaVersion: ANNOTATION_SCHEMA_VERSION,
        fileUri: 'file:///x.ts',
        file: 'x.ts',
        startOffset: 0,
        endOffset: 5,
        lineHash: 'a1b2c3d4',
        contextBefore: [],
        contextAfter: [],
        state: 'active',
        origin: { kind: 'manual' },
        message: 'demo',
        timestamp: '2026-05-06T12:00:00.000Z',
        ...overrides,
    };
}

suite('AnnotationStore — list / listForFile / size aliases', () => {
    test('list() mirrors getAll()', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('hello');
        store.add(defaultDraft(), { line: 0 }, asDoc(doc));
        assert.deepStrictEqual(store.list(), store.getAll());
    });

    test('listForFile() mirrors getByFile()', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('hello');
        store.add(defaultDraft(), { line: 0 }, asDoc(doc));
        assert.deepStrictEqual(store.listForFile('file:///test.ts'), store.getByFile('file:///test.ts'));
    });

    test('size() reflects the active map only', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('hello');
        const ann = store.add(defaultDraft(), { line: 0 }, asDoc(doc));
        assert.strictEqual(store.size(), 1);
        store.suspend(ann.id, ann.lineHash);
        assert.strictEqual(store.size(), 0, 'suspended is not counted in active size');
    });
});

suite('AnnotationStore — upsert', () => {
    test('add path: id unknown → creates, journals kind=upsert with inverse remove', () => {
        const store = new AnnotationStore();
        const result = store.upsert(rawDraft('11111111-1111-4111-8111-111111111111'));
        assert.strictEqual(store.size(), 1);
        const journal = store.getJournal();
        assert.strictEqual(journal.entries.length, 1);
        assert.strictEqual(journal.entries[0].kind, 'upsert');
        assert.strictEqual(journal.entries[0].before, null);
        assert.ok(journal.entries[0].after);
        assert.strictEqual(journal.entries[0].inverse.kind, 'remove');
        assert.strictEqual(result.id, '11111111-1111-4111-8111-111111111111');
    });

    test('update path: id present → replaces, journals kind=upsert with inverse update', () => {
        const store = new AnnotationStore();
        const id = '22222222-2222-4222-8222-222222222222';
        store.upsert(rawDraft(id, { message: 'first' }));
        store.upsert(rawDraft(id, { message: 'second' }));
        assert.strictEqual(store.get(id)?.message, 'second');
        const journal = store.getJournal();
        assert.strictEqual(journal.entries.length, 2);
        assert.strictEqual(journal.entries[1].kind, 'upsert');
        assert.strictEqual(journal.entries[1].before?.message, 'first');
        assert.strictEqual(journal.entries[1].after?.message, 'second');
        assert.strictEqual(journal.entries[1].inverse.kind, 'update');
    });

    test('mirrorUndo of an upsert add reverts to absence', () => {
        const store = new AnnotationStore();
        const ann = store.upsert(rawDraft('33333333-3333-4333-8333-333333333333'));
        store.mirrorUndo(0, ann.fileUri);
        assert.strictEqual(store.get(ann.id), undefined);
    });

    test('mirrorUndo of an upsert update reverts to the prior payload', () => {
        const store = new AnnotationStore();
        const id = '44444444-4444-4444-8444-444444444444';
        store.upsert(rawDraft(id, { message: 'first' }));
        store.upsert(rawDraft(id, { message: 'second', pinned: true }));
        store.mirrorUndo(0, 'file:///x.ts');
        const restored = store.get(id);
        assert.ok(restored);
        assert.strictEqual(restored.message, 'first');
        assert.strictEqual(restored.pinned, undefined);
    });

    test('rejects a draft with non-2 schemaVersion', () => {
        const store = new AnnotationStore();
        assert.throws(
            () =>
                store.upsert(
                    rawDraft('55555555-5555-4555-8555-555555555555', {
                        schemaVersion: 1 as unknown as typeof ANNOTATION_SCHEMA_VERSION,
                    })
                ),
            RangeError
        );
    });
});

suite('AnnotationStore — setAnnotationLine', () => {
    test('moves the annotation to a new line, preserving length', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('line0\nline1\nline2\nline3');
        const ann = store.add(defaultDraft(), { line: 0, length: 3 }, asDoc(doc));
        const moved = store.setAnnotationLine(ann.id, 2, asDoc(doc));
        const expectedStart = asDoc(doc).offsetAt({ line: 2, character: 0 } as never);
        assert.strictEqual(moved.startOffset, expectedStart);
        assert.strictEqual(moved.endOffset - moved.startOffset, 3, 'length preserved');
    });

    test('throws on unknown id', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('hello');
        assert.throws(() => store.setAnnotationLine('unknown', 0, asDoc(doc)), /not found/);
    });

    test('rejects negative, fractional and out-of-document target lines', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('line0\nline1');
        const ann = store.add(defaultDraft(), { line: 0 }, asDoc(doc));
        assert.throws(() => store.setAnnotationLine(ann.id, -1, asDoc(doc)), RangeError);
        assert.throws(() => store.setAnnotationLine(ann.id, 0.5, asDoc(doc)), RangeError);
        assert.throws(() => store.setAnnotationLine(ann.id, doc.lineCount, asDoc(doc)), RangeError);
    });

    test('journals an update OpEntry', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('line0\nline1');
        const ann = store.add(defaultDraft(), { line: 0, length: 2 }, asDoc(doc));
        const journalLenBefore = store.getJournal().entries.length;
        store.setAnnotationLine(ann.id, 1, asDoc(doc));
        const journal = store.getJournal();
        assert.strictEqual(journal.entries.length, journalLenBefore + 1);
        assert.strictEqual(journal.entries[journal.entries.length - 1].kind, 'update');
    });
});

suite('AnnotationStore — deliberate reanchor', () => {
    test('recaptures the exact destination line without spilling into the next line', () => {
        const store = new AnnotationStore();
        const source = makeDoc('a very long source line\nx', 'file:///source.ts');
        const destination = makeDoc('tiny\nnext line', 'file:///destination.ts', 2);
        const ann = store.add(defaultDraft('file:///source.ts', 'source.ts'), { line: 0 }, asDoc(source));

        const moved = store.reanchor(ann.id, 0, asDoc(destination), 'destination.ts');

        assert.strictEqual(moved.fileUri, 'file:///destination.ts');
        assert.strictEqual(moved.file, 'destination.ts');
        assert.strictEqual(moved.startOffset, 0);
        assert.strictEqual(moved.endOffset, 4, 'range ends with the selected line');
        assert.strictEqual(moved.lineHash, hashLine('tiny'));
        assert.strictEqual(moved.languageId, 'typescript');
    });

    test('rejects suspended annotations and invalid target lines', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('one\ntwo');
        const ann = store.add(defaultDraft(), { line: 0 }, asDoc(doc));
        assert.throws(() => store.reanchor(ann.id, 2, asDoc(doc)), RangeError);
        store.suspend(ann.id, ann.lineHash);
        assert.throws(() => store.reanchor(ann.id, 1, asDoc(doc)), /active annotation/);
    });
});

suite('AnnotationStore — populateAnchor', () => {
    test('refreshes lineHash + context against the document at startOffset', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('foo\nbar\nbaz');
        const ann = store.add(defaultDraft(), { line: 0, length: 0 }, asDoc(doc));
        // Move the annotation by hand (simulate external edit) — startOffset
        // now points to 'bar' but lineHash still reflects 'foo'.
        const file = store.serialize();
        file.annotations[0].startOffset = 4;
        file.annotations[0].endOffset = 4;
        file.annotations[0].lineHash = 'stale-hash';
        store.deserialize(file);
        const refreshed = store.populateAnchor(store.get(ann.id) as AnnotationV2, asDoc(doc));
        assert.notStrictEqual(refreshed.lineHash, 'stale-hash');
        assert.strictEqual(refreshed.lineHash, hashLine('bar'));
    });

    test('throws on unknown id', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('hello');
        assert.throws(
            () => store.populateAnchor(rawDraft('66666666-6666-4666-8666-666666666666'), asDoc(doc)),
            /not found/
        );
    });
});

suite('AnnotationStore — notifyChanged / waitUntilInitialized / dispose', () => {
    test('notifyChanged fires onDidChange with an empty batch', () => {
        const store = new AnnotationStore();
        const batches: ReadonlyArray<OpEntry>[] = [];
        const sub = store.onDidChange((b) => batches.push(b));
        store.notifyChanged();
        sub.dispose();
        assert.strictEqual(batches.length, 1);
        assert.strictEqual(batches[0].length, 0);
    });

    test('waitUntilInitialized resolves on first deserialize', async () => {
        const store = new AnnotationStore();
        let resolved = false;
        store.waitUntilInitialized().then(() => {
            resolved = true;
        });
        // Allow the synchronous chain to settle.
        await new Promise((r) => setTimeout(r, 0));
        assert.strictEqual(resolved, false, 'not resolved before deserialize');
        store.deserialize({ schemaVersion: ANNOTATION_SCHEMA_VERSION, annotations: [] });
        await store.waitUntilInitialized();
        assert.strictEqual(resolved, true);
    });

    test('markInitialized resolves the promise without deserialize', async () => {
        const store = new AnnotationStore();
        let resolved = false;
        store.waitUntilInitialized().then(() => {
            resolved = true;
        });
        store.markInitialized();
        await store.waitUntilInitialized();
        assert.strictEqual(resolved, true);
    });

    test('dispose clears state and idempotent', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('hello');
        store.add(defaultDraft(), { line: 0 }, asDoc(doc));
        store.dispose();
        assert.strictEqual(store.size(), 0);
        assert.strictEqual(store.getJournal().entries.length, 0);
        assert.doesNotThrow(() => store.dispose());
    });
});

suite('AnnotationStore — onDidDispose', () => {
    test('TTL sweep emits onDidDispose with reason ttl-expired', async () => {
        const store = new AnnotationStore({ suspendTtlMs: 5 });
        const doc = makeDoc('abc\nfg\n');
        const ann = store.add(defaultDraft(), { line: 1 }, asDoc(doc));
        store.suspend(ann.id, ann.lineHash);
        const events: { id: string; reason: string; snapshotId: string; snapshotState: string }[] = [];
        const sub = store.onDidDispose((e) =>
            events.push({
                id: e.annotationId,
                reason: e.reason,
                snapshotId: e.annotation.id,
                snapshotState: e.annotation.state,
            })
        );
        await new Promise((r) => setTimeout(r, 20));
        store.applyDocumentChange(makeEvent(doc, []));
        sub.dispose();
        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].id, ann.id);
        assert.strictEqual(events[0].reason, 'ttl-expired');
        // The event carries a full snapshot so a listener can offer recovery
        // (extension.ts re-activates it via upsert when the user keeps it).
        assert.strictEqual(events[0].snapshotId, ann.id);
        assert.strictEqual(events[0].snapshotState, 'disposed');
    });

    test('disposed annotation can be revived via upsert (keep-annotation recovery path)', async () => {
        const store = new AnnotationStore({ suspendTtlMs: 5 });
        const doc = makeDoc('abc\nfg\n');
        const ann = store.add({ ...defaultDraft(), message: 'keep me' }, { line: 1 }, asDoc(doc));
        store.suspend(ann.id, ann.lineHash);
        let snapshot: Parameters<Parameters<typeof store.onDidDispose>[0]>[0]['annotation'] | undefined;
        const sub = store.onDidDispose((e) => (snapshot = e.annotation));
        await new Promise((r) => setTimeout(r, 20));
        store.applyDocumentChange(makeEvent(doc, []));
        sub.dispose();
        assert.ok(snapshot, 'dispose event must carry the snapshot');
        assert.strictEqual(store.get(ann.id), undefined, 'annotation is gone after disposal');

        const revived = store.upsert({ ...snapshot, state: 'active' });
        assert.strictEqual(revived.id, ann.id);
        assert.strictEqual(revived.state, 'active');
        assert.strictEqual(store.get(ann.id)?.message, 'keep me');
        const validation = store.validate();
        assert.strictEqual(validation.valid, true, JSON.stringify(validation.violations));
    });
});

suite('AnnotationStore — sticky boundaries: editing the annotated line rebinds the anchor', () => {
    test('redo after undo of a paste restores the same annotation id', () => {
        const store = new AnnotationStore();
        const beforeUndo = makeDoc('aaa\nbbb\nccc\n');
        store.add({ ...defaultDraft(), message: 'original' }, { line: 0 }, asDoc(beforeUndo));
        const pasted = store.add(
            { ...defaultDraft(), message: 'pasted', origin: { kind: 'paste', sourceOpId: 'source-op' } },
            { line: 1 },
            asDoc(beforeUndo)
        );

        const afterUndo = makeDoc('aaa\nccc\n', 'file:///test.ts', 2);
        store.applyDocumentChange(
            makeEvent(
                afterUndo,
                [
                    {
                        range: { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } },
                        rangeOffset: 4,
                        rangeLength: 4,
                        text: '',
                    },
                ],
                1
            )
        );
        assert.strictEqual(store.get(pasted.id), undefined, 'undo removes the paste-derived annotation');

        // VS Code may emit a metadata-only document event (dirty/save state)
        // between the content Undo and Redo. It must not invalidate the
        // retained paste snapshot because it does not create a new edit
        // branch in the editor history.
        store.applyDocumentChange(makeEvent(afterUndo, []));

        const afterRedo = makeDoc('aaa\nbbb\nccc\n', 'file:///test.ts', 3);
        store.applyDocumentChange(
            makeEvent(
                afterRedo,
                [
                    {
                        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } },
                        rangeOffset: 4,
                        rangeLength: 0,
                        text: 'bbb\n',
                    },
                ],
                2
            )
        );

        const restored = store.get(pasted.id);
        assert.ok(restored, 'redo restores the paste-derived annotation with the same id');
        assert.strictEqual(restored.state, 'active');
        assert.strictEqual(restored.startOffset, 4);
        assert.strictEqual(restored.endOffset, 7);
    });

    test('undoing ordinary typing keeps the annotation instead of undoing its creation', () => {
        const store = new AnnotationStore();
        const doc0 = makeDoc('aaa\nbbb\nccc');
        const ann = store.add(defaultDraft(), { line: 1 }, asDoc(doc0));

        const doc1 = makeDoc('aaa\nbbbx\nccc', 'file:///test.ts', 2);
        store.applyDocumentChange(
            makeEvent(doc1, [
                {
                    range: { start: { line: 1, character: 3 }, end: { line: 1, character: 3 } },
                    rangeOffset: 7,
                    rangeLength: 0,
                    text: 'x',
                },
            ])
        );

        store.applyDocumentChange(
            makeEvent(
                doc0,
                [
                    {
                        range: { start: { line: 1, character: 3 }, end: { line: 1, character: 4 } },
                        rangeOffset: 7,
                        rangeLength: 1,
                        text: '',
                    },
                ],
                1
            )
        );

        const current = store.get(ann.id);
        assert.ok(current, 'undo must not remove the last-created annotation');
        assert.strictEqual(current.state, 'active');
        assert.strictEqual(current.startOffset, 4);
        assert.strictEqual(current.endOffset, 7);
        assert.strictEqual(current.lineHash, hashLine('bbb'));
    });

    test('two successive keystrokes at end of the annotated line keep the hash bound', () => {
        const store = new AnnotationStore();
        const doc0 = makeDoc('aaa\nbbb\nccc');
        const ann = store.add(defaultDraft(), { line: 1 }, asDoc(doc0)); // offsets [4, 7]

        // Keystroke 1: 'x' appended at EOL (offset 7 == endOffset).
        const doc1 = makeDoc('aaa\nbbbx\nccc');
        store.applyDocumentChange(
            makeEvent(doc1, [
                {
                    range: { start: { line: 1, character: 3 }, end: { line: 1, character: 3 } },
                    rangeOffset: 7,
                    rangeLength: 0,
                    text: 'x',
                },
            ])
        );
        let current = store.get(ann.id);
        assert.ok(current);
        assert.strictEqual(current.endOffset, 8, 'endOffset must extend over the appended char');
        assert.strictEqual(current.lineHash, hashLine('bbbx'), 'hash must rebind after keystroke 1');

        // Keystroke 2: 'y' appended at the NEW end (offset 8). Before the
        // sticky-boundary fix, endOffset had desynced and this keystroke was
        // "strictly after" — the hash stayed bound to the pre-edit text.
        const doc2 = makeDoc('aaa\nbbbxy\nccc');
        store.applyDocumentChange(
            makeEvent(doc2, [
                {
                    range: { start: { line: 1, character: 4 }, end: { line: 1, character: 4 } },
                    rangeOffset: 8,
                    rangeLength: 0,
                    text: 'y',
                },
            ])
        );
        current = store.get(ann.id);
        assert.ok(current);
        assert.strictEqual(current.state, 'active');
        assert.strictEqual(current.endOffset, 9);
        assert.strictEqual(current.lineHash, hashLine('bbbxy'), 'hash must rebind after keystroke 2');
    });

    test('typing at the start of the annotated line rebinds the hash (Cas A flush boundary)', () => {
        const store = new AnnotationStore();
        const doc0 = makeDoc('aaa\nbbb\nccc');
        const ann = store.add(defaultDraft(), { line: 1 }, asDoc(doc0));

        const doc1 = makeDoc('aaa\nZbbb\nccc');
        store.applyDocumentChange(
            makeEvent(doc1, [
                {
                    range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } },
                    rangeOffset: 4,
                    rangeLength: 0,
                    text: 'Z',
                },
            ])
        );
        const current = store.get(ann.id);
        assert.ok(current);
        assert.strictEqual(current.startOffset, 5, 'annotation content shifted right by the insert');
        assert.strictEqual(doc1.positionAt(current.startOffset).line, 1, 'still anchored on line 1');
        assert.strictEqual(current.lineHash, hashLine('Zbbb'), 'hash must rebind to the rewritten line');
    });

    test('typing on an annotated blank line grows the annotation and upgrades EMPTY_LINE_HASH', () => {
        const store = new AnnotationStore();
        const doc0 = makeDoc('aaa\n\nccc');
        const ann = store.add(defaultDraft(), { line: 1 }, asDoc(doc0)); // zero-length [4, 4]
        assert.strictEqual(store.get(ann.id)?.lineHash, hashLine(''));

        const doc1 = makeDoc('aaa\nh\nccc');
        store.applyDocumentChange(
            makeEvent(doc1, [
                {
                    range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } },
                    rangeOffset: 4,
                    rangeLength: 0,
                    text: 'h',
                },
            ])
        );
        const current = store.get(ann.id);
        assert.ok(current);
        assert.strictEqual(current.state, 'active');
        assert.strictEqual(current.startOffset, 4);
        assert.strictEqual(current.endOffset, 5, 'annotation must grow over the typed text');
        assert.strictEqual(current.lineHash, hashLine('h'), 'hash must upgrade from the blank-line sentinel');
    });

    test('Enter at end of the annotated line does NOT absorb the next line', () => {
        const store = new AnnotationStore();
        const doc0 = makeDoc('aaa\nbbb\nccc');
        const ann = store.add(defaultDraft(), { line: 1 }, asDoc(doc0));

        const doc1 = makeDoc('aaa\nbbb\n\nccc');
        store.applyDocumentChange(
            makeEvent(doc1, [
                {
                    range: { start: { line: 1, character: 3 }, end: { line: 1, character: 3 } },
                    rangeOffset: 7,
                    rangeLength: 0,
                    text: '\n',
                },
            ])
        );
        const current = store.get(ann.id);
        assert.ok(current);
        assert.strictEqual(current.startOffset, 4);
        assert.strictEqual(current.endOffset, 7, 'newline insert at EOL must stay outside the annotation');
        assert.strictEqual(current.lineHash, hashLine('bbb'));
    });

    test('multi-cursor edit (two changes, one event): hash binds to the correct final line', () => {
        const store = new AnnotationStore();
        const doc0 = makeDoc('aaa\nbbb\nccc\n');
        const ann = store.add(defaultDraft(), { line: 2 }, asDoc(doc0)); // 'ccc' [8, 11]

        // Single event, changes in reverse document order (VS Code contract):
        //   c1: insert 'Z' at start of 'ccc' (offset 8)
        //   c2: insert 'Q\n' at offset 0
        const docFinal = makeDoc('Q\naaa\nbbb\nZccc\n');
        store.applyDocumentChange(
            makeEvent(docFinal, [
                {
                    range: { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } },
                    rangeOffset: 8,
                    rangeLength: 0,
                    text: 'Z',
                },
                {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                    rangeOffset: 0,
                    rangeLength: 0,
                    text: 'Q\n',
                },
            ])
        );
        const current = store.get(ann.id);
        assert.ok(current);
        assert.strictEqual(docFinal.positionAt(current.startOffset).line, 3, 'annotation must land on "Zccc"');
        assert.strictEqual(
            current.lineHash,
            hashLine('Zcc' + 'c'),
            'deferred refresh must bind the hash to the final line, not a mid-event neighbour'
        );
    });
});

suite('AnnotationStore — reanchorDocument (external edits: git pull / branch switch)', () => {
    test('relocates an annotation after lines were inserted above while the file was closed', () => {
        const store = new AnnotationStore();
        const doc0 = makeDoc('function a() {}\nfunction b() {}\nconst TARGET = 42;\nfunction c() {}');
        const ann = store.add(defaultDraft(), { line: 2 }, asDoc(doc0));

        // Simulate git pull: three lines prepended outside the editor.
        const docNew = makeDoc(
            '// new header\n// more\n// even more\nfunction a() {}\nfunction b() {}\nconst TARGET = 42;\nfunction c() {}'
        );
        let changeEvents = 0;
        const sub = store.onDidChange(() => changeEvents++);
        const moved = store.reanchorDocument(asDoc(docNew));
        sub.dispose();

        assert.strictEqual(moved, 1);
        assert.strictEqual(changeEvents, 1, 'exactly one onDidChange batch for persistence/mirror');
        const current = store.get(ann.id);
        assert.ok(current);
        assert.strictEqual(docNew.positionAt(current.startOffset).line, 5, 'reanchored to the shifted TARGET line');
        assert.strictEqual(current.lineHash, hashLine('const TARGET = 42;'));
    });

    test('leaves the annotation untouched when the content cannot be found (orphan, no data loss)', () => {
        const store = new AnnotationStore();
        const doc0 = makeDoc('function a() {}\nconst TARGET = 42;\nfunction c() {}');
        const ann = store.add(defaultDraft(), { line: 1 }, asDoc(doc0));

        const docNew = makeDoc('completely\ndifferent\ncontent');
        const moved = store.reanchorDocument(asDoc(docNew));
        assert.strictEqual(moved, 0);
        const current = store.get(ann.id);
        assert.ok(current, 'annotation must survive as data even when unresolvable');
        assert.strictEqual(current.lineHash, hashLine('const TARGET = 42;'), 'stale anchor kept for later recovery');
    });
});

suite('AnnotationStore — applyFileRename', () => {
    test('patches fileUri/file of active AND suspended annotations in one batch', () => {
        const store = new AnnotationStore();
        const docA = makeDoc('aaa\nbbb\nccc', 'file:///a.ts');
        const active = store.add(defaultDraft('file:///a.ts', 'a.ts'), { line: 0 }, asDoc(docA));
        const toSuspend = store.add(defaultDraft('file:///a.ts', 'a.ts'), { line: 1 }, asDoc(docA));
        store.suspend(toSuspend.id, toSuspend.lineHash);
        const docB = makeDoc('xxx', 'file:///b.ts');
        const other = store.add(defaultDraft('file:///b.ts', 'b.ts'), { line: 0 }, asDoc(docB));

        let changeEvents = 0;
        const sub = store.onDidChange(() => changeEvents++);
        const patched = store.applyFileRename('file:///a.ts', 'file:///a2.ts', 'a2.ts');
        sub.dispose();

        assert.strictEqual(patched, 2);
        assert.strictEqual(changeEvents, 1, 'single transaction batch');
        assert.strictEqual(store.get(active.id)?.fileUri, 'file:///a2.ts');
        assert.strictEqual(store.get(active.id)?.file, 'a2.ts');
        assert.strictEqual(store.get(toSuspend.id)?.fileUri, 'file:///a2.ts', 'suspended entries must be patched too');
        assert.strictEqual(store.get(other.id)?.fileUri, 'file:///b.ts', 'unrelated files untouched');
    });

    test('returns 0 and fires nothing when no annotation references the old uri', () => {
        const store = new AnnotationStore();
        let changeEvents = 0;
        const sub = store.onDidChange(() => changeEvents++);
        assert.strictEqual(store.applyFileRename('file:///nope.ts', 'file:///new.ts'), 0);
        sub.dispose();
        assert.strictEqual(changeEvents, 0);
    });
});

suite('AnnotationStore — updateSuspendTtl', () => {
    test('a shortened TTL applies to entries already suspended', async () => {
        const store = new AnnotationStore({ suspendTtlMs: 60_000 });
        const doc = makeDoc('abc\nfg\n');
        const ann = store.add(defaultDraft(), { line: 1 }, asDoc(doc));
        store.suspend(ann.id, ann.lineHash);

        store.updateSuspendTtl(5);
        await new Promise((r) => setTimeout(r, 20));
        store.applyDocumentChange(makeEvent(doc, []));
        assert.strictEqual(store.get(ann.id), undefined, 'entry must expire under the new TTL');
    });

    test('rejects negative or non-finite values', () => {
        const store = new AnnotationStore();
        assert.throws(() => store.updateSuspendTtl(-1), RangeError);
        assert.throws(() => store.updateSuspendTtl(Number.NaN), RangeError);
    });
});

suite('AnnotationStore — cloneAsPaste deep-clones business fields', () => {
    test('mutating the clone thread does not affect the source', () => {
        const store = new AnnotationStore();
        const doc = makeDoc('abc\nfg\nbbb\n');
        const original = store.add(
            {
                ...defaultDraft(),
                thread: [
                    {
                        id: 'c1',
                        message: 'initial',
                        timestamp: '2026-05-06T12:00:00.000Z',
                    },
                ],
                tags: ['T'],
            },
            { line: 1, length: 2 },
            asDoc(doc)
        );

        // Trigger a copy/paste clone via applyDocumentChange (insert 'fg' below).
        const docAfter = makeDoc('abc\nfg\nbbb\nfg\n');
        const insert: MockChange = {
            range: { start: { line: 3, character: 0 }, end: { line: 3, character: 0 } },
            rangeOffset: 11,
            rangeLength: 0,
            text: 'fg\n',
        };
        store.applyDocumentChange(makeEvent(docAfter, [insert]));

        const all = store.getAll();
        const clone = all.find((a) => a.id !== original.id);
        assert.ok(clone);
        // Mutate the clone's thread (clone is frozen → use store.update to inject mutation).
        store.update(clone.id, {
            thread: [...(clone.thread ?? []), { id: 'c2', message: 'mutated', timestamp: '2026-05-06T12:00:01.000Z' }],
        });
        const mutatedClone = store.get(clone.id);
        assert.strictEqual(mutatedClone?.thread?.length, 2);
        // The ORIGINAL must remain at 1 entry — no shared reference leak.
        const originalNow = store.get(original.id);
        assert.strictEqual(originalNow?.thread?.length, 1);
    });
});
