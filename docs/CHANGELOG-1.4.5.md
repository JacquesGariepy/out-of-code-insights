# 1.4.5 — Reliable team sharing and paste tracking

Release date: 2026-08-17.

## Outcome

Version 1.4.5 is a focused bugfix release for two field reports: annotations
committed to Git now resolve on every teammate's workstation, and pasting code
that merely resembles annotated code no longer clones annotations onto it.

## Annotations shared across workstations resolve everywhere

Reported in [discussion #80](https://github.com/JacquesGariepy/out-of-code-insights/discussions/80):
a team committing `.out-of-code-insights/annotations.json` found that
annotations created on one machine did not anchor on another, and
**Navigate** failed with
`cannot open file … Unable to resolve nonexistent file`, because each
persisted `fileUri` recorded the author's absolute path.

Every annotation also persists its workspace-relative path. As of 1.4.5,
every deserialization source — activation load, external file-watcher reloads
(for example a `git pull` while VS Code is open, or an MCP server write), and
remote sync pulls — rebases any `fileUri` that does not live under the
current workspace folder onto it, using that relative path:

- Rehoming never drops data: a foreign annotation whose relative path is
  missing or unsafe (absolute, UNC, `..` traversal) is preserved unchanged
  rather than redirected or discarded, so a hostile or corrupted
  annotations.json cannot point an annotation outside the workspace.
- The on-disk format is unchanged (schema v2): files written by earlier
  versions, by teammates, or by the MCP server load as-is. The file still
  records the absolute URIs of the last writer, so diffs may show `fileUri`
  churn between machines; functionality no longer depends on those values.
- Teammates must open the same folder as the workspace root (typically the
  repository root), since annotations resolve by workspace-relative path.

Validated by native unit tests for the rehoming module (path sanitization,
cross-platform URI shapes, remote schemes, mixed envelopes) and an
integration test that replays the reported scenario end to end inside a live
extension host: a teammate envelope with a foreign absolute URI lands on
disk, the store rehomes it, and **Navigate** opens the local file at the
annotated line.

## Pasting look-alike code no longer clones annotations

Reported in [issue #95](https://github.com/JacquesGariepy/out-of-code-insights/issues/95):
pasting a code block whose lines matched the hash of an annotated line —
for example the near-identical repeated predicate blocks of a Minecraft
model-modifier JSON — spuriously cloned the annotation onto code that was
never annotated.

Paste-clone candidates are now vetted against the pasted block's own
surrounding lines before any clone is created:

- A full interior line of the paste that contradicts the annotation's
  context rejects the candidate; partial clipboard edge lines (selections
  starting or ending mid-line) stay neutral instead of vetoing legitimate
  copies.
- Same-file sources are scored against the live document neighbourhood at a
  depth matching the pasted block, so repeated blocks that differ only
  beyond the persisted 3-line context snapshot are still told apart.
- Compatibility is decided per source location, so co-located annotations
  always carry over together, and the cut/paste move safety net is
  unchanged.

The regression tests were built from the actual issue attachment and video:
cross-file paste of the reported JSON, same-file paste of a sibling
predicate block, and positive controls proving that copying or cutting the
annotated block itself still carries the annotation.

## Test-infrastructure fix

Integration runs (`npm test`) now rebuild the webpack bundle before
launching the extension host. Previously the host loaded a possibly stale
`dist/extension.js` while only the TypeScript output was rebuilt, so an
integration pass could validate outdated extension code.
