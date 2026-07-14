// SPDX-License-Identifier: MPL-2.0
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { parseGitHubRepository, validateGitHubRepository } from '../../../common/githubRepository';

suite('GitHub development issue workflow', () => {
    test('validates and normalizes owner/repository without network access', () => {
        assert.deepStrictEqual(parseGitHubRepository('  octocat/hello-world  '), {
            owner: 'octocat',
            repository: 'hello-world',
            fullName: 'octocat/hello-world',
        });
        assert.deepStrictEqual(parseGitHubRepository('OpenAI/.github'), {
            owner: 'OpenAI',
            repository: '.github',
            fullName: 'OpenAI/.github',
        });

        for (const invalid of ['', 'owner', 'owner/repo/extra', '-owner/repo', 'owner-/repo', 'owner/repo name']) {
            assert.strictEqual(parseGitHubRepository(invalid), undefined, `${invalid} must be rejected`);
            assert.match(validateGitHubRepository(invalid) ?? '', /owner\/repository/);
        }
        assert.strictEqual(validateGitHubRepository('owner/repository'), undefined);
    });

    test('uses VS Code GitHub authentication only after explicit confirmation and never prompts for a PAT', () => {
        const managerPath = path.resolve(__dirname, '../../../../src/managers/AnnotationManager.ts');
        const source = fs.readFileSync(managerPath, 'utf8');
        const start = source.indexOf('public async createDevelopmentIssue');
        const end = source.indexOf('public async addAnnotation', start);
        const workflow = source.slice(start, end);

        assert.ok(start >= 0 && end > start, 'the guided public issue workflow must exist');
        assert.ok(workflow.includes('annotationForGuidedCommand('), 'TreeItem, id and picker selection must be guided');
        assert.ok(
            workflow.includes('vscode.ConfigurationTarget.Workspace'),
            'repository choice must persist per workspace'
        );
        assert.ok(workflow.includes("vscode.authentication.getSession('github', ['repo'], { createIfNone: true })"));
        assert.ok(workflow.includes("import('@octokit/rest')"));
        assert.ok(
            workflow.includes('this.canonicalStore.update(annotationId, {'),
            'the created issue URL must be traced on the authoritative annotation'
        );
        assert.ok(
            workflow.includes('sourceDocument.positionAt(currentAnnotation.startOffset).line'),
            'the issue must resolve the current line from the canonical offset'
        );
        assert.ok(
            workflow.indexOf('showWarningMessage(') < workflow.indexOf('authentication.getSession('),
            'external authentication and issue creation must follow modal confirmation'
        );
        assert.ok(
            workflow.indexOf('showWarningMessage(') < workflow.indexOf("configuration.update('github.repository'"),
            'cancelling before confirmation must not mutate workspace settings'
        );
        assert.doesNotMatch(workflow, /personal access token|annotation\.github\.token|context\.secrets/i);
    });
});
