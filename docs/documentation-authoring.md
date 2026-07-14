# Authoring documentation from annotations

Out-of-Code Insights can assemble a multi-format documentation portal from your annotations — without ever
modifying the source files. This guide explains what to write, where it ends up, and how it is displayed.

## The model in one paragraph

There is no special annotation type. A **regular annotation becomes documentation when it carries a
`doc:*` tag** — the tag is the role, the message is the content (full Markdown). Annotations without a
`doc:*` tag still appear in the inventory pages (by-type/by-file/links) but not in the authored API pages.

## Creating a documentation annotation

Three equivalent paths:

1. **Editor right-click menu**: choose **Out-of-Code Insights → Documentation →
   Add Documentation Annotation**, then pick an authored API/guide role or a
   technical-document role. The annotation is created on the current line with
   the right tag already applied. The Command Palette is an alternative.
2. **Any annotation + tag**: create a normal annotation, then `Edit Tags` and add `doc:class`,
   `doc:function`, `doc:method`, `doc:module`, `doc:example` or `doc:guide` (prefix configurable via
   `annotation.docs.tagPrefix`).
3. **MCP / programmatic**: `add_annotation` with `tags: ["doc:function"]` — an AI agent can author the
   documentation for you.

Use **`Edit Annotation Message (Markdown)`** to write multi-line Markdown comfortably.

## The roles

| Tag                           | Role in the generated site                           | Placement rule                                                      |
| ----------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------- |
| `doc:module`                  | Opens the API page of its file (page title + intro)  | One per file (extras are reported as warnings)                      |
| `doc:class`                   | `##` section                                         | Owns every function documented **below it** in the same file        |
| `doc:function` / `doc:method` | `###` entry                                          | Nested under the nearest preceding `doc:class`, top-level otherwise |
| `doc:example`                 | `Example —` block with the annotation's code snippet | Attaches to the nearest preceding class/function (or the module)    |
| `doc:guide`                   | Section of the standalone guide page                 | Independent of any file structure                                   |
| `doc:readme`                  | Curated section in generated `README.md`             | Explicit content only; project claims are never inferred            |
| `doc:changelog`               | Entry in generated `CHANGELOG.md`                    | Requires explicit version/release and category tags                 |
| `doc:architecture`            | Section in `technical/architecture.md`               | Explicit architectural context                                      |
| `doc:adr`                     | One decision page plus the ADR index                 | Optional explicit proposed/accepted/rejected/superseded status      |
| `doc:onboarding`              | Section in `technical/onboarding.md`                 | Developer setup and first-task guidance                             |
| `doc:runbook`                 | Section in `technical/runbook.md`                    | Operational procedure or recovery guidance                          |
| `doc:reference`               | Grouped entry in `technical/reference.md`            | Explicit technical-reference content                                |

Placement follows **code proximity**: annotate the `class` line with `doc:class`, each method line with
`doc:function`, and the generator mirrors your code structure. Because annotations re-anchor when code
moves, the documentation follows refactorings.

## Writing the message

```markdown
# createUser ← first heading = entry TITLE (falls back to the first line)

Creates a user account. ← body: FULL Markdown
**Parameters**
| name | type |
| ---- | ---- |
| name | string |

$$ cost = O(n \log n) $$ ← display math passes through untouched
See [[UserService]] and [[Creating users]]. ← wiki-links to other entries
```

- The **first Markdown heading** becomes the entry title (and is stripped from the body); without one,
  the first line is used.
- The body supports **everything your renderer supports** (GFM tables, task lists, alerts `> [!NOTE]`,
  Mermaid fences, `$…$`/`$$…$$` math): content is inserted as-is. Headings inside the body are demoted
  so they nest under their section; fenced code and `$$` blocks are never rewritten.
- **`[[Title]]` wiki-links** resolve to the entry whose title matches (case-insensitive), across pages
  (API ↔ guide). Unresolved links stay verbatim and are listed under _Generation warnings_ on the index.
- The **signature** shown under each class/function entry is extracted automatically from the annotated
  source line — you do not write it.

## Generating and displaying

- **Configure**: right-click in the editor or an Annotations tree item, then
  choose **Documentation → Configure Documentation Studio**. Pick a built-in or
  workspace JSON preset that selects document kinds, bounded structure options,
  and source-page, static-project, Wiki, HTML, or API-catalogue output profiles.
- **Generate**: 📖 icon in the Annotations view or `Generate Annotation Documentation`; enable
  `annotation.docs.watch` to regenerate automatically on every annotation change. Output (default
  `docs/annotations/`) is staged, managed by `.ooci-docs-manifest.json`, and accompanied by
  `documentation-report.json` diagnostics. All names/sections are configurable through `annotation.docs.*`.
- **In the editor**, a documentation annotation looks like any annotation — gutter icon, line highlight,
  and an inline summary showing the **first line of the message** (heading marker stripped, capped). The
  full Markdown lives in the annotations panel, the Markdown editor, and the generated site.
- **Publishing**: the complete preset includes a publishable static project,
  hosted Wiki package, autonomous HTML site and constrained OpenAPI catalogue
  projection. See [Documentation Studio](./documentation-studio.md) for build,
  hosting, custom-template and CI instructions.

## End-to-end example

Annotate `src/user.ts`:

| Line                         | Tag            | Message                           |
| ---------------------------- | -------------- | --------------------------------- |
| `// user module header`      | `doc:module`   | `# User module` + intro paragraph |
| `export class UserService {` | `doc:class`    | `# UserService` + description     |
| `async createUser(name) {`   | `doc:function` | `# createUser` + params table     |
| (line below)                 | `doc:example`  | `# Basic usage` + snippet         |

Generate → `docs/annotations/api/src-user-ts.md`:

````markdown
# User module

_File_: `src/user.ts`
…intro…

## UserService

_Source_: [src/user.ts:2](…)

```ts
export class UserService {
```
````

…description…

### createUser

…params table…

#### Example — Basic usage

…snippet…

```

```
