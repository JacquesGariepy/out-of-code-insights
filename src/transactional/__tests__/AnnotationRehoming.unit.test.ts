// SPDX-License-Identifier: MPL-2.0
import * as assert from 'assert';
import { rehomeAnnotationsPayload, sanitizeRelativeAnnotationPath, type RehomingTarget } from '../AnnotationRehoming';
import { ANNOTATION_SCHEMA_VERSION, type AnnotationStoreFileV2, type AnnotationV2 } from '../types';

const LOCAL_WORKSPACE = 'file:///c%3A/work/project';

function makeTarget(workspaceUri = LOCAL_WORKSPACE): RehomingTarget {
    return {
        workspaceUri,
        // Mirrors vscode.Uri.joinPath(folder.uri, ...segments).toString() for
        // the simple paths used in these tests.
        toUriString: (relativePath) => `${workspaceUri}/${relativePath}`,
    };
}

function makeAnnotation(id: string, fileUri: string, file: string): AnnotationV2 {
    return {
        id,
        schemaVersion: ANNOTATION_SCHEMA_VERSION,
        fileUri,
        file,
        startOffset: 0,
        endOffset: 5,
        lineHash: '5b8a91e0',
        contextBefore: [],
        contextAfter: [],
        state: 'active',
        origin: { kind: 'manual' },
        message: 'shared note',
        timestamp: '2026-05-06T12:00:00.000Z',
    };
}

function envelope(...annotations: AnnotationV2[]): AnnotationStoreFileV2 {
    return { schemaVersion: ANNOTATION_SCHEMA_VERSION, annotations };
}

suite('AnnotationRehoming — sanitizeRelativeAnnotationPath', () => {
    test('normalizes separators and drops empty/dot segments', () => {
        assert.strictEqual(sanitizeRelativeAnnotationPath('src\\utils\\helper.ts'), 'src/utils/helper.ts');
        assert.strictEqual(sanitizeRelativeAnnotationPath('./src//x.ts'), 'src/x.ts');
        assert.strictEqual(sanitizeRelativeAnnotationPath('  src/x.ts  '), 'src/x.ts');
    });

    test('rejects absolute, UNC, drive-qualified, traversal, and empty paths', () => {
        assert.strictEqual(sanitizeRelativeAnnotationPath('/etc/passwd'), undefined);
        assert.strictEqual(sanitizeRelativeAnnotationPath('C:\\other\\project\\x.ts'), undefined);
        assert.strictEqual(sanitizeRelativeAnnotationPath('\\\\host\\share\\x.ts'), undefined);
        assert.strictEqual(sanitizeRelativeAnnotationPath('../outside.ts'), undefined);
        assert.strictEqual(sanitizeRelativeAnnotationPath('safe/../../outside.ts'), undefined);
        assert.strictEqual(sanitizeRelativeAnnotationPath(''), undefined);
        assert.strictEqual(sanitizeRelativeAnnotationPath('   '), undefined);
        assert.strictEqual(sanitizeRelativeAnnotationPath(undefined), undefined);
    });
});

