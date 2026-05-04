## Description

A clear and concise description of the changes and their motivation.

Fixes # <!-- link to related issue, e.g. Fixes #42 -->

## Type of Change

- [ ] Bug fix (non-breaking, resolves an issue)
- [ ] New feature (non-breaking, adds functionality)
- [ ] Breaking change (existing functionality changes incompatibly)
- [ ] Documentation update
- [ ] Refactor (internal change, no behavior change)
- [ ] Chore (dependency update, tooling, CI)

## Related Issue

Closes #

## Commit Message Format

This PR follows [Conventional Commits](https://www.conventionalcommits.org/).
The squash / merge commit should read:

```
<type>(<scope>): <imperative summary>

Closes #<issue>
```

Examples: `feat(kanban): add CSV export`, `fix(annotation): prevent empty-message save`

## Testing

How were the changes tested?

- [ ] Launched Extension Development Host (F5) and verified manually
- Steps followed:
  1.
  2.
- Results observed:

## Checklist

- [ ] Tests added or updated (or justified why not)
- [ ] `CHANGELOG.md` updated under `[Unreleased]` if the change is user-visible
- [ ] No `console.log` statements left in production code
- [ ] `npm run check` passes (typecheck + lint + format)
- [ ] `npm test` passes
- [ ] Self-review completed
- [ ] New source files include the MPL-2.0 SPDX header
