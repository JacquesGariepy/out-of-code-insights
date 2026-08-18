# Architecture Overview & Design Records

This document defines the architectural patterns and technical decisions for the platform.

## ADR-001: Out-of-Band Context Anchoring

### Status
Accepted

### Context
Codebases accumulate technical debt when temporary notes, review queries, and onboarding hints are embedded directly into source files.

### Decision
We adopt a decoupled metadata sidecar architecture using `annotations.json`, anchored by resilient semantic line hashing.

### Consequences
- Zero contamination of production Git diffs.
- Clean `git blame` history across all languages.
- Autonomous static documentation export.
