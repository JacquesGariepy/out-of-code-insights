# Releasing Out-of-Code Insights

This document is the authoritative reference for publishing a new version of the
extension to the VS Code Marketplace and Open VSX Registry.

For a quick reference, see [CHECKLISTS.md](./CHECKLISTS.md).

---

## Overview

Releases are driven by git tags. Pushing a tag matching `v*.*.*` triggers the
`release.yml` GitHub Actions workflow, which:

1. Installs dependencies (`npm ci`).
2. Runs security audit, typecheck, and lint.
3. Packages the VSIX (`npm run package:vsix`).
4. Publishes to the VS Code Marketplace via `vsce`.
5. Publishes to Open VSX via `ovsx`.
6. Creates a GitHub Release with the VSIX as an attached asset.

No manual upload is ever required.

---

## Versioning

This project follows [Semantic Versioning 2.0.0](https://semver.org/):

| Change type | Version segment | Example |
|---|---|---|
| Bug fix, doc update, dependency patch | Patch: `x.y.Z+1` | `1.0.18` to `1.0.19` |
| New backward-compatible feature | Minor: `x.Y+1.0` | `1.0.18` to `1.1.0` |
| Breaking API or behavior change | Major: `X+1.0.0` | `1.0.18` to `2.0.0` |

---

## Step-by-Step Release Procedure

### 1. Verify the working tree is clean

```bash
git status          # must show nothing to commit
git pull origin main
```

### 2. Bump the version

Edit `package.json` field `"version"` to the new semver string.

```bash
# Example: patch bump
# Change "1.0.18" to "1.0.19" in package.json
```

### 3. Update CHANGELOG.md

Move items from `## [Unreleased]` into a new dated section:

```markdown
## [1.0.19] - YYYY-MM-DD

### Added
- ...

### Fixed
- ...
```

Leave `## [Unreleased]` with `(no entries yet)` for the next cycle.

### 4. Commit the release

```bash
git add package.json CHANGELOG.md
git commit -m "chore: release v1.0.19"
```

### 5. Push to main

```bash
git push origin main
```

### 6. Wait for CI

Open the Actions tab on GitHub and confirm the `CI` workflow passes on the
`main` branch push before tagging.

### 7. Create and push the tag

```bash
git tag -a v1.0.19 -m "Release v1.0.19"
git push origin v1.0.19
```

### 8. Monitor the release workflow

Open `https://github.com/JacquesGariepy/out-of-code-insights/actions` and
watch the `Release` workflow triggered by the tag push.

Steps to confirm:
- Security audit passes.
- VSIX is built and attached to the GitHub Release.
- VS Code Marketplace publish step exits 0.
- Open VSX publish step exits 0.
- GitHub Release is created with `--generate-notes`.

### 9. Verify publication

- **VS Code Marketplace:** `https://marketplace.visualstudio.com/items?itemName=jacquesgariepy.out-of-code-insights`
  -- new version should appear within 5-10 minutes.
- **Open VSX:** `https://open-vsx.org/extension/jacquesgariepy/out-of-code-insights`
  -- propagation can take up to 15 minutes.

### 10. Post-release

- Install the published extension in a clean VS Code instance and smoke-test
  the core annotation flow (add, edit, delete, reload).
- Monitor the GitHub Issues tracker for regressions over the next 24 hours.
- Optionally announce in the repository Discussions or social channels.

---

## Hotfix Procedure

Use this flow for urgent production fixes that cannot wait for the next planned
release.

```bash
# Branch from the tagged release
git checkout -b hotfix/v1.0.19 v1.0.18

# Apply the fix, then:
git add <files>
git commit -m "fix: <description>"

# Bump patch version and update CHANGELOG, then:
git commit -m "chore: release v1.0.19"

# Merge back into main
git checkout main
git merge hotfix/v1.0.19

# Tag and push
git tag -a v1.0.19 -m "Release v1.0.19"
git push origin main
git push origin v1.0.19

# Clean up
git branch -d hotfix/v1.0.19
```

---

## Recovery Procedures

### Wrong version pushed

If the tag was pushed but the workflow failed partway through (e.g., wrong
VSCE_PAT):

1. Fix the secret in `Settings -> Secrets and variables -> Actions`.
2. Delete the failed tag locally and remotely:
   ```bash
   git tag -d v1.0.19
   git push origin :refs/tags/v1.0.19
   ```
3. Re-create and push the tag.

### Published with a bug

The Marketplace does not allow un-publishing a specific version. The correct
action is to release a patch version (`1.0.20`) immediately.

### Marketplace 401 / Authentication error

Verify `VSCE_PAT` has not expired and has the `Marketplace (Manage)` scope.
Rotate via `https://marketplace.visualstudio.com/manage/publishers/jacquesgariepy`.
Update the GitHub secret, then re-tag (see "Wrong version pushed" above).

---

## Required Secrets

Both secrets must be configured in
`Settings -> Secrets and variables -> Actions` on the GitHub repository before
any release tag is pushed.

| Secret | Source | Scope required |
|---|---|---|
| `VSCE_PAT` | `https://marketplace.visualstudio.com/manage/publishers/jacquesgariepy` | Marketplace (Manage) |
| `OVSX_TOKEN` | `https://open-vsx.org/user-settings/tokens` | Any non-expired token |

`GITHUB_TOKEN` is provided automatically by GitHub Actions and requires no
manual configuration.

### Rotating secrets

1. Generate a new token at the source URL listed above.
2. In GitHub: `Settings -> Secrets and variables -> Actions -> <secret name> -> Update`.
3. Paste the new value. The old value is immediately replaced.
4. Confirm by triggering a test release (or use the Actions "Re-run jobs"
   on the last release workflow).

---

## Local VSIX Packaging (manual testing)

To build and install the extension locally without publishing:

```bash
npm run package:vsix        # produces out-of-code-insights-x.y.z.vsix
code --install-extension out-of-code-insights-*.vsix
```

Delete the `.vsix` file before committing; it is covered by `.gitignore`.

---

*See also: [CHECKLISTS.md](./CHECKLISTS.md) for quick-reference checklists.*
