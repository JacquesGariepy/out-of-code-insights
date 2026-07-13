# Out-of-Code Insights 1.4.1

This focused release makes annotation drag-and-drop a real movement workflow instead of a visual reorder.

## Drag-and-drop movement

- Drag one annotation onto another annotation in the native TreeView to re-anchor it at the destination.
- Move annotations across files without changing their ids, threads, tags, severity or resolution state.
- Drag a multi-selection together while preserving its relative line spacing.
- Drop onto a file group to choose the exact destination line with a native VS Code picker.
- Use **Move Selected Annotations…** from the Command Palette or tree context menu as an accessible alternative.

## Panel UI

- Every annotation card now has a dedicated drag handle.
- Selected cards move together when one selected handle is dragged.
- Cards and file groups show clear drop-target feedback.
- Dragging state follows VS Code theme colors and reduced-motion preferences.

## Important fix

The previous tree implementation treated a drop as list reordering and re-anchored every annotation in the file to its list index. A drop now updates only the annotations being moved and recaptures their anchors against the actual destination document.

## Release cadence

This is intentionally a focused patch release. The deeper panel hierarchy and incremental-rendering work is tracked for 1.4.2, while advanced editor-drop and workspace workflows are tracked separately for 1.5.0.
