import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface Logger {
    debug(msg: string, meta?: Record<string, unknown>): void;
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(msg: string, err?: unknown, meta?: Record<string, unknown>): void;
    show(): void;
    dispose(): void;
    getLogFilePath(): string | undefined;
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_ROTATIONS = 3;

let _instance: Logger | undefined;

class ExtensionLogger implements Logger {
    private readonly channel: vscode.LogOutputChannel;
    private readonly logFilePath: string | undefined;
    private level: LogLevel;

    constructor(
        private readonly name: string,
        context?: vscode.ExtensionContext
    ) {
        this.channel = vscode.window.createOutputChannel(name, { log: true });
        this.level = this.readLevel();

        if (context?.logUri) {
            const dir = context.logUri.fsPath;
            fs.mkdirSync(dir, { recursive: true });
            this.logFilePath = path.join(dir, 'extension.log');
        }

        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('outOfCodeInsights.logLevel')) {
                this.level = this.readLevel();
            }
        });
    }

    debug(msg: string, meta?: Record<string, unknown>): void {
        this.write('debug', msg, undefined, meta);
    }

    info(msg: string, meta?: Record<string, unknown>): void {
        this.write('info', msg, undefined, meta);
    }

    warn(msg: string, meta?: Record<string, unknown>): void {
        this.write('warn', msg, undefined, meta);
    }

    error(msg: string, err?: unknown, meta?: Record<string, unknown>): void {
        this.write('error', msg, err, meta);
    }

    show(): void {
        this.channel.show();
    }

    dispose(): void {
        this.channel.dispose();
    }

    getLogFilePath(): string | undefined {
        return this.logFilePath;
    }

    private readLevel(): LogLevel {
        return vscode.workspace
            .getConfiguration('outOfCodeInsights')
            .get<LogLevel>('logLevel', 'info');
    }

    private write(level: LogLevel, msg: string, err?: unknown, meta?: Record<string, unknown>): void {
        if (LEVEL_RANK[level] < LEVEL_RANK[this.level]) {
            return;
        }
        switch (level) {
            case 'debug': this.channel.debug(msg); break;
            case 'info':  this.channel.info(msg);  break;
            case 'warn':  this.channel.warn(msg);  break;
            case 'error': this.channel.error(msg); break;
        }
        if (this.logFilePath) {
            const errStr = err instanceof Error
                ? `\n  ${err.message}${err.stack ? `\n  ${err.stack}` : ''}`
                : err !== undefined ? `\n  ${String(err)}` : '';
            const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
            const line = `[${new Date().toISOString()}] [${level.toUpperCase().padEnd(5)}] [${this.name}] ${msg}${metaStr}${errStr}\n`;
            this.appendToFile(this.logFilePath, line);
        }
    }

    private appendToFile(filePath: string, line: string): void {
        try {
            if (fs.existsSync(filePath) && fs.statSync(filePath).size >= MAX_FILE_SIZE) {
                this.rotateFile(filePath);
            }
            fs.appendFileSync(filePath, line, 'utf8');
        } catch {
            // File logging is best-effort; never break the extension
        }
    }

    private rotateFile(filePath: string): void {
        for (let i = MAX_ROTATIONS - 1; i >= 1; i--) {
            const from = `${filePath}.${i}`;
            const to = `${filePath}.${i + 1}`;
            if (fs.existsSync(from)) {
                try { fs.renameSync(from, to); } catch { /* best-effort */ }
            }
        }
        try { fs.renameSync(filePath, `${filePath}.1`); } catch { /* best-effort */ }
    }
}

export function initializeLogger(name: string, context: vscode.ExtensionContext): Logger {
    _instance = new ExtensionLogger(name, context);
    return _instance;
}

export function getLogger(): Logger {
    return _instance ?? {
        debug: () => { /* noop before logger is initialized */ },
        info:  () => { /* noop before logger is initialized */ },
        warn:  (msg: string) => console.warn(`[WARN] ${msg}`),
        error: (msg: string, err?: unknown) => console.error(`[ERROR] ${msg}`, err),
        show:  () => { /* noop before logger is initialized */ },
        dispose: () => { /* noop before logger is initialized */ },
        getLogFilePath: () => undefined
    };
}
