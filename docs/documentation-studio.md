# Documentation Studio

Documentation Studio turns the same out-of-code annotation set into a
managed, reproducible documentation bundle without changing a source file.
One run can produce source pages, a publishable static project, Markdown wiki
packages, an autonomous HTML site, and a constrained OpenAPI projection.

> **Availability:** Documentation Studio is included in version **1.4.4**.

## Quick start

1. Add regular annotations and assign documentation roles with **Add
   Documentation Annotation** (`doc:module`, `doc:class`, `doc:function`,
   `doc:example`, `doc:guide`, or one of the README/changelog/architecture/ADR/
   onboarding/runbook/reference roles).
2. Right-click in the editor and choose **Out-of-Code Insights → Documentation
   → Configure Documentation Studio**. From an Annotations tree item,
   right-click and open **Documentation**. Select a structure preset and one
   or more output formats. The Command Palette (`Ctrl+Shift+P`) is an
   alternative, not a prerequisite.
3. Run **Generate Annotation Documentation**. The default managed output is
   `docs/annotations/`.
4. Commit the generated files if documentation is part of the repository, or
   regenerate them in CI with `annotation.docs.watch` disabled.

The default **Complete documentation portal** preset emits:

```text
docs/annotations/
├── .ooci-docs-manifest.json      managed-file hashes and generation metadata
├── documentation-report.json    structured diagnostics for every renderer
├── site.config.json             portable project and build preferences
├── site.manifest.json           deterministic page and resource inventory
├── site.navigation.json         ordered navigation tree and page identities
├── toc.yml
├── index.md, by-type.md, ...
├── api/*.md
├── README.md
├── CHANGELOG.md
├── technical/
│   ├── architecture.md
│   ├── onboarding.md
│   ├── runbook.md
│   ├── reference.md
│   └── adr/
│       ├── README.md
│       └── *.md
├── wiki/hosted/
│   ├── Home.md
│   ├── _Sidebar.md
│   └── _Footer.md
├── html/
│   ├── index.html
│   ├── styles.css
│   └── annotations/*.html
└── openapi/openapi.json
```

## Document templates

Templates are safe presets: they select document kinds, output profiles and a
bounded set of structure switches. The page layouts and renderer logic remain
built into the extension; a template cannot supply arbitrary layout or
executable rendering code. Four built-in presets cover the common cases:

| Template         | Intended use                      | Default formats                                              |
| ---------------- | --------------------------------- | ------------------------------------------------------------ |
| `complete`       | Full engineering portal           | Source pages, static project, hosted wiki, web, API contract |
| `api-reference`  | Authored API reference            | Source pages, static project, web, API contract              |
| `team-wiki`      | Team review and knowledge sharing | Source pages, hosted wiki, web                               |
| `knowledge-base` | Host-neutral handbook             | Markdown, portable Wiki, HTML                                |

Choose **Workspace JSON template** to create or load the preset configured by
`annotation.docs.customTemplatePath`. The generated starter is safe to commit
and is validated before any output is written. Its schema is
[`schemas/document-template.schema.json`](../schemas/document-template.schema.json),
and a complete example lives in
[`docs/templates/document-template.example.json`](./templates/document-template.example.json).

```json
{
    "$schema": "https://raw.githubusercontent.com/JacquesGariepy/out-of-code-insights/main/schemas/document-template.schema.json",
    "schemaVersion": 1,
    "id": "engineering-portal",
    "label": "Engineering portal",
    "description": "Documentation for developers and reviewers.",
    "formats": ["markdown", "static-site", "hosted-wiki", "html", "openapi"],
    "documents": ["readme", "changelog", "architecture", "adr", "onboarding", "runbook", "reference"],
    "includeInventory": true,
    "includeAuthored": true,
    "apiFolder": "api",
    "guideFile": "guide.md",
    "language": "fr-CA"
}
```

Explicit workspace/global values for `annotation.docs.apiFolder`,
`guideFile`, `includeInventory`, and `includeAuthored` override the template.
An empty `annotation.docs.formats` follows the template; a non-empty array is
an explicit renderer override.

The `documents` collection selects concrete technical artifacts. Each artifact
is assembled only from explicitly tagged annotation content: `doc:readme`,
`doc:architecture`, `doc:adr`, `doc:onboarding`, `doc:runbook`, and
`doc:reference`. Changelog entries additionally require `doc:changelog`, one
`version:` or `release:` tag, and a category (`added`, `changed`, `deprecated`,
`removed`, `fixed`, or `security`); `release-date:YYYY-MM-DD` is optional and
never inferred. **Add Documentation Annotation** collects this metadata through
native prompts. This keeps generated documents reviewable instead of inventing
project claims, versions, dates, or routes from source text.

## Output profiles

### Markdown

The normalized source profile contains a landing page, inventories by type and
file, relationship links, guide content, and authored API pages. Output is
stable when `annotation.docs.includeTimestamp` is disabled. File-name
collisions are detected and receive deterministic suffixes instead of
overwriting another page. Dynamic TOC labels are YAML-quoted.

### Publishable static project

The static-project profile is a complete publishable source project, not merely
a collection of loosely related Markdown files:

- its build configuration includes conceptual Markdown and TOCs, local
  resources, language, search metadata, theme metadata, and a dedicated output
  folder;
