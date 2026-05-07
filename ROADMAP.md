# Roadmap

This file provides a short summary of planned releases. For full details,
including effort estimates, value rationale, and dependency mapping, see
[docs/ROADMAP.md](./docs/ROADMAP.md).

Items become tracked work only when a GitHub issue is opened referencing this
document. Contributions are welcome -- see [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## Short-term -- v1.1 (target: ~15 h total)

| #   | Feature                                                                | Effort |
| --- | ---------------------------------------------------------------------- | ------ |
| 1   | Auto-detect TODO/FIXME/HACK/XXX markers and convert to annotations     | ~4 h   |
| 2   | Import VS Code diagnostics (ESLint, TSLint, TypeScript) as annotations | ~6 h   |
| 3   | Context-aware annotation templates (infer file type, suggest template) | ~5 h   |

---

## Mid-term -- v1.2 and v1.3 (target: ~48 h total)

| #   | Feature                                                         | Effort |
| --- | --------------------------------------------------------------- | ------ |
| 4   | Multi-format report export: PDF, Markdown, HTML                 | ~8 h   |
| 5   | Real-time statistics dashboard with CSV export                  | ~10 h  |
| 6   | Git-based collaborative annotations with conflict resolution UI | ~12 h  |
| 7   | Bidirectional sync with GitHub and GitLab Issues                | ~18 h  |

---

## Long-term -- v2.0 (target: ~46 h total)

| #   | Feature                                                           | Effort |
| --- | ----------------------------------------------------------------- | ------ |
| 8   | AI clustering and duplicate detection via embeddings              | ~20 h  |
| 9   | Optional cloud sync across machines (opt-in, local-first default) | ~16 h  |
| 10  | Code-hotspot annotations combining git frequency and AI analysis  | ~10 h  |

---

See [docs/ROADMAP.md](./docs/ROADMAP.md) for the full specification of each item.
