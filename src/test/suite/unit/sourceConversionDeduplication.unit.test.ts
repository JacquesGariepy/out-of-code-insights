import * as assert from 'assert';
import {
    unrepresentedSourceCommentRecords,
    type ExistingSourceCommentAnnotation,
    type SourceCommentCandidateRecord,
} from '../../../comments/sourceConversionDeduplication';
import { scanSourceComments, sourceCommentImportTags } from '../../../comments/sourceCommentCodec';

interface RecordValue {
    readonly id: string;
}

function record(id: string, importTag: string | undefined): SourceCommentCandidateRecord<RecordValue> {
    return {
        value: { id },
        importTag,
        annotationIdFragment: undefined,
        annotationIdFingerprint: undefined,
        startLine: 0,
        endLine: 0,
        message: 'note',
    };
}

function annotation(tags: readonly string[] = []): ExistingSourceCommentAnnotation {
    return {
        idFragment: '',
        idFingerprint: '',
        line: 0,
        message: 'note',
        tags: new Set(tags),
    };
}

suite('Source conversion comment deduplication', () => {
    test('one exact import tag cannot hide a second identical comment on the same line', () => {
        const source = 'const x = 1; /* note */ // note';
        const scanned = scanSourceComments(source, 'typescript');
        const tags = sourceCommentImportTags('file:///repo/example.ts', 'typescript', source, scanned);
        const records = scanned.map((value, index) => ({
            value,
            importTag: tags[index],
            annotationIdFragment: value.annotationIdFragment,
            annotationIdFingerprint: value.annotationIdFingerprint,
            startLine: value.startLine,
            endLine: value.endLine,
            message: value.text,
        }));

        const candidates = unrepresentedSourceCommentRecords(records, [annotation([tags[0]])]);
        assert.strictEqual(candidates.length, 1);
        assert.strictEqual(candidates[0].syntaxKind, 'line');
        assert.strictEqual(candidates[0].startCharacter, source.lastIndexOf('//'));
    });

    test('legacy line/message fallback consumes only one equal comment', () => {
        const records = [record('first', undefined), record('second', undefined)];
        const candidates = unrepresentedSourceCommentRecords(records, [annotation()]);
        assert.deepStrictEqual(candidates, [{ id: 'second' }]);
    });

    test('reserves exact provenance before applying the legacy fallback', () => {
        const records = [record('legacy', undefined), record('tagged', 'source-import:tagged')];
        const candidates = unrepresentedSourceCommentRecords(records, [
            annotation(['source-import:tagged']),
            annotation(),
        ]);
        assert.deepStrictEqual(candidates, []);
    });

    test('generated identity matches are also one-to-one', () => {
        const records: SourceCommentCandidateRecord<RecordValue>[] = [
            { ...record('first', undefined), annotationIdFragment: 'abc123', message: 'first' },
            { ...record('second', undefined), annotationIdFragment: 'abc123', message: 'second' },
        ];
        const existing: ExistingSourceCommentAnnotation[] = [
            { ...annotation(), idFragment: 'abc123', message: 'first' },
        ];
        assert.deepStrictEqual(unrepresentedSourceCommentRecords(records, existing), [{ id: 'second' }]);
    });

    test('reserves an exact fingerprint before legacy fragments and never downgrades a strong marker', () => {
        const records: SourceCommentCandidateRecord<RecordValue>[] = [
            {
                ...record('strong-second', undefined),
                annotationIdFragment: 'shared',
                annotationIdFingerprint: 'fingerprint-second',
            },
            { ...record('legacy-first', undefined), annotationIdFragment: 'shared' },
            {
                ...record('tampered', undefined),
                annotationIdFragment: 'shared',
                annotationIdFingerprint: 'not-present',
            },
        ];
        const existing: ExistingSourceCommentAnnotation[] = [
            { ...annotation(), idFragment: 'shared', idFingerprint: 'fingerprint-first' },
            { ...annotation(), idFragment: 'shared', idFingerprint: 'fingerprint-second' },
        ];

        assert.deepStrictEqual(unrepresentedSourceCommentRecords(records, existing), [{ id: 'tampered' }]);
    });
});