- every conceptual page receives a deterministic, unique `uid` while authored
  page metadata is preserved;
- TOC targets and unsafe paths generate structured diagnostics.

The public template/profile vocabulary does not require users to name a build
engine. The current static-project profile is implemented by one bundled
adapter and emits its required configuration. The normalized document,
navigation, identity and diagnostic model is intended to support additional
adapters later; complete renderer neutrality is not claimed.

### Wiki

Wiki output uses Markdown with GFM extensions plus a packaging adapter:

- `wiki` emits `Home.md` and `Navigation.md`;
- `hosted-wiki` flattens page names and emits sidebar/footer sidecars;
- `ordered-wiki` preserves folders and emits ordering files at every required level.

Internal page links, resources, collisions, and source links are rewritten for
their final locations. The portable profile avoids engine-specific metadata blocks
and host-only syntax, but GFM-extension support and final portability still
depend on the destination host.

### Static HTML

The HTML profile works without a CDN or build tool. It provides:

- one escaped page per annotation, safe pages for selected technical
  documents, and a responsive linked catalogue;
- `lang`, descriptive titles, skip link, landmarks, logical headings,
  keyboard-visible focus, dark mode, and reduced-motion support;
- a local stylesheet and a restrictive CSP placed before resources;
- no JavaScript, inline event handler, remote font, or trusted raw annotation
  HTML.

Serve `docs/annotations/html/` through any static HTTP server. For a release
gate, combine an HTML validator, link checker, automated accessibility audit,
and manual keyboard pass. Automated checks alone cannot establish full WCAG
conformance; the target is [WCAG 2.2 AA](https://www.w3.org/TR/WCAG22/).

### API contract and catalogue

The safe default is a constrained catalogue-only OpenAPI projection with the
annotations in an `x-ooci-annotation-catalog` extension and a reusable schema
component.

Documentation Studio **never infers routes from annotation prose or tags**.

To add routes, create the optional JSON file configured by
`annotation.docs.openapiProfilePath`. Bind each operation to an existing,
unique annotation ID and provide the path, method, `operationId`, parameters,
and responses explicitly. Use
[`schemas/openapi-profile.schema.json`](../schemas/openapi-profile.schema.json)
or copy
[`docs/templates/openapi-profile.example.json`](./templates/openapi-profile.example.json).

The profile implements a documented, deliberately constrained subset rather
than every OpenAPI feature. The parser treats that workspace file as untrusted
data: it does not invoke getters, rejects cycles/non-JSON values/dangerous keys/
external references, and omits an invalid operation atomically. The semantic
pass checks local
`$ref` values, unique `operationId` values, duplicate path/method pairs,
required path parameters, response objects, and security references. Boolean
JSON Schemas are supported as required by OpenAPI 3.1 / JSON Schema 2020-12.
The default serializer targets `3.2.0`; a profile can request `3.1.2` for
compatibility, with unsupported 3.2-only fields rejected or omitted. See the
official [OpenAPI 3.2.0 specification](https://spec.openapis.org/oas/v3.2.0.html).

## Safe writes and diagnostics

Generation is serialized: a watch request arriving during another run is
executed afterwards. An empty annotation store still generates an empty bundle
so deleting the final annotation cannot leave stale documentation behind.

Every run is staged before installation. Existing affected files are moved to
a transaction backup; if a write fails, installed files are removed and the
backup is restored. The manifest is the final commit marker. On a later run,
only stale files listed by a valid previous manifest are removed; unrelated
files in the output directory are preserved. Output and template paths reject
absolute paths, traversal, empty segments, Windows-unsafe characters, and
case-insensitive collisions.

`documentation-report.json` is machine-readable input consumable by CI. It
contains the selected profiles and every info/warning/error diagnostic. The
extension does not install a CI gate by itself. Renderer errors never cause
route guessing or an unsafe fallback; inspect the report before publishing.

## Settings

| Setting                                                | Purpose                                                                                  |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `annotation.docs.outputPath`                           | Non-empty managed output folder inside the workspace                                     |
| `annotation.docs.template`                             | Built-in template ID or `custom`                                                         |
| `annotation.docs.customTemplatePath`                   | Workspace-owned JSON preset; teams may commit it when desired                            |
| `annotation.docs.formats`                              | Optional renderer override                                                               |
| `annotation.docs.documents`                            | Optional technical-document override                                                     |
| `annotation.docs.language`                             | Canonical `language[-Script][-REGION]` subset, for example `en`, `fr-CA` or `zh-Hant-TW` |
| `annotation.docs.openapiProfilePath`                   | Optional explicit OpenAPI bindings                                                       |
| `annotation.docs.siteTitle`                            | Portal title                                                                             |
| `annotation.docs.tagPrefix`                            | Documentation role prefix, default `doc:`                                                |
| `annotation.docs.apiFolder` / `guideFile`              | Authored page layout overrides                                                           |
| `annotation.docs.includeInventory` / `includeAuthored` | Structure overrides                                                                      |
| `annotation.docs.includeTimestamp`                     | Human timestamp vs fully diffable output                                                 |
| `annotation.docs.pageMetadata`                         | Additional portable Markdown page-metadata preference                                    |
| `annotation.docs.watch`                                | Debounced regeneration after store changes                                               |

For authoring syntax and role placement, continue with
[Authoring documentation from annotations](./documentation-authoring.md).
