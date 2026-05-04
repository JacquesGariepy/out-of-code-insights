# ADR-0001: Record Architecture Decisions

**Date:** 2026-05-04
**Status:** Accepted
**Deciders:** Jacques Gariepy

---

## Context

Architectural decisions shape the codebase over time. Without a record, the
rationale behind a design is lost when the original author moves on, or when
a revisit is needed months later. New contributors need to understand not only
*what* was built, but *why* it was built that way.

---

## Decision

We will use Architecture Decision Records (ADRs) to document significant
design choices. Each ADR lives in `docs/adr/` and follows this template
(adapted from Nygard 2011 and MADR 4.0):

```
# ADR-NNNN: Title

**Date:** YYYY-MM-DD
**Status:** Proposed | Accepted | Deprecated | Superseded by ADR-NNNN
**Deciders:** <name(s)>

## Context
What is the problem and the forces at play?

## Decision
What is the chosen solution?

## Consequences
What becomes easier? What becomes harder? What trade-offs are accepted?
```

ADRs are numbered sequentially. Accepted ADRs are immutable; if a decision
changes, a new ADR supersedes the old one (update `Status` in the old ADR).

---

## Consequences

- Contributors have a written record of key design choices.
- Revisiting a decision requires creating a new ADR, not editing an old one.
- The `docs/adr/` directory grows over time; index in `docs/README.md`.
