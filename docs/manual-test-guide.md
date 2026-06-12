# Guide de test — v1.0.21, v1.0.22 et branche `feat/pro-saas-mcp`

Validation manuelle de toutes les fonctionnalités livrées depuis la v1.0.21, organisée par version.
Complément du [manual-test-checklist.md](manual-test-checklist.md) (14 cas d'ancrage §7.x, toujours valides).

**Couverture automatisée** : chaque section référence la suite qui couvre déjà le scénario.
`npm run test:unit` (457 tests purs, < 1 s) · `npm test` (375+ tests dans un vrai VS Code, ~3 min) ·
`cd license-server && npm test` (51 tests) · CI GitHub Actions sur Ubuntu/Windows/macOS.

## Préparation

1. `npm install && npm run compile`, puis **F5** (Extension Development Host) — ou `npm run package:vsix` et installer le `.vsix`.
2. Dans la fenêtre EDH, ouvrir un dossier de travail jetable.
3. Avant chaque scénario : commande `Clear All Annotations` (ou supprimer `.out-of-code-insights/annotations.json`).
4. Panneau **Out-of-Code Insights** visible dans l'activity bar.

---

## v1.0.21 — robustesse du suivi de position

| #   | Scénario                    | Étapes                                                                                                         | Attendu                                                                                                                      | Auto                           |
| --- | --------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 1.1 | Édition de la ligne annotée | Annoter une ligne ; taper/supprimer des caractères au début, au milieu, à la fin (plusieurs frappes d'affilée) | Gutter + surlignage + texte inline restent attachés à la ligne                                                               | lot8, unit `sticky boundaries` |
| 1.2 | Cut+paste intra-fichier     | Annoter ; `Ctrl+X` la ligne ; coller ailleurs dans le fichier                                                  | L'annotation suit (même id), pas de doublon                                                                                  | lot7 B/D/E/F                   |
| 1.3 | Cut+paste inter-fichiers    | `Ctrl+X` dans A ; coller dans B                                                                                | L'annotation migre vers B                                                                                                    | unit `inter-file recovery`     |
| 1.4 | Copy+paste                  | `Ctrl+C` la ligne annotée ; coller ailleurs                                                                    | Original inchangé + UNE copie au collage                                                                                     | lot7 A/C                       |
| 1.5 | Undo/redo                   | Après 1.2 : `Ctrl+Z` puis `Ctrl+Shift+Z`                                                                       | Position restaurée, jamais plus d'une annotation                                                                             | unit `undo/redo`               |
| 1.6 | Suppression du code annoté  | Supprimer la ligne annotée, attendre la fenêtre de récupération (30 s)                                         | Toast « Le code de l'annotation … a été supprimé. Conserver ? » — _Conserver_ la remet dans le panneau, _Supprimer_ l'efface | unit `onDidDispose`            |

## v1.0.22 — génération de documentation + cycle de vie

| #   | Scénario                 | Étapes                                                                                                                                                                    | Attendu                                                                                                                                                                     | Auto                        |
| --- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| 2.1 | Doc inventaire           | Créer 2-3 annotations (tags + sévérités variés) ; icône 📖 de la vue ou commande `Generate Annotation Documentation` ; « Open »                                           | `docs/annotations/` : `toc.yml`, `index.md` (compteurs par type/sévérité/fichier), `by-type.md`, `by-file.md` (liens source `fichier:ligne` cliquables, ancres), `links.md` | lot10, unit DocGenerator    |
| 2.2 | Doc rédigée `doc:*`      | Commande `Add Documentation Annotation` → rôle _Class_ sur une ligne `class X` ; idem _Function_ sur une méthode ; _Example_ dessous ; message en Markdown avec `# Titre` | Page `api/<fichier>.md` : classe `##`, fonction `###` imbriquée, exemple `####`, signature extraite de la ligne, titres internes démotés                                    | lot10 doc:\*, unit authored |
| 2.3 | Wiki-links               | Dans un message doc : `[[TitreAutreEntrée]]` ; régénérer                                                                                                                  | Lien résolu inter-pages ; lien introuvable → section « Generation warnings » sur l'index                                                                                    | unit wiki-links             |
| 2.4 | Configurabilité          | Settings : `annotation.docs.siteTitle`, `tagPrefix`, `apiFolder`, `guideFile`, `includeInventory:false`, `includeTimestamp:false`, `untaggedLabel` ; régénérer            | Chaque réglage respecté ; sans timestamp la sortie est diffable                                                                                                             | unit configurable output    |
| 2.5 | Git pull / branche       | Annoter ; fermer le fichier ; le modifier hors VS Code (insérer 3 lignes en tête) ; rouvrir                                                                               | L'annotation se ré-ancre sur la ligne décalée                                                                                                                               | lot9 gitpull                |
| 2.6 | Suppression de fichier   | Supprimer (explorer) un fichier annoté                                                                                                                                    | Prompt « N annotation(s) référencent le fichier supprimé … Conserver ? »                                                                                                    | lot9 delete                 |
| 2.7 | Rename de fichier        | Renommer (explorer) un fichier annoté                                                                                                                                     | L'annotation suit le nouveau nom                                                                                                                                            | lot9 rename                 |
| 2.8 | Gestes d'édition avancés | Multi-curseurs, Replace All, Format Document (re-indentation), Alt+↓                                                                                                      | L'annotation suit dans chaque cas                                                                                                                                           | lot9                        |
| 2.9 | Fenêtre de récupération  | Setting `annotation.cutRecoveryWindowSeconds: 10` ; couper sans coller 10 s                                                                                               | Prompt après ~10 s (au lieu de 30)                                                                                                                                          | unit updateSuspendTtl       |

## Branche `feat/pro-saas-mcp` (non releasée)

### Extension

| #   | Scénario                      | Étapes                                                                                                                                                                              | Attendu                                                                                                                                        | Auto                             |
| --- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 3.1 | Éditeur Markdown              | `Edit Annotation Message (Markdown)` (palette) → choisir une annotation                                                                                                             | Panel avec textarea pré-rempli ; `Ctrl+Enter` sauve, `Échap` annule                                                                            | — (manuel)                       |
| 3.2 | Styles par sévérité/tag       | Settings `annotation.severityStyles: {"error":{"annotationColor":"#ff5555"}}` et `annotation.tagStyles` ; annoter avec cette sévérité                                               | Décoration colorée ; le 1er tag stylé prime sur la sévérité                                                                                    | unit annotationStyle             |
| 3.3 | Watch doc                     | `annotation.docs.watch: true` ; modifier une annotation                                                                                                                             | `docs/annotations/` régénéré (~2 s, silencieux)                                                                                                | — (manuel)                       |
| 3.4 | Import commentaires (fichier) | Fichier avec `// ! danger`, `// TODO: x`, `# FIXME y` ; `Import Code Comments as Annotations`                                                                                       | Annotations taguées (`alert`/`todo`/`fixme` + `imported-comment`), sévérités mappées ; relancer = 0 doublon                                    | lot11, unit commentScanner       |
| 3.5 | Import workspace              | `Import Code Comments from Workspace`                                                                                                                                               | Notification de progression annulable ; toast récapitulatif                                                                                    | lot12                            |
| 3.6 | Watcher externe               | VS Code ouvert ; modifier `annotations.json` avec un autre outil (ou le MCP, cf. 3.8)                                                                                               | Le panneau reflète le changement en ~2 s sans reload ; `annotation.watchExternalChanges:false` le désactive                                    | lot13                            |
| 3.7 | Sync cloud                    | Démarrer le license-server (cf. 4.x) ; settings `annotation.sync.serverUrl`/`workspaceId` ; `Configure Annotation Sync` (token = clé licence) ; `Sync Annotations Now` sur 2 clones | Status bar ☁ ; push/pull ; modifier des deux côtés → prompt conflit « Keep local / Take remote »                                               | unit syncPlan + 51 tests serveur |
| 3.8 | MCP                           | `MCP Server Setup` → copier la config Claude Code ; `claude mcp add …` ; demander à l'AI d'annoter un fichier                                                                       | L'annotation apparaît dans VS Code (~2 s, via 3.6) sans modification du code source ; `code_graph` et `generate_docs` utilisables              | smoke stdio documenté            |
| 3.9 | Licence/pro                   | `annotation.pro.gatedFeatures: ["docs.watch"]` sans licence → activer le watch                                                                                                      | Toast « Pro feature — enter your license key » une fois, puis skip silencieux ; après `Enter License Key (Pro)` avec une clé valide → débloqué | unit licenseManager              |

### license-server (terminal)

```bash
cd license-server && npm install && npm test          # 51/51
$env:LICENSE_SECRET='un-secret-fort'                  # PowerShell
node dist/src/cli.js issue --entitlements sync,pro --days 30   # → clé OOCI.xxx
$env:PORT='8787'; node dist/src/server.js
# Contrat extension :
#   POST /v1/validate {key, product} → {valid:true, entitlements:[sync,pro], expiresAt}
# Sync (Bearer = la clé) : PUT If-Match:0 → {version:1} ; GET → {version:1} ; PUT If-Match:0 → 409
# Révocation : node dist/src/cli.js revoke <keyId> → validate passe à valid:false
# Stripe : STRIPE_WEBHOOK_SECRET=whsec_xxx + webhook checkout.session.completed
#          → clé émise (idempotent par event), node dist/src/cli.js issued pour la livrer
```

---

## Compatibilité Markdown de la documentation générée

Le contenu des messages est inséré tel quel (passthrough) : tout ce que le **renderer** cible supporte fonctionne.

| Capacité                                                       | Support        | Notes                                                                        |
| -------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------- |
| GFM (tableaux, listes à cocher, barré, autolinks, emoji)       | ✅ passthrough | Rendu par GitHub, VS Code, DocFX                                             |
| Blocs de code fencés + langage                                 | ✅             | Protégés de la démotion/wiki-links                                           |
| Math display `$$…$$` (arXiv/GitHub/DocFX-math) et inline `$…$` | ✅             | Blocs `$$` protégés de toute réécriture                                      |
| Diagrammes Mermaid                                             | ✅ passthrough | Fence ` ```mermaid ` protégé                                                 |
| Alerts GFM `> [!NOTE]`                                         | ✅ passthrough |                                                                              |
| TOC DocFX (`toc.yml`, imbriquée)                               | ✅ généré      | Pointer un projet DocFX sur le dossier                                       |
| Front matter YAML (`title:`)                                   | ✅ opt-in      | `annotation.docs.frontMatter` (off par défaut : GitHub l'affiche en tableau) |
| Démotion de titres, ancres stables, wiki-links, warnings       | ✅ généré      |                                                                              |
| DFM avancé (`[!include]`, `<xref:…>`, `uid:`)                  | ❌             | Non généré — roadmap si publication DocFX multi-projets                      |
