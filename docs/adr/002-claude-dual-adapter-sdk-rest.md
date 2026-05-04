# ADR-002: Dual-Adapter Strategy for the Claude Provider (SDK + REST Fallback)

**Date:** 2025-06-01 (reconstructed)
**Status:** Accepted
**Deciders:** Jacques Gariepy

---

## Context

The extension integrates with the Anthropic Claude API through the
`@anthropic-ai/claude-code` SDK. However, the SDK has specific environmental
requirements:

- It requires a compatible Node.js version and native module support.
- Some VS Code installations run in sandboxed or restricted environments
  (Linux WSL with older Node, certain enterprise VS Code builds).
- The SDK may fail to load at runtime even when the npm install succeeded.

Falling back to a raw HTTP REST call to the same API is always possible but
produces a different surface: the SDK exposes a `query()` streaming interface
while the REST endpoint requires manual `fetch` with JSON body construction.

---

## Decision

`ClaudeCodeProvider` implements a two-adapter strategy:

```
ClaudeIntegration
  ClaudeSDKAdapter   -- preferred; uses @anthropic-ai/claude-code SDK
  ClaudeRESTAdapter  -- fallback; direct HTTP call to api.anthropic.com
```

The active adapter is selected at request time:
- If `annotation.claudeUseSDK` is `true` and the SDK initializes successfully,
  `ClaudeSDKAdapter` is used.
- If the SDK fails to load (Node incompatibility, native module error, or
  environment restriction), `ClaudeIntegration` falls back transparently to
  `ClaudeRESTAdapter` and notifies the user with an informational message.

`ClaudeSDKWrapper` adds the `AbortController` polyfill required by the SDK
before importing it.

---

## Consequences

**Easier:**
- The extension works in environments where the SDK cannot be loaded.
- Fallback is transparent; users see only an informational notice.
- Both adapters share the same `ClaudeProfile` interface.

**Harder:**
- Two code paths must be maintained for the same provider.
- SDK API surface changes (e.g., the `query()` signature) require updating
  both the adapter and the wrapper.
- The `ClaudeSDKWrapper` polyfill adds startup overhead.

**Trade-offs accepted:**
- Code duplication in the two adapters is acceptable because the Claude
  integration is a high-value feature and environment compatibility is a hard
  user requirement across Windows, macOS, and Linux VS Code installations.
