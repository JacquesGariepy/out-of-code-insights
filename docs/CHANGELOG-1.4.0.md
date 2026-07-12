# Out-of-Code Insights 1.4.0

This release makes annotation triage faster in both the native VS Code tree and the full annotations panel.

## Native annotation tree

- Shows only file groups at the root; panel navigation remains in the view title toolbar.
- Adds native TreeView badges, open/resolved summaries, attention messages and an empty-state hint.
- Supports VS Code multi-selection and exposes a context-aware bulk-actions button.
- Uses native checkboxes to resolve or reopen annotations directly from the tree.
- Adds concise one-line labels, per-file state counts, theme-aware severity colors and richer tooltips.
- Adds accessible labels for file groups and annotation rows.

## Panel workflow

- Adds persistent annotation selection with a visible selected-card state.
- Adds Select visible, Resolve, Reopen, Severity, Delete and Clear selection controls.
- Preserves selection while switching quick filters or rebuilding the panel.
- Uses the same transactional command backend as the native tree so multi-item updates emit one store change.

## Microsoft VS Code SDK integration

- Uses `TreeView.badge`, `TreeView.description` and `TreeView.message` for native view status.
- Uses `TreeItem.checkboxState` and `onDidChangeCheckboxState` for resolution state.
- Uses `canSelectMany`, selection events and `setContext` for context-aware commands.
- Uses `ThemeIcon`, `ThemeColor`, accessibility metadata, `QuickPick` and modal warning dialogs.

## Validation

- TypeScript typecheck and ESLint cover the changed extension, tree and panel sources.
- Integration coverage verifies native tree statistics/checkbox state and multi-annotation transactional updates.