suite('AnnotationRehoming — rehomeAnnotationsPayload', () => {
    test("rebases a teammate's Windows URI onto the current workspace (issue: shared annotations.json via Git)", () => {
        const foreign = makeAnnotation('a1', 'file:///c%3A/Users/dev1/repos/project/src/app.ts', 'src/app.ts');
        const result = rehomeAnnotationsPayload(envelope(foreign), makeTarget());

        assert.strictEqual(result.rehomedCount, 1);
        assert.strictEqual(result.payload.annotations[0].fileUri, `${LOCAL_WORKSPACE}/src/app.ts`);
        assert.strictEqual(result.payload.annotations[0].file, 'src/app.ts');
        assert.strictEqual(result.payload.annotations[0].message, 'shared note', 'other fields carry over');
    });

    test('rebases a POSIX URI onto a Windows workspace and vice versa', () => {
        const fromMac = makeAnnotation('a1', 'file:///Users/dev2/project/src/app.ts', 'src/app.ts');
        const ontoWindows = rehomeAnnotationsPayload(envelope(fromMac), makeTarget());
        assert.strictEqual(ontoWindows.payload.annotations[0].fileUri, `${LOCAL_WORKSPACE}/src/app.ts`);

        const fromWindows = makeAnnotation('a2', 'file:///c%3A/work/project/src/app.ts', 'src\\app.ts');
        const ontoPosix = rehomeAnnotationsPayload(envelope(fromWindows), makeTarget('file:///home/dev3/project'));
        assert.strictEqual(ontoPosix.rehomedCount, 1);
        assert.strictEqual(ontoPosix.payload.annotations[0].fileUri, 'file:///home/dev3/project/src/app.ts');
        assert.strictEqual(ontoPosix.payload.annotations[0].file, 'src/app.ts', 'backslashes normalized');
    });

    test('leaves annotations already scoped to the workspace untouched (same payload instance when nothing changes)', () => {
        const local = makeAnnotation('a1', `${LOCAL_WORKSPACE}/src/app.ts`, 'src/app.ts');
        const payload = envelope(local);
        const result = rehomeAnnotationsPayload(payload, makeTarget());

        assert.strictEqual(result.rehomedCount, 0);
        assert.strictEqual(result.payload, payload, 'no-op pass returns the input payload');
        assert.strictEqual(result.payload.annotations[0], local);
    });

    test('does not treat a sibling workspace with a shared prefix as local', () => {
        const sibling = makeAnnotation('a1', `${LOCAL_WORKSPACE}-copy/src/app.ts`, 'src/app.ts');
        const result = rehomeAnnotationsPayload(envelope(sibling), makeTarget());

        assert.strictEqual(result.rehomedCount, 1, 'project-copy is a different folder, not this workspace');
        assert.strictEqual(result.payload.annotations[0].fileUri, `${LOCAL_WORKSPACE}/src/app.ts`);
    });

    test('preserves a foreign annotation whose relative path is unusable instead of dropping it', () => {
        const traversal = makeAnnotation('a1', 'file:///c%3A/Users/dev1/project/src/app.ts', '../../outside.ts');
        const absolute = makeAnnotation('a2', 'file:///c%3A/Users/dev1/project/src/app.ts', 'C:\\Users\\dev1\\x.ts');
        const result = rehomeAnnotationsPayload(envelope(traversal, absolute), makeTarget());

        assert.strictEqual(result.rehomedCount, 0);
        assert.strictEqual(result.payload.annotations[0].fileUri, traversal.fileUri, 'traversal path is refused');
        assert.strictEqual(result.payload.annotations[1].fileUri, absolute.fileUri, 'absolute path is refused');
    });

    test('mixed envelope: rebases only the foreign entries and never mutates the input', () => {
        const local = makeAnnotation('a1', `${LOCAL_WORKSPACE}/src/local.ts`, 'src/local.ts');
        const foreign = makeAnnotation('a2', 'file:///home/dev2/project/src/shared.ts', 'src/shared.ts');
        const payload = envelope(local, foreign);
        const result = rehomeAnnotationsPayload(payload, makeTarget());

        assert.strictEqual(result.rehomedCount, 1);
        assert.notStrictEqual(result.payload, payload);
        assert.strictEqual(result.payload.schemaVersion, ANNOTATION_SCHEMA_VERSION);
        assert.strictEqual(result.payload.annotations[0], local, 'local entry passes through by reference');
        assert.strictEqual(result.payload.annotations[1].fileUri, `${LOCAL_WORKSPACE}/src/shared.ts`);
        assert.strictEqual(payload.annotations[1].fileUri, 'file:///home/dev2/project/src/shared.ts', 'input intact');
    });

    test('rehomes annotations from a remote workspace scheme onto the local folder', () => {
        const remote = makeAnnotation(
            'a1',
            'vscode-remote://ssh-remote%2Bbuild/home/ci/project/src/app.ts',
            'src/app.ts'
        );
        const result = rehomeAnnotationsPayload(envelope(remote), makeTarget());

        assert.strictEqual(result.rehomedCount, 1);
        assert.strictEqual(result.payload.annotations[0].fileUri, `${LOCAL_WORKSPACE}/src/app.ts`);
    });
});
