# ADR-002: Claude dual-adapter proposal

**Date:** 2025-06-01 (reconstructed)

**Status:** Superseded on 2026-07-13

**Deciders:** Jacques Gariepy

## Context

An earlier design proposed a Claude-specific SDK path with a REST fallback.
Legacy source files and the `annotation.claudeUseSDK` setting still reflect
that proposal.

The active extension does not instantiate that provider. Advertising the
setting as a working switch would therefore be inaccurate and would create a
second provider lifecycle beside the unified adapter.

## Superseding decision

The supported runtime uses `UnifiedAIAdapter` and the canonical
`AIProviderCatalog`. Anthropic models are selected with:

```jsonc
{
    "annotation.provider": "anthropic",
}
```

There is no selectable `claude` provider ID. Provider selection, connection
fields and credentials are configured through **Configure AI Provider &
Credentials**. The exact active catalogue is documented in
[AI providers](../llm-providers.md).

## Consequences

- Users see one provider catalogue and one credential workflow.
- Documentation and tests must not claim the legacy SDK/fallback files are
  active.
- `annotation.claudeUseSDK` remains legacy/inactive until it is removed or a
  future explicit architecture decision integrates and tests such a path.
- The orphan implementation is tracked for cleanup under `ARCH-002` and
  `CONFIG-001` in [`tasks.jsonp`](../../tasks.jsonp).
