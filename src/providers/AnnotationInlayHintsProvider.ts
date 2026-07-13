// SPDX-License-Identifier: MPL-2.0

import * as vscode from 'vscode';
import { inlineLabel } from '../decorations/annotationStyle';
import type { AnnotationStore } from '../transactional/AnnotationStore';
import type { AnnotationV2 } from '../transactional/types';
import type { VisibilityFilter } from '../transactional/VisibilityFilter';

export interface AnnotationInlayHintsConfig {
    enabled: boolean;
    maxMessageLength: number;
}

type ConfigReader = () => AnnotationInlayHintsConfig;

/**
 * Projects active annotations as compact, clickable hints at the end of their
 * anchor line. A line produces one hint even when it owns multiple annotations;
 * every message remains independently clickable while the move action carries
 * all annotation ids from the line.
 */
export class AnnotationInlayHintsProvider implements vscode.InlayHintsProvider, vscode.Disposable {
    private readonly _onDidChangeInlayHints = new vscode.EventEmitter<void>();
    readonly onDidChangeInlayHints = this._onDidChangeInlayHints.event;

    private readonly subscriptions: vscode.Disposable[] = [];

    constructor(
        private readonly store: AnnotationStore,
        private readonly visibilityFilter: VisibilityFilter,
        private readonly readConfig: ConfigReader = readWorkspaceConfig
    ) {
        this.subscriptions.push(this.store.onDidChange(() => this._onDidChangeInlayHints.fire()));
        this.subscriptions.push(this.store.onDidSuspend(() => this._onDidChangeInlayHints.fire()));
        this.subscriptions.push(this.store.onDidResume(() => this._onDidChangeInlayHints.fire()));
        this.subscriptions.push(this.store.onDidDispose(() => this._onDidChangeInlayHints.fire()));
        this.subscriptions.push(this.visibilityFilter.onDidChange(() => this._onDidChangeInlayHints.fire()));
        this.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (
                    event.affectsConfiguration('annotation.inlayHints') ||
                    event.affectsConfiguration('annotation.enableAnnotations')
                ) {
                    this._onDidChangeInlayHints.fire();
                }
            })
        );
    }

    provideInlayHints(
        document: vscode.TextDocument,
        range: vscode.Range,
        token: vscode.CancellationToken
    ): vscode.InlayHint[] {
        const config = normalizeConfig(this.readConfig());
        if (!config.enabled || !this.visibilityFilter.isGloballyEnabled() || token.isCancellationRequested) {
            return [];
        }

        const annotationsByLine = new Map<number, Readonly<AnnotationV2>[]>();
        for (const annotation of this.store.listForFile(document.uri.toString())) {
            if (token.isCancellationRequested) {
                return [];
            }
            if (annotation.state !== 'active' || !this.visibilityFilter.isVisible(annotation)) {
                continue;
            }

            const line = document.positionAt(annotation.startOffset).line;
            if (line < 0 || line >= document.lineCount) {
                continue;
            }
            const position = document.lineAt(line).range.end;
            if (!range.contains(position)) {
                continue;
            }

            const bucket = annotationsByLine.get(line);
            if (bucket) {
                annotationsByLine.set(line, [...bucket, annotation]);
            } else {
                annotationsByLine.set(line, [annotation]);
            }
        }

        return [...annotationsByLine.entries()]
            .sort(([left], [right]) => left - right)
            .map(([line, annotations]) => this.createHint(document, line, annotations, config.maxMessageLength));
    }

    dispose(): void {
        for (const subscription of this.subscriptions) {
            subscription.dispose();
        }
        this.subscriptions.length = 0;
        this._onDidChangeInlayHints.dispose();
    }

    private createHint(
        document: vscode.TextDocument,
        line: number,
        annotations: readonly Readonly<AnnotationV2>[],
        maxMessageLength: number
    ): vscode.InlayHint {
        const ordered = [...annotations].sort(
            (left, right) => left.startOffset - right.startOffset || left.id.localeCompare(right.id)
        );
        const labelParts: vscode.InlayHintLabelPart[] = [];

        ordered.forEach((annotation, index) => {
            if (index > 0) {
                labelParts.push(new vscode.InlayHintLabelPart(' · '));
            }
            const summary = inlineLabel(annotation.message, maxMessageLength) || 'Annotation';
            const pinnedLabel = annotation.pinned ? ' 📌' : '';
            const messagePart = new vscode.InlayHintLabelPart(
                `${severityIcon(annotation.severity)} ${summary}${pinnedLabel}`
            );
            messagePart.tooltip = new vscode.MarkdownString(
                `**${annotation.severity || 'info'}** · ${annotation.message}`
            );
            messagePart.command = {
                command: 'annotations.navigateToPanel',
                title: 'Open annotation in panel',
                arguments: [annotation.id],
            };
            labelParts.push(messagePart);
        });

        const ids = ordered.map((annotation) => annotation.id);
        const movePart = new vscode.InlayHintLabelPart(' ↔ Move');
        movePart.tooltip =
            ids.length === 1 ? 'Move this annotation' : `Move all ${ids.length} annotations from this line`;
        movePart.command = {
            command: 'annotations.pickUpForMove',
            title: ids.length === 1 ? 'Move annotation' : 'Move annotations',
            arguments: [{ ids }],
        };
        labelParts.push(movePart);

        const hint = new vscode.InlayHint(document.lineAt(line).range.end, labelParts, vscode.InlayHintKind.Type);
        hint.paddingLeft = true;
        hint.tooltip =
            ids.length === 1
                ? 'Open or move the annotation anchored to this line.'
                : `Open or move the ${ids.length} annotations anchored to this line.`;
        return hint;
    }
}

function readWorkspaceConfig(): AnnotationInlayHintsConfig {
    const config = vscode.workspace.getConfiguration('annotation');
    return {
        enabled: config.get<boolean>('inlayHints.enable', true),
        maxMessageLength: config.get<number>('inlayHints.maxMessageLength', 72),
    };
}

function normalizeConfig(config: AnnotationInlayHintsConfig): AnnotationInlayHintsConfig {
    const requestedLength = Number.isFinite(config.maxMessageLength) ? Math.trunc(config.maxMessageLength) : 72;
    return {
        enabled: config.enabled,
        maxMessageLength: Math.max(24, Math.min(160, requestedLength)),
    };
}

function severityIcon(severity: string | undefined): string {
    switch (severity) {
        case 'critical':
        case 'error':
            return '⛔';
        case 'warning':
        case 'warn':
            return '⚠';
        default:
            return '💬';
    }
}
