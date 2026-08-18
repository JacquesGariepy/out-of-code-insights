# 1.4.6 — Multi-root workspace support and Dependabot consolidation

Release date: 2026-08-18.

## Outcome

Version 1.4.6 fixes navigation in multi-root (`.code-workspace`) setups when annotations belong to secondary workspace folders, and updates dependency automation rules to reduce PR noise.

## Multi-root workspace navigation and rehoming preservation

Reported in [issue #100](https://github.com/JacquesGariepy/out-of-code-insights/issues/100):
In multi-folder workspaces (`.code-workspace`), reopening the workspace caused **Navigate** to fail with `cannot open file … Unable to resolve nonexistent file` on annotations located in secondary workspace folders.

### Root cause & Fix

1. The rehoming pass introduced in 1.4.5 only considered the primary folder (`workspaceFolders[0]`) as local. Annotations belonging to secondary workspace folders were incorrectly treated as foreign annotations and rebased onto the primary folder.
2. `RehomingTarget` now receives all workspace folder URIs (`workspaceUris`), ensuring any annotation matching any workspace root is recognized as local and preserved untouched.
3. For foreign annotations shared across machines in multi-root workspaces, rehoming resolves workspace folder prefixes matching folder names/basenames.
4. `navigateToAnnotation`, `moveAnnotationUp`, and `moveAnnotationDown` in `AnnotationManager` now prioritize `annotation.fileUri` directly, and `getAbsolutePath` accounts for multi-root folder prefixes.

Validated by unit tests in `AnnotationRehoming.unit.test.ts` and integration tests in `lot18-shared-annotations.integration.test.ts`.

## Dependabot noise reduction & dependency updates

- Grouped dependencies in `.github/dependabot.yml` across root and `/mcp-server` modules.
- Updated GitHub Actions workflow versions to pinned secure SHAs.
- Automated merge rules for non-major dependency updates passing CI.
