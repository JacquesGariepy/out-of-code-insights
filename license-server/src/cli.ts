#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
//
// Admin CLI for the license server.
//
//     node dist/src/cli.js issue [--entitlements sync,pro] [--days 365] [--id <id>]
//     node dist/src/cli.js revoke <keyId>
//     node dist/src/cli.js list
//
// `issue` prints the license key on stdout (pipe-friendly) and the metadata
// on stderr. `revoke` / `list` operate on the revocation store under
// DATA_DIR (default ./data) — the running server picks revocations up
// immediately, no restart needed.

import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { issueKey, type LicensePayload } from './keys';
import { FileStore } from './store';

const USAGE = `Usage:
  node dist/src/cli.js issue [--entitlements sync,pro] [--days 365] [--id <id>]
  node dist/src/cli.js revoke <keyId>
  node dist/src/cli.js list

Environment:
  LICENSE_SECRET   required for 'issue' (HMAC secret, same value as the server)
  DATA_DIR         revocation store location (default ./data)

Defaults:
  --entitlements   sync,pro
  --days           omitted = the key never expires`;

interface IssueArgs {
    id: string;
    entitlements: string[];
    days?: number;
}

function parseIssueArgs(argv: string[]): IssueArgs {
    const args: IssueArgs = { id: randomUUID(), entitlements: ['sync', 'pro'] };
    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i];
        const value = argv[i + 1];
        switch (flag) {
            case '--entitlements':
                if (value === undefined) {
                    throw new Error('--entitlements requires a comma-separated list (e.g. sync,pro)');
                }
                args.entitlements = value
                    .split(',')
                    .map((e) => e.trim())
                    .filter((e) => e.length > 0);
                i++;
                break;
            case '--days': {
                const days = Number(value);
                if (value === undefined || !Number.isFinite(days) || days <= 0) {
                    throw new Error('--days requires a positive number');
                }
                args.days = days;
                i++;
                break;
            }
            case '--id':
                if (value === undefined || value.length === 0) {
                    throw new Error('--id requires a non-empty value');
                }
                args.id = value;
                i++;
                break;
            default:
                throw new Error(`unknown option for 'issue': ${flag}`);
        }
    }
    return args;
}

function makeStore(): FileStore {
    return new FileStore(process.env.DATA_DIR ?? path.resolve('data'));
}

function cmdIssue(argv: string[]): number {
    const secret = process.env.LICENSE_SECRET;
    if (secret === undefined || secret.length === 0) {
        console.error('issue: the LICENSE_SECRET environment variable is required (same secret as the server)');
        return 1;
    }
    const args = parseIssueArgs(argv);
    const payload: LicensePayload = { id: args.id, entitlements: args.entitlements };
    if (args.days !== undefined) {
        payload.exp = new Date(Date.now() + args.days * 24 * 60 * 60 * 1000).toISOString();
    }
    const key = issueKey(payload, secret);
    console.error(`key id      : ${payload.id}`);
    console.error(`entitlements: ${payload.entitlements.join(', ') || '(none)'}`);
    console.error(`expires     : ${payload.exp ?? 'never'}`);
    console.log(key);
    return 0;
}

function cmdRevoke(argv: string[]): number {
    const keyId = argv[0];
    if (keyId === undefined || keyId.length === 0) {
        console.error('revoke: a key id is required');
        return 1;
    }
    makeStore().revoke(keyId);
    console.error(`revoked: ${keyId}`);
    return 0;
}

function cmdList(): number {
    const revoked = makeStore().listRevoked();
    if (revoked.length === 0) {
        console.error('(no revoked keys)');
        return 0;
    }
    for (const id of revoked) {
        console.log(id);
    }
    return 0;
}

function main(argv: string[]): number {
    const [command, ...rest] = argv;
    try {
        switch (command) {
            case 'issue':
                return cmdIssue(rest);
            case 'revoke':
                return cmdRevoke(rest);
            case 'list':
                return cmdList();
            default:
                console.error(USAGE);
                return 1;
        }
    } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        return 1;
    }
}

process.exitCode = main(process.argv.slice(2));
