# Out-of-Code Insights 1.2.1

Released: 2026-07-11

## Highlights

- Annotation identity now follows copy, cut, paste, replacement-paste, Undo,
  and native editor drag-and-drop more reliably.
- Cross-file moves update the destination URI, relative path, and language.
- Multiple annotations attached to the same source line move or copy together.
- The annotation panel now has summary counters, quick filters, responsive
  styling, keyboard navigation, visible focus, ARIA labels, and reduced-motion
  support.

## Fixed

- Fixed paste-over-selection operations dropping attached annotations.
- Fixed Undo of ordinary typing removing the last-created annotation.
- Fixed Redo after an undone paste failing to restore the copied annotation
  with its original identity and offsets.
- Fixed paste-generated annotations becoming ghost cut-buffer entries on Undo.
- Fixed multi-cursor paste operations cloning a clone created earlier in the
  same event.
- Fixed cross-file annotation metadata retaining the source display path.

## Validation

- TypeScript typecheck and targeted ESLint pass.
- 485 extension unit and pure integration tests pass.
