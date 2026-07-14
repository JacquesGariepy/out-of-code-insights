// SPDX-License-Identifier: MPL-2.0

export interface GitHubRepositoryCoordinates {
    owner: string;
    repository: string;
    fullName: string;
}

/**
 * Parse the canonical owner/repository form accepted by GitHub's REST API.
 * URLs and shorthand are deliberately rejected so the confirmation dialog
 * always shows the exact destination that will receive the issue.
 */
export function parseGitHubRepository(value: string): GitHubRepositoryCoordinates | undefined {
    const normalized = value.trim();
    const segments = normalized.split('/');
    if (segments.length !== 2) {
        return undefined;
    }

    const [owner, repository] = segments;
    const validOwner = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner);
    const validRepository =
        repository.length > 0 &&
        repository.length <= 100 &&
        repository !== '.' &&
        repository !== '..' &&
        /^[A-Za-z0-9._-]+$/.test(repository);
    if (!validOwner || !validRepository) {
        return undefined;
    }

    return {
        owner,
        repository,
        fullName: `${owner}/${repository}`,
    };
}

export function validateGitHubRepository(value: string): string | undefined {
    return parseGitHubRepository(value)
        ? undefined
        : 'Enter a repository as owner/repository (for example, octocat/hello-world).';
}
