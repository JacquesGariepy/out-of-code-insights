# Out-of-Code Insights — license + sync server

Self-hostable companion server for the [Out-of-Code Insights](https://github.com/JacquesGariepy/out-of-code-insights)
VS Code extension. It does two things:

1. **License validation** — verifies offline-signed license keys (HMAC-SHA256) and serves the
   `POST /v1/validate` contract the extension's `LicenseManager` expects.
2. **Annotation sync** — stores the workspace annotation envelope
   (`.out-of-code-insights/annotations.json`, schema v2) per workspace id with optimistic
   concurrency, so a team can share annotations through a server they control.

**Zero runtime dependencies** — only `node:http`, `node:crypto`, `node:fs`, `node:path`.
The only state is a directory of JSON files (`DATA_DIR`), trivially backed up.

## Quick start (local)

```sh
cd license-server
npm install            # devDependencies only (typescript, @types/node)
npm run build          # tsc → dist/
LICENSE_SECRET=change-me node dist/src/server.js
# license-server listening on port 8787 (data dir: .../data)
```

Environment variables:

| Variable         | Default  | Purpose                                                     |
| ---------------- | -------- | ----------------------------------------------------------- |
| `LICENSE_SECRET` | (none)   | **Required.** HMAC secret for issuing and verifying keys.   |
| `PORT`           | `8787`   | HTTP listen port.                                           |
| `DATA_DIR`       | `./data` | JSON-file database (revocations + workspace envelopes).     |

Tests: `npm test` (builds, then runs `node --test` against `dist/test`).

## Deploy with Docker

```sh
cd license-server
docker build -t ooci-license-server .
docker run -d --name ooci-license-server \
    -e LICENSE_SECRET='change-me-to-a-long-random-string' \
    -p 8787:8787 \
    -v ooci-data:/data \
    ooci-license-server
```

The server refuses to start without `LICENSE_SECRET`. Put the server behind a TLS-terminating
reverse proxy (Caddy, nginx, Traefik) before exposing it — license keys travel in request
bodies and `Authorization` headers.

## Issue, revoke, list keys

Keys are offline-verifiable: `OOCI.<base64url(JSON payload)>.<base64url(HMAC-SHA256 signature)>`
with payload `{ id, entitlements: string[], exp? }`. Issuing requires only the secret — the
server keeps no record of issued keys; revocation is by key `id`.

```sh
# Issue a key with the sync + pro entitlements, valid 365 days (key on stdout):
LICENSE_SECRET=change-me node dist/src/cli.js issue --entitlements sync,pro --days 365

# Perpetual key with default entitlements (sync,pro):
LICENSE_SECRET=change-me node dist/src/cli.js issue

# Revoke / list (uses DATA_DIR, picked up by the running server immediately):
node dist/src/cli.js revoke <keyId>
node dist/src/cli.js list
```

With Docker: `docker exec -e LICENSE_SECRET=... ooci-license-server node dist/src/cli.js issue ...`.

## API

All requests and responses are JSON.

### `POST /v1/validate`

Body: `{ "key": "<license key>", "product": "out-of-code-insights" }`

Response `200`: `{ "valid": boolean, "entitlements": string[], "expiresAt"?: "<ISO date>" }`

`valid` is `false` (still HTTP 200) when the signature is wrong, the key is expired, or its id
is revoked. Malformed JSON or a missing `key` field is a `400`.

### `GET /v1/workspaces/:id/annotations`

Header: `Authorization: Bearer <license key>` — the key must verify and carry the `sync`
entitlement (`401` invalid/revoked/expired, `403` missing entitlement).

Response `200`: `{ "version": number, "envelope": { "schemaVersion": 2, "annotations": [...] } }`
Response `404`: the workspace was never pushed.

### `PUT /v1/workspaces/:id/annotations`

Same auth as GET. Headers: `If-Match: <version>` — the version last seen by the client,
`0` for the first push. Body: the schema-v2 annotations envelope.

Response `200`: `{ "version": <n+1> }` — the new server version.
Response `409`: `{ "version": <current> }` — someone pushed in between; pull, merge, retry.
Response `400`: missing/invalid `If-Match`, malformed JSON, or a non-object body.

Request bodies are capped at 1 MB (`413`). The workspace id is an opaque string chosen by the
client (URL-encoded); the server maps it to a collision-free file name under `DATA_DIR`.

## Point the extension at your server

In VS Code settings (`settings.json`):

```jsonc
{
    // License validation endpoint base — the extension POSTs to <url>/v1/validate.
    "annotation.pro.licenseServerUrl": "https://insights.example.com",

    // Features that require an entitlement from the license key.
    "annotation.pro.gatedFeatures": ["sync"]
}
```

Then run the extension's license command and paste a key issued above; entitlements returned by
`/v1/validate` unlock the gated features. For annotation sync, point the sync settings at the
same base URL — the extension calls `GET`/`PUT /v1/workspaces/<id>/annotations` with the license
key as the Bearer token and drives the `If-Match` version flow described above.

## Data layout

```
$DATA_DIR/
├── revoked.json               # JSON array of revoked key ids
└── workspaces/
    └── <slug>-<sha256_16>.json  # { "version": n, "envelope": { schemaVersion: 2, ... } }
```

Writes are atomic (temp file + rename). Run a single server instance per `DATA_DIR`.
License keys are never written to logs.
