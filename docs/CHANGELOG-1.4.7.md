# 1.4.7 — Annotations outside the repository and a wider comment import

Release date: 2026-08-20.

## Outcome

Version 1.4.7 lets `annotation.path` point at an explicit absolute or home-relative location, so personal annotations can live in a cloud-synced folder instead of the repository. It also widens the workspace comment import to the languages the codec already understood, and repairs two defects found while auditing that work.

## Annotations stored outside the workspace

Requested in [issue #101](https://github.com/JacquesGariepy/out-of-code-insights/issues/101):
users keeping annotations as personal notes need them synchronized across machines without committing them to the project repository. Until 1.4.6 every configured path was rejected with `Annotation path must stay inside the workspace.`

### What changed

`annotation.path` now distinguishes two shapes:

1. **Workspace-relative** (unchanged, still the default). The value stays relative, `..` segments are refused before any resolution, and the resolved target must remain under the workspace root.
2. **Explicit absolute or home-relative** (`~/Cloud/<project>/annotations.json`, `D:/Sync/<project>/annotations.json`). The value is honoured as given, and **that file's own parent directory becomes the confinement boundary**.

A value without a `.json` extension is still treated as a directory and receives the default `annotations.json` file name.

### Security properties preserved

The relaxation is limited to _where_ the boundary sits, never to _what_ is enforced inside it. For an external target, `AnnotationPersistence` still:

- resolves the real path of the parent directory and every component below it;
- refuses a symbolic link, junction or reparse point at the target or on the way to it;
- refuses a target that is not a regular file;
- refuses any component whose physical path escapes the resolved boundary;
- commits through a same-directory temporary file and one atomic rename, so a failed save never truncates the last good file.

Tilde handling is deliberately narrow: only a bare `~` or a `~` followed by a separator expands. `~team/notes.json` stays a plain relative segment and remains subject to workspace confinement.

`configuredAnnotationPath` (extension), `AnnotationPersistence` (transactional stack) and `AnnotationManager.getProjectAnnotationsPath` (legacy owner) now share one `expandHomePath` helper and one `DEFAULT_ANNOTATION_FILE_NAME` constant instead of three drifting copies.

### External hot-reload

The annotations file watcher is now anchored on the resolved file's parent directory rather than on a workspace-relative pattern, so a file updated outside the workspace folder — by Dropbox, OneDrive, iCloud or Syncthing — is picked up and reloaded live.

## Wider workspace comment import

`languageOfPath` now maps roughly fifty extensions plus the extension-less `Dockerfile` and `Makefile`, matching the languages the comment codec already had a syntax for: Swift, Kotlin, Dart, PHP, Perl, R, Haskell, Clojure/ClojureScript, Lisp, Scheme, SCSS, XML/SVG, INI, and the `.mjs`/`.cjs`/`.mts`/`.cts`, `.cc`/`.cxx`/`.hpp`, `.bash`/`.zsh`, `.htm`/`.markdown` variants.

Three pieces had to move together for that to be reachable:

- the `annotations.importCommentsWorkspace` include glob, which previously listed only the original 23 extensions;
- `commentScanner`'s line-comment prefix table, which now knows `#` for `bash`/`zsh`, `;` for the Lisp family and `;`/`#` for INI — without it those files would have been scanned with the default `//`/`#` prefixes and imported nothing;
- plain CSS is intentionally excluded: its only comment form is a block, and the marker scanner is line-based.

## Fixes found while auditing

### Dependency folders could exhaust the import budget

The exclusion of `node_modules`, `.git`, `dist`, `out` and `coverage` had been converted into a filter applied to the results of `findFiles`. Because `maxResults` is enforced by the search engine _while_ it searches, dependency files consumed the 2000-file cap before real sources were reached; and because the filter matched absolute paths, a workspace located under any directory named `out`, `dist` or `coverage` filtered out every one of its own files. The exclusion is a glob again, now also covering `.vscode-test`.

### Import deduplication digests

The source-comment codec hashes without `crypto` so it stays importable from a browser or webview context. Its hand-rolled UTF-8 encoder assumed every code unit in the surrogate range began a valid pair, which diverged from Node's SHA-256 for unpaired surrogates. Since these digests are persisted inside `source-comment-import:` deduplication tags, any drift would silently duplicate previously imported comments. The encoder now substitutes U+FFFD exactly as Node does, and a unit test pins the digests against `crypto.createHash('sha256')`.

## Test and fixture hygiene

- The `Lot 12` workspace-import integration test was unreachable: `files.exclude` in the test workspace settings hid its own fixtures from `findFiles`. The exclusion was narrowed and the test now asserts that precondition explicitly instead of failing as an unexplained `0 !== 2`.
- The `lot7-*` clipboard fixtures are recreated by `ensureFixture` at the start of every run and rewritten by the cut/paste scenarios, so they are no longer tracked — `npm test` leaves a clean working tree.

## Validation

`npm run check` (typecheck, lint with zero warnings, format), 754 unit tests and 682 integration tests pass. The desktop companion was re-synchronized (`npm run sync-vendor`) with its 45 tests green.
