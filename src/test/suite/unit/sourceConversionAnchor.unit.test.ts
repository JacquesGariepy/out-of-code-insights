import * as assert from 'assert';
import {
    chooseConversionAnnotationLine,
    chooseConvertedAnnotationLine,
    type SourceCommentRangeLike,
} from '../../../comments/sourceConversionAnchor';

function range(
    startLine: number,
    startCharacter: number,
    endLine: number,
    endCharacter: number
): SourceCommentRangeLike {
    return { startLine, startCharacter, endLine, endCharacter };
}

suite('Source conversion annotation anchor', () => {
    test('keeps the comment-line anchor when the source is retained for rerun deduplication', () => {
        const comment = range(1, 0, 1, 10);
        const source = ['before();', '// details', 'after();'].join('\n');
        assert.strictEqual(chooseConversionAnnotationLine(source, comment, [comment], 'keep'), 1);
        assert.strictEqual(chooseConversionAnnotationLine(source, comment, [comment], 'remove'), 2);
    });

    test('keeps a trailing inline comment on its code line', () => {
        const source = 'const answer = 42; // explanation';
        const comment = range(0, source.indexOf('//'), 0, source.length);
        assert.strictEqual(chooseConvertedAnnotationLine(source, comment, [comment]), 0);
    });

    test('anchors a standalone comment to the following code line', () => {
        const comment = range(1, 4, 1, 18);
        const source = ['import x from "x";', '    // explanation', '', '    run(x);'].join('\n');
        assert.strictEqual(chooseConvertedAnnotationLine(source, comment, [comment]), 3);
    });

    test('skips other comments while looking for the following code line', () => {
        const first = range(0, 0, 0, 9);
        const second = range(1, 0, 2, 3);
        const source = ['// header', '/* more', ' */', 'start();'].join('\n');
        assert.strictEqual(chooseConvertedAnnotationLine(source, first, [first, second]), 3);
    });

    test('uses the preceding code line for a standalone end-of-file comment', () => {
        const comment = range(2, 0, 2, 11);
        const source = ['setup();', '', '// details'].join('\n');
        assert.strictEqual(chooseConvertedAnnotationLine(source, comment, [comment]), 0);
    });

    test('uses trailing code on the closing line of a multiline block', () => {
        const comment = range(0, 0, 1, 3);
        const source = ['/* details', ' */ execute();'].join('\n');
        assert.strictEqual(chooseConvertedAnnotationLine(source, comment, [comment]), 1);
    });

    test('falls back deterministically when the file contains only a comment', () => {
        const comment = range(0, 0, 0, 7);
        assert.strictEqual(chooseConvertedAnnotationLine('// only', comment, [comment]), 0);
    });
});
