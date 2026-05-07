# Contributing to Out-of-Code Insights

Thank you for your interest in contributing. This document covers the
development setup, commit style, branch conventions, testing, and pull request
process.

## Getting Started

1. **Fork** the repository on GitHub and clone your fork:

    ```bash
    git clone https://github.com/<your-username>/out-of-code-insights.git
    cd out-of-code-insights
    ```

2. **Install dependencies:**

    ```bash
    npm install
    ```

3. **Launch the extension in development mode:**
   Open the project folder in VS Code, then press **F5**. This opens a new
   VS Code window (the Extension Development Host) with the extension loaded
   from source. Breakpoints set in `src/` will be hit in the host window.

    For a step-by-step walkthrough, see [docs/onboarding.md](./docs/onboarding.md).

## Building

Compile TypeScript sources to `out/`:

```bash
npm run compile
```

Watch mode during development:

```bash
npm run watch:tsc      # TypeScript type-check pass
npm run watch:webpack  # Webpack bundle
npm run dev            # Both in parallel
```

Full production build:

```bash
npm run package
```

Package as a `.vsix` file:

```bash
npm run package:vsix
```

## Testing

```bash
npm test
```

> **Note:** A comprehensive test suite is a tracked backlog item. Until it is
> complete, verify your changes manually in the Extension Development Host (F5)
> by exercising the affected feature paths. Document the steps you followed in
> your pull request.

## Code Style

Run all checks before submitting a PR:

```bash
npm run check    # typecheck + lint + format:check
```

Individual commands:

```bash
npm run lint         # ESLint
npm run lint:fix     # Auto-fix
npm run format       # Prettier
npm run typecheck    # tsc --noEmit
```

Rules of thumb:

- ESLint must pass with zero errors before a PR can be merged.
- No `console.log` in production code; use the VS Code output channel.
- Prefer `const` over `let`; avoid `var`.
- Use explicit TypeScript types; avoid `any` where a proper type exists.
- Keep functions focused; split large functions into named helpers.

## Commit Messages

This project follows [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<optional-scope>): <imperative-mood summary>

[optional body]
[optional footer: Refs #issue-number]
```

**Types:** `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`

**Examples:**

```
feat(kanban): add CSV export for filtered board view
fix(annotation): prevent empty-message save on inline edit
docs(contributing): add commit message convention section
chore(deps): upgrade @anthropic-ai/claude-code to 2.1.126
```

Rules:

- Summary line: imperative mood, no period at the end, max 72 characters.
- Reference issues with `Refs #NNN` or `Closes #NNN` in the footer.
- One logical change per commit; squash noise commits before opening a PR.

## Branch Naming

```
feat/<short-description>        new feature
fix/<short-description>         bug fix
docs/<short-description>        documentation only
refactor/<short-description>    internal restructure, no behavior change
ci/<short-description>          CI/CD pipeline changes
chore/<short-description>       maintenance (deps, tooling)
```

## Pull Request Process

1. Create a branch from `main` using the naming convention above.

2. Make focused, atomic commits following the commit message format.

3. If your change is user-visible, update `CHANGELOG.md` under `[Unreleased]`
   using [Keep a Changelog 1.1](https://keepachangelog.com/en/1.1.0/) format.

4. Open a pull request against `main` and fill in the PR template.

5. Ensure `npm run check` and `npm test` both pass locally before requesting
   review.

6. A maintainer will review within a reasonable time. Respond to review
   comments promptly.

## License of Contributions

By submitting a pull request you agree that your contributions will be licensed
under **MPL-2.0**. MPL-2.0 requires that modifications to existing source files
remain available under MPL-2.0; new files may be added under a compatible
open-source license. No Contributor License Agreement (CLA) is required.

## Reporting Bugs

- **Security vulnerabilities:** see [SECURITY.md](./SECURITY.md) for private
  disclosure. Do not open a public issue.
- **Other bugs:** open a [GitHub Issue](https://github.com/JacquesGariepy/out-of-code-insights/issues)
  using the bug report template.

## Good First Issues

Looking for a place to start? Browse issues labeled
[`good-first-issue`](https://github.com/JacquesGariepy/out-of-code-insights/labels/good-first-issue).
Issues labeled `help wanted` are also suitable for first-time contributors.

## Releasing

Maintainers only. The full release procedure, hotfix flow, and recovery steps
are documented in [docs/RELEASING.md](./docs/RELEASING.md).

Quick-reference checklists (pre-commit, pre-push, pre-release, post-release)
are in [docs/CHECKLISTS.md](./docs/CHECKLISTS.md).

In brief: bump `package.json` version, update `CHANGELOG.md`, commit with
`chore: release vX.Y.Z`, push to `main`, wait for CI, then push a `vX.Y.Z`
annotated tag. The `release.yml` workflow handles VSIX packaging and
Marketplace publication automatically.

## Local Annotation Data

`.out-of-code-insights/annotations.json` stores your personal annotations
locally and is excluded from version control by `.gitignore`. Do not commit
this file. If it appears as untracked, verify:

```bash
git check-ignore -v .out-of-code-insights/
```
