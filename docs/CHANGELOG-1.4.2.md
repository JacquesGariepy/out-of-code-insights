# Out-of-Code Insights 1.4.2

This focused release extends annotation drag-and-drop onto the code editor itself.

## Drop Into Editor

- Drag an annotation from the native TreeView directly onto the exact destination line in a code editor.
- Multi-selected annotations move together and keep their relative line spacing.
- The destination file, URI, language, offsets, line hash and surrounding context are recaptured from the code document.
- The drop uses Microsoft VS Code's `DocumentDropEditProvider` and a versioned annotation MIME payload.
- Moving annotation metadata inserts no text and makes no source-code modification.

## Panel integration

- Panel drag handles emit the same annotation MIME payload used by the native tree.
- Environments that forward webview drag payloads to the workbench can use the same code-editor target.
- The existing **Move** button remains the reliable keyboard-accessible alternative.

## Release cadence

This capability is published separately from the 1.4.1 tree/panel movement release. The deeper visual hierarchy and incremental panel rendering remain isolated in the planned 1.4.3 release.
