// SPDX-License-Identifier: MPL-2.0
//
// FileStore — JSON-file database rooted at DATA_DIR (default ./data).
//
// Layout:
//     <dataDir>/revoked.json                  string[] of revoked key ids
//     <dataDir>/workspaces/<slug>-<hash>.json { version: number, envelope: object }
//
// Writes are atomic: serialize to a temp file in the same directory, then
// rename over the destination (rename is atomic on POSIX and uses
// MOVEFILE_REPLACE_EXISTING on Windows). The store uses synchronous fs on a
// single-threaded runtime, so each read-modify-write sequence is atomic per
// process. Cross-process concurrency is out of scope — run one server
// instance per DATA_DIR.
//
// Workspace ids are arbitrary client-supplied strings; they are mapped to
// file names through a sanitized slug plus a SHA-256 prefix so two distinct
// ids can never collide and no id can escape <dataDir>/workspaces.

import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Stored record for one workspace. `envelope` is opaque to the server. */
export interface WorkspaceRecord {
    version: number;
    envelope: unknown;
}

/** Outcome of an optimistic-concurrency write. `version` is the current server version. */
export type PutResult = { ok: true; version: number } | { ok: false; version: number };

function atomicWriteJson(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(tmp, file);
}

function readJsonIfExists(file: string): unknown {
    let content: string;
    try {
        content = fs.readFileSync(file, 'utf8');
    } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'ENOENT') {
            return undefined;
        }
        throw err;
    }
    return JSON.parse(content);
}

/**
 * Record of a key issued by the Stripe webhook. The raw key is stored so the
 * operator can deliver it to the customer (self-hosted deployment — protect
 * DATA_DIR accordingly; revoke via the key id if it leaks).
 */
export interface IssuedKeyRecord {
    /** Stripe event id — issuance is idempotent per event. */
    eventId: string;
    keyId: string;
    key: string;
    email: string | null;
    entitlements: string[];
    expiresAt?: string;
    createdAt: string;
}

export class FileStore {
    private readonly revokedFile: string;
    private readonly workspacesDir: string;
    private readonly issuedFile: string;

    constructor(dataDir: string) {
        this.revokedFile = path.join(dataDir, 'revoked.json');
        this.workspacesDir = path.join(dataDir, 'workspaces');
        this.issuedFile = path.join(dataDir, 'issued.json');
    }

    // ── Revocation ───────────────────────────────────────────────────────

    /** All revoked key ids, sorted. Missing file means nothing is revoked. */
    listRevoked(): string[] {
        const raw = readJsonIfExists(this.revokedFile);
        if (raw === undefined) {
            return [];
        }
        if (!Array.isArray(raw) || !raw.every((id) => typeof id === 'string')) {
            throw new Error(`FileStore: ${this.revokedFile} is corrupt — expected a JSON array of strings`);
        }
        return [...raw].sort();
    }

    isRevoked(keyId: string): boolean {
        return this.listRevoked().includes(keyId);
    }

    /** Add `keyId` to the revocation list. Idempotent. */
    revoke(keyId: string): void {
        if (typeof keyId !== 'string' || keyId.length === 0) {
            throw new Error('FileStore.revoke: keyId must be a non-empty string');
        }
        const revoked = this.listRevoked();
        if (revoked.includes(keyId)) {
            return;
        }
        revoked.push(keyId);
        atomicWriteJson(this.revokedFile, revoked.sort());
    }

    // ── Workspace annotation envelopes ───────────────────────────────────

    /** Stored record for `workspaceId`, or null when never pushed. */
    getWorkspace(workspaceId: string): WorkspaceRecord | null {
        const raw = readJsonIfExists(this.workspaceFile(workspaceId));
        if (raw === undefined) {
            return null;
        }
        if (
            typeof raw !== 'object' ||
            raw === null ||
            typeof (raw as WorkspaceRecord).version !== 'number' ||
            !('envelope' in raw)
        ) {
            throw new Error(`FileStore: workspace record for ${workspaceId} is corrupt`);
        }
        return raw as WorkspaceRecord;
    }

    /**
     * Optimistic-concurrency write. `expectedVersion` must equal the current
     * stored version (0 when the workspace has never been pushed). On match
     * the envelope is persisted under version `expectedVersion + 1`; on
     * mismatch nothing is written and the current version is reported.
     */
    putWorkspace(workspaceId: string, expectedVersion: number, envelope: unknown): PutResult {
        const current = this.getWorkspace(workspaceId);
        const currentVersion = current === null ? 0 : current.version;
        if (expectedVersion !== currentVersion) {
            return { ok: false, version: currentVersion };
        }
        const record: WorkspaceRecord = { version: currentVersion + 1, envelope };
        atomicWriteJson(this.workspaceFile(workspaceId), record);
        return { ok: true, version: record.version };
    }

    // ── Webhook-issued keys ──────────────────────────────────────────────

    /** All webhook-issued key records, oldest first. */
    listIssuedKeys(): IssuedKeyRecord[] {
        const raw = readJsonIfExists(this.issuedFile);
        if (raw === undefined) {
            return [];
        }
        if (!Array.isArray(raw)) {
            throw new Error(`FileStore: ${this.issuedFile} is corrupt — expected a JSON array`);
        }
        return raw as IssuedKeyRecord[];
    }

    /**
     * Persist a webhook-issued key. Idempotent per Stripe event id: returns
     * false (and writes nothing) when the event was already processed.
     */
    recordIssuedKey(record: IssuedKeyRecord): boolean {
        if (typeof record.eventId !== 'string' || record.eventId.length === 0) {
            throw new Error('FileStore.recordIssuedKey: eventId must be a non-empty string');
        }
        const issued = this.listIssuedKeys();
        if (issued.some((r) => r.eventId === record.eventId)) {
            return false;
        }
        issued.push(record);
        atomicWriteJson(this.issuedFile, issued);
        return true;
    }

    /**
     * Map an arbitrary workspace id to a safe file name inside
     * `<dataDir>/workspaces`. The SHA-256 prefix guarantees uniqueness; the
     * slug keeps files human-recognizable.
     */
    private workspaceFile(workspaceId: string): string {
        if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
            throw new Error('FileStore: workspaceId must be a non-empty string');
        }
        const hash = createHash('sha256').update(workspaceId, 'utf8').digest('hex').slice(0, 16);
        const slug = workspaceId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 48) || 'ws';
        return path.join(this.workspacesDir, `${slug}-${hash}.json`);
    }
}
