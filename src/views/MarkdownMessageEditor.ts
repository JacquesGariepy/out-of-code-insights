// SPDX-License-Identifier: MPL-2.0
//
// Multiline Markdown editor for annotation messages. Follows the existing
// webview pattern (KanbanView): panel singleton, CSP locked to the
// extension, HTML embedded as a template literal (accepted debt — do not
// refactor opportunistically).

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { loc } from '../managers/LocalizationManager';
import { getLogger } from '../utils/logger';
import type { AnnotationV2 } from '../transactional/types';
import type { AnnotationStore } from '../transactional/AnnotationStore';
import { escapeHtml } from './markdownMessageEditorHelpers';

/** Messages posted from the webview back to the extension. */
interface EditorWebviewMessage {
    command?: string;
    message?: string;
}

export class MarkdownMessageEditor {
    public static currentPanel: vscode.WebviewPanel | undefined;
    private static currentEditor: MarkdownMessageEditor | undefined;

    private disposables: vscode.Disposable[] = [];

    constructor(
        private readonly store: AnnotationStore,
        private annotation: Readonly<AnnotationV2>
    ) {}

    public static createOrShow(
        context: vscode.ExtensionContext,
        annotation: Readonly<AnnotationV2>,
        store: AnnotationStore
    ): void {
        const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

        // Singleton: retarget the existing panel to the requested annotation
        // instead of stacking a second editor.
        if (MarkdownMessageEditor.currentPanel && MarkdownMessageEditor.currentEditor) {
            MarkdownMessageEditor.currentEditor.annotation = annotation;
            MarkdownMessageEditor.currentPanel.webview.html = MarkdownMessageEditor.currentEditor.getWebviewContent(
                MarkdownMessageEditor.currentPanel.webview
            );
            MarkdownMessageEditor.currentPanel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'annotationMarkdownEditor',
            loc('editMessageTitle', 'Edit Annotation Message'),
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [context.extensionUri],
            }
        );

        const editor = new MarkdownMessageEditor(store, annotation);
        MarkdownMessageEditor.currentPanel = panel;
        MarkdownMessageEditor.currentEditor = editor;

        panel.webview.html = editor.getWebviewContent(panel.webview);
        panel.webview.onDidReceiveMessage(
            (message: EditorWebviewMessage) => editor.handleMessage(message),
            null,
            editor.disposables
        );
        panel.onDidDispose(
            () => {
                MarkdownMessageEditor.currentPanel = undefined;
                MarkdownMessageEditor.currentEditor = undefined;
                editor.dispose();
            },
            null,
            editor.disposables
        );
    }

    private handleMessage(message: EditorWebviewMessage): void {
        switch (message.command) {
            case 'save': {
                const next = typeof message.message === 'string' ? message.message : '';
                if (next.trim().length === 0) {
                    void vscode.window.showErrorMessage(loc('emptyMessageError', 'Message cannot be empty'));
                    return;
                }
                try {
                    this.store.update(this.annotation.id, { message: next });
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    getLogger().error('MarkdownMessageEditor: update failed', err);
                    void vscode.window.showErrorMessage(
                        loc('updateMessageError', 'Failed to update annotation message') + `: ${msg}`
                    );
                    return;
                }
                void vscode.window.showInformationMessage(
                    loc('annotationMessageUpdated', 'Annotation message updated.')
                );
                MarkdownMessageEditor.currentPanel?.dispose();
                break;
            }
            case 'cancel':
                MarkdownMessageEditor.currentPanel?.dispose();
                break;
        }
    }

    private getWebviewContent(webview: vscode.Webview): string {
        const nonce = crypto.randomBytes(16).toString('base64');
        const cspSource = webview.cspSource;

        const localizedStrings = {
            title: loc('editMessageTitle', 'Edit Annotation Message'),
            hint: loc('editMessageHint', 'Markdown is supported.'),
            save: loc('save', 'Save'),
            cancel: loc('cancel', 'Cancel'),
        };

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${cspSource} data:; font-src ${cspSource};">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${escapeHtml(localizedStrings.title)}</title>
            <style>
                body {
                    margin: 0;
                    padding: 0;
                    background-color: var(--vscode-editor-background);
                    color: var(--vscode-editor-foreground);
                    font-family: var(--vscode-font-family);
                    font-size: var(--vscode-font-size);
                }

                .container {
                    padding: 16px;
                    height: 100vh;
                    box-sizing: border-box;
                    display: flex;
                    flex-direction: column;
                    gap: 10px;
                }

                .header {
                    display: flex;
                    justify-content: space-between;
                    align-items: baseline;
                    padding-bottom: 8px;
                    border-bottom: 1px solid var(--vscode-editorWidget-border);
                }

                .title {
                    font-size: 16px;
                    font-weight: 600;
                }

                .location {
                    font-size: 12px;
                    opacity: 0.8;
                }

                .hint {
                    font-size: 11px;
                    opacity: 0.7;
                }

                textarea {
                    flex: 1;
                    width: 100%;
                    box-sizing: border-box;
                    resize: none;
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border: 1px solid var(--vscode-input-border);
                    border-radius: 3px;
                    padding: 8px;
                    font-family: var(--vscode-editor-font-family, monospace);
                    font-size: var(--vscode-editor-font-size, 13px);
                }

                textarea:focus {
                    outline: 1px solid var(--vscode-focusBorder);
                }

                .buttons {
                    display: flex;
                    justify-content: flex-end;
                    gap: 8px;
                }

                .btn {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 6px 14px;
                    border-radius: 3px;
                    cursor: pointer;
                }

                .btn:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }

                .btn.secondary {
                    background-color: transparent;
                    color: var(--vscode-editor-foreground);
                    border: 1px solid var(--vscode-input-border);
                }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <span class="title">${escapeHtml(localizedStrings.title)}</span>
                    <span class="location">${escapeHtml(this.annotation.file)}</span>
                </div>
                <textarea id="messageInput" spellcheck="false">${escapeHtml(this.annotation.message)}</textarea>
                <div class="hint">${escapeHtml(localizedStrings.hint)}</div>
                <div class="buttons">
                    <button class="btn secondary" id="cancelBtn">${escapeHtml(localizedStrings.cancel)}</button>
                    <button class="btn" id="saveBtn">${escapeHtml(localizedStrings.save)}</button>
                </div>
            </div>
            <script nonce="${nonce}">
                const vscode = acquireVsCodeApi();
                const input = document.getElementById('messageInput');

                document.getElementById('saveBtn').addEventListener('click', () => {
                    vscode.postMessage({ command: 'save', message: input.value });
                });

                document.getElementById('cancelBtn').addEventListener('click', () => {
                    vscode.postMessage({ command: 'cancel' });
                });

                // Ctrl/Cmd+Enter saves, Escape cancels.
                input.addEventListener('keydown', (e) => {
                    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                        e.preventDefault();
                        vscode.postMessage({ command: 'save', message: input.value });
                    } else if (e.key === 'Escape') {
                        e.preventDefault();
                        vscode.postMessage({ command: 'cancel' });
                    }
                });

                input.focus();
                input.setSelectionRange(input.value.length, input.value.length);
            </script>
        </body>
        </html>`;
    }

    private dispose(): void {
        while (this.disposables.length) {
            const disposable = this.disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
}
