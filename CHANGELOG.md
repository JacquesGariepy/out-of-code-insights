# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

(no entries yet)

## [1.0.19] - 2026-05-06

### Fixed
- Annotations now follow code through cut, paste, move, and refactor
  operations instead of being deleted or left orphaned. Introduces a
  transactional annotation store and reanchoring across edits.

## [1.0.18] - 2026-05-04

First release prepared for open-source distribution under MPL-2.0.
No user-facing functional changes; the focus is licensing,
security, infrastructure, and documentation.

### Added
- **MPL-2.0 license**: full Mozilla Public License v2.0 text in
  `LICENSE`; `package.json` `license` field set to `MPL-2.0`.
- **Governance files**: `CONTRIBUTING.md`, `SECURITY.md`,
  `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), GitHub issue
  and pull-request templates.
- **Dev tooling**: ESLint (`@typescript-eslint/recommended`),
  Prettier, EditorConfig, npm scripts for `lint`, `format`,
  `typecheck`, `test`, and `package:vsix`.
- **Test infrastructure**: Mocha + `@vscode/test-electron`
  scaffold with five integration smoke tests covering activation,
  command registration, and the annotation persistence round-trip.
  Test workspace fixtures live in `test-fixtures/`.
- **Continuous integration**: GitHub Actions workflow running
  typecheck + lint + production webpack build, then the
  integration suite on Ubuntu, Windows, and macOS (Node 20).
- **Documentation**: `docs/ROADMAP.md` (ten proposed features
  with effort estimates), `docs/ai-features.md` (consolidated AI
  user guide), `docs/llm-providers.md`, `docs/architecture.md`,
  `docs/README.md` index. Project `README.md` gains explicit
  Requirements, Known Issues, Changelog, License (MPL-2.0
  named), Further Reading, and Contribution sections.
- **Repository hygiene**: `Dependabot` configuration for npm and
  GitHub Actions; `CODEOWNERS`; restructured `.gitignore` and
  `.vscodeignore` grouped by purpose.
- **Structured logger**: `src/utils/logger.ts` -- typed
  `LogOutputChannel` (VS Code 1.74+) plus a size-rotating file
  logger written to `context.logUri`. Default level `info`,
  configurable via `outOfCodeInsights.logLevel`. Command
  `outOfCodeInsights.showLogs` opens a QuickPick to show the
  output channel, open the log file in the editor, or reveal the
  log folder in the OS explorer.
- **Shared `.vscode/` debug configuration**: `launch.json`
  (three launch configs including "with test workspace" and
  `--disable-extensions` for test isolation), `tasks.json`
  (webpack watch with corrected background-task patterns),
  `settings.json` (local TypeScript SDK, format-on-save, ESLint
  auto-fix, explorer and search exclusions), `extensions.json`
  (eslint, prettier, tsl-problem-matcher, test-runner). All four
  files committed via `.gitignore` negation rules.

### Changed
- **TypeScript upgraded** from 4.9 → 5.9 (a transitive dependency
  ships typings using TS 5+ syntax).
- **`tsconfig.json`** hardened: `noImplicitReturns`,
  `noFallthroughCasesInSwitch`, `forceConsistentCasingInFileNames`.
- **i18n**: package.json setting descriptions translated from
  French to English; residual French strings, comments, and
  webview fallback messages translated. The `Français` entry in
  the language picker is retained as the localised label.
- **Package metadata**: `repository`, `homepage`, and `bugs`
  URLs point to the new `out-of-code-insights` GitHub repository.

### Fixed
- **No-workspace activation**: opening the extension without a
  workspace folder no longer crashes. `getProjectAnnotationsPath`
  returns `null`, persistence becomes a no-op, and annotations
  reload automatically when a folder is added via
  `onDidChangeWorkspaceFolders`.
- **Path traversal**: custom `annotation.path` is canonicalised
  and refuses to resolve outside the workspace root.
- **JSON schema validation**: annotation files imported from
  disk are now schema-validated before being applied.
- **Webview Content-Security-Policy**: the annotations panel,
  links view, and Kanban webviews ship a strict CSP and consume
  resources via `webview.asWebviewUri`.
- **Process environment**: removed an unsafe mutation of
  `process.env` from the AI provider initialisation path.
- **Activation blocking prompts**: `activate()` no longer awaits
  any UI interaction. `promptForAiSuggestOption`,
  `promptForUsername`, and `configureProviderAndKeys` were
  removed from the activation critical path. AI provider setup is
  now lazy via `ensureAiConfigured()`, which is called only when
  the user invokes an AI command for the first time.
- **Kanban and modal inline event handlers**: `ondragstart`,
  `ondragend`, `ondrop`, `ondragover`, `ondragleave` on Kanban
  cards and columns, plus `onclick` on the Add Column and modal
  buttons, were blocked by the nonce-based CSP. All converted to
  `document.addEventListener` delegation inside the
  nonce-protected `<script>` block. Includes a `dragleave`
  fix that prevents the drop-target highlight from flickering
  when hovering over child elements.

### Removed
- **Orphan code**: `src/providers/ClaudeCodeAdapter.ts` (386
  lines, never imported) deleted; superseded by
  `UnifiedAIAdapter`.
- **VS Code proposed API**: `vscode.proposed.inlineCompletionsAdditions.d.ts`
  and the matching `enabledApiProposals` entry removed; the API
  was declared but never used, and its presence would block
  Marketplace publication.
- **Internal preparation documents**: audit reports, debug
  notes, design mockups, and the legacy `package_new.json` were
  removed from the repository.
- **Tracked build artifacts**: `dist/extension.js` and its
  source maps are no longer tracked in git (they were force-added
  despite being in `.gitignore`).
- **Dead `test:integration` script**: referenced a non-existent
  file; replaced by the new `test` script.

### Security
- All findings raised by the open-source readiness audit (XSS,
  CSP gaps, path traversal, schema-less import, environment
  mutation) have been addressed prior to publication.

## 1.0.17 - Localization & UI Improvements (2025-01-17)

### 🌍 Localization Enhancements
- **Dynamic Language Switching**: Added language selection in extension settings (English/French)
- **Complete UI Localization**: All UI text now properly externalized to language files
- **Fixed Mixed Language Issues**: Resolved hardcoded French text appearing in English mode
- **Fallback Language Consistency**: All fallback texts now use English as base language

### 🐛 Bug Fixes
- **Fixed Context Menu Commands**: Resolved issue where "Move Up" and "Move Down" commands were not working in context menus
- **Fixed JavaScript Errors in Webview**: Made all JavaScript functions global to prevent "function not defined" errors
- **Fixed Localization Loading**: Corrected LocalizationManager to properly handle language switching
- **Fixed Command Visibility**: Changed command handler methods from private to public for proper access

### 💻 Technical Improvements
- **LocalizationManager**: New centralized system for handling dynamic language switching
- **Command Architecture**: Improved command wrapper methods for context-aware operations
- **Webpack Configuration**: Added externals for optional WebSocket dependencies
- **Error Handling**: Better error messages with proper localization support

### 🎨 UI/UX Improvements
- **Consistent Language Display**: All UI elements now respect the selected language setting
- **English as Default**: Set English as the default language per user preference
- **Improved Button Labels**: Fixed button text to use proper localization keys
- **Better Error Messages**: Localized error messages for better user experience

## 1.0.16 - Bug Fix Release

### 🐛 Bug Fixes
- **Fixed EROFS Error**: Resolved issue where relative paths in `annotation.path` configuration were incorrectly treated as absolute paths, causing "read-only file system" errors when trying to create directories at the root filesystem. Now properly resolves relative paths relative to the workspace folder.
- **Fixed "command not found" errors**: Commands are now always registered even if initialization fails, preventing "command 'annotations.add' not found" errors
- **Improved error handling**: Added graceful degradation with helpful error messages when extension initialization fails
- **Better user experience**: Users now see actionable error messages with retry options instead of cryptic command errors

## 1.0.15 - AI Enhancement & Profile System Update

### 🤖 New AI Features

#### Multi-LLM Provider Support
- **Universal AI Integration**: Support for all major LLM providers (OpenAI, Anthropic, Google, Mistral, etc.)
- **Seamless Provider Switching**: Change LLM providers without losing functionality or custom profiles
- **Automatic Fallback**: Graceful handling when providers don't support certain features
- **Provider-Specific Optimization**: Tailored prompts for each provider's strengths

#### Custom AI Profile System
- **Create Custom AI Profiles**: Design specialized AI profiles for specific analysis needs
- **Profile Management UI**: Intuitive interface for creating, editing, and deleting AI profiles
- **Import/Export Profiles**: Share custom profiles with team members
- **Hot-reload Support**: New profiles available immediately without restart
- **Profile Components**:
  - Custom analysis prompts
  - Default tags and severity levels
  - Annotation prefix customization
  - Priority settings

#### Enhanced Profile Selection
- **Unified Profile Selector**: Shows both user profiles and AI profiles in one interface
- **Visual Indicators**: Different icons for user profiles ($(account)) and AI profiles ($(star))
- **Quick Create Option**: Create new profiles directly from the selection dialog
- **Profile Synchronization**: AI profiles automatically sync when user profile changes

#### Cumulative Custom Prompts
- **Additional Context**: Add custom instructions to any AI analysis
- **Prompt Stacking**: Custom prompts enhance rather than replace profile prompts
- **Context Preservation**: Maintains profile-specific behavior while adding custom requirements
- **Interactive Prompting**: Optional dialog for adding custom instructions during analysis

### 🛠️ Technical Improvements

#### Line Number Accuracy
- **Fixed Line Number Mapping**: Annotations now correctly target the analyzed line
- **1-based to 0-based Conversion**: Proper handling of VSCode's internal line numbering
- **Context-Aware Positioning**: Better handling of multi-line code analysis

#### File Path Handling
- **Relative Path Support**: Improved portability across different systems
- **Cross-Platform Compatibility**: Normalized path handling for Windows/Mac/Linux
- **Workspace-Aware Paths**: Correct resolution of paths within multi-root workspaces

#### AI Provider Robustness
- **Initialization Checks**: Ensures AI provider is ready before operations
- **Error Recovery**: Better error messages and recovery options
- **API Key Management**: Direct navigation to settings when API keys are missing
- **Event-Driven Updates**: Profile changes propagate immediately through the system

### 🎨 UI/UX Enhancements

#### Context Menu Organization
- **AI Analysis Submenu**: All AI features grouped under dedicated submenu
- **Profile Management Access**: Quick access to profile management from right-click menu
- **Conditional Visibility**: AI options only show when AI features are enabled
- **Hierarchical Organization**: Logical grouping of related commands

#### Approval Dialogs
- **Pre-Analysis Confirmation**: Modal dialogs before sending code to AI
- **File Information Display**: Shows filename, line count, and language before analysis
- **Profile Confirmation**: Displays selected profile in confirmation dialog
- **Batch Analysis Scope**: Clear indication of what will be analyzed

### 🐛 Bug Fixes
- Fixed custom AI profiles not appearing after creation
- Resolved TypeScript compilation errors with multi-llm-ts integration
- Fixed profile synchronization issues during provider switching
- Corrected event listener cleanup on extension disposal
- Fixed race conditions in profile loading during initialization
- Fixed "Select User Profile" command to show both user profiles and custom AI profiles
- Enhanced profile selector to display all available profiles with visual indicators

### 📚 Documentation
- Added comprehensive multi-LLM support documentation
- Created AI profile creation guide with examples
- Updated troubleshooting section for common AI issues
- Added provider-specific optimization tips

### 🔄 Breaking Changes
- None - Full backward compatibility maintained

### 🚀 Batch Creation System (NEW!)
- **Batch Create Mixed Items**: Create multiple templates, links, and snippets in one workflow
- **Template Batch Creation**: Create multiple annotation templates at once
- **Link Batch Creation**: Link multiple annotations together in groups
- **Snippet Batch Creation**: 
  - Create snippets from current selection
  - AI-powered snippet generation from prompts
  - Manual snippet creation with multiple entries
- **Mixed Creation Mode**: Select any combination of items to create

### 🔮 Coming Soon
- Team profile sharing via cloud sync
- Advanced prompt engineering UI
- Enhanced AI snippet generation with more context


## 1.0.14 - Major Feature Release

###  New Major Features

####  Linked Multi-File Annotations
- **Create relationships** between annotations across different files
- **Visual indicators** with  icons in TreeView for both source and target annotations
- **Smart navigation** with `Ctrl+Alt+L` for quick jumping between linked annotations
- **Relationship types**: implements, references, depends-on, blocks, duplicates, related
- **Bidirectional linking**: Target annotations also show link indicators and navigation options
- **Interactive visualization**: "Show All Links" command opens comprehensive webview with statistics
- **Link management**: Easy creation, navigation, and deletion of annotation relationships

####  Customizable Annotation Templates
- **Pre-built templates**: Bug, TODO, Refactor, Performance, Security, Documentation, Question
- **Variable substitution**: Use `{{variableName}}` placeholders for dynamic content
- **Custom templates**: Create team-specific templates with custom variables and formatting
- **Template application**: `Ctrl+Shift+Alt+T` to quickly apply templates and create annotations
- **Template management**: Full CRUD operations for custom templates
- **Consistency**: Standardize annotation format across teams and projects

####  Smart Review Mode
- **Systematic review**: Navigate through annotations sequentially with `F8`/`Shift+F8`
- **Advanced filtering**: Filter by author, date range, severity, tags, and resolution status
- **Progress tracking**: Visual progress bar showing reviewed vs. total annotations
- **Review statistics**: Comprehensive metrics on annotation distribution and completion
- **Mark as viewed**: Track which annotations have been reviewed
- **Session management**: Start/stop review sessions with summary reports

####  Kanban-style Workspace
- **Visual board**: Drag & drop annotations between customizable columns
- **Default columns**: To Do, In Progress, Review, Done (fully customizable)
- **Smart filtering**: Filter by author, severity, tags, or file
- **Intelligent deletion**: Choose to remove from kanban only or delete annotation completely
- **Column management**: Add, rename, delete custom columns for workflow optimization
- **Real-time updates**: Changes sync immediately across all views
- **Quick navigation**: Double-click cards to jump to code location

####  Executable Code Snippets
- **Code attachment**: Attach reusable code snippets to annotations
- **Variable support**: Use `$1`, `$2`, `${1:placeholder}` for dynamic placeholders
- **Preview functionality**: See changes before applying snippets
- **Multi-language support**: Code snippets for all programming languages
- **Execution history**: Track applied snippets for better code management
- **Snippet application**: Apply attached snippets directly from annotation context

###  Enhanced Existing Features

#### TreeView & Navigation Improvements
- **Enhanced tooltips**: Show link count, relationships, and connection details
- **Bidirectional indicators**: Both source and target annotations display  icons
- **Navigation stack**: Revisit last 10 annotations with `Alt+Left`/`Alt+Right`
- **Improved context menus**: Access all features directly from TreeView
- **Better visual feedback**: Clear indication of annotation states and relationships

#### UI/UX Improvements
- **Toggle display icon**: Changed to eye icon (`$(eye)`) for better intuitiveness
- **Interactive links**: All file paths and annotation references are clickable
- **Improved responsiveness**: Better performance with large annotation sets
- **Consistent theming**: Dark/light mode support across all new features

#### Kanban Enhancements
- **Column synchronization**: Kanban columns sync with menu options
- **Drag & drop fixes**: Smooth annotation movement between columns
- **File navigation**: Click annotation cards to open files at exact line
- **Delete options**: Smart choice between removing from kanban vs. complete deletion
- **Column persistence**: Custom columns saved across VS Code sessions

#### Link System Overhaul
- **Error fixes**: Resolved "Target annotation not found" errors
- **Improved UX**: Clear options for linking to existing vs. creating new annotations
- **Link visualization**: Comprehensive webview showing all relationships with statistics
- **Smart detection**: Automatic detection of incoming and outgoing links
- **Better navigation**: Enhanced link traversal with context and preview

###  Bug Fixes & Stability
- **Link creation**: Fixed line number conversion issues between 0-based and 1-based indexing
- **Command conflicts**: Resolved duplicate command registration errors
- **View management**: Fixed TreeView item context value assignments
- **Template variables**: Corrected TypeScript errors in template variable handling
- **Kanban updates**: Fixed real-time synchronization between views
- **Navigation accuracy**: Improved file opening and line positioning precision

###  Developer Experience
- **Comprehensive documentation**: Updated README with practical examples and best practices
- **Troubleshooting guide**: Added common issues and solutions section
- **Quick start guide**: Step-by-step workflow for new users
- **Template examples**: Pre-built templates for common development scenarios
- **Best practices**: Team collaboration and workflow recommendations

###  Technical Improvements
- **Code organization**: Separated features into dedicated manager classes
- **Error handling**: Improved error messages and user feedback
- **Performance**: Optimized annotation loading and display for large projects
- **Memory management**: Better cleanup and resource management
- **Type safety**: Enhanced TypeScript definitions and error prevention

This release represents a major evolution of Out-of-Code Insights, transforming it from a simple annotation tool into a comprehensive code collaboration and project management platform.

## 1.0.13
- Improved **Toggle Annotation Display** button: now toggles the display of all annotations at once, ensuring no duplicates appear in the page.
- Fixed a bug where some annotations could appear twice in the panel.
- UI improvements to the annotation panel for better clarity and usability.
- Fix import of annotations, ensuring all annotations are correctly imported.

## 1.0.12
- Added **Edit Annotation Tags** command to categorize annotations with custom tags.
- Tags are now displayed in the annotation panel and can be modified anytime.
- Updated localization and documentation for the new feature.

## 1.0.11
- Added **Set Annotation Severity** command to update the severity of an existing annotation.
- New **Default Severity** setting to choose the default level for new annotations.
- Added **Annotation Severity** to the annotation view.
- Fixed issue, annotations were not being displayed correctly in the page.

## 1.0.10
- Bug fixes

## 1.0.9
- Update OpenAI Key & Reset OpenAI Key in VSCode secret storage (ex.: Ctrl+Shift+P -> Reset OpenAI Key)

## 1.0.8
- Bug fixes
- Added  **Setting for desactivating** the AI suggest annotation.
- Added **AI Suggest Annotation** with Github Copilot integration.
- Added **Path to annotations file** in the settings.

## 1.0.7
- Bug fixes
- Indicate in readme how to reset OpenAI key in VSCode secret storage

## 1.0.6
- Added **AI Suggest Annotation** with OpenAI integration.
- Added **Configure AI Provider and Keys** feature to switch between OpenAI and Copilot.
- Updated **Extension Configuration** to include AI provider and model settings.
- Added **Batch Edit Annotations** feature to modify multiple annotations simultaneously.
- Implemented **Keyword Search in Annotations** for quick retrieval using specific keywords.
- Added **Filter Annotations by Severity** to categorize annotations based on importance levels.
- Added **Toggle Annotation Pin** to pin/unpin important annotations.
- Introduced **Convert Annotation to GitHub Issue** to transform annotations into GitHub issues.
- Added **Export Annotations to JSON** feature for sharing or backup.
- Implemented **Import Annotations from JSON** to restore annotations from a JSON file.
- Added **Auto-Resolve Stale Annotations** to automatically handle outdated annotations.

## 1.0.5
- Bug fixes

## 1.0.4
- Documentation in the README.md file

## 1.0.3
- Added Activity Bar view for annotations (thanks to https://www.reddit.com/user/gus_morales/ for the suggestion!).
- Improved localization handling

## 1.0.2
- Added retry mechanism for WebView content updates
- Improved initialization process with Promise-based waiting
- Updated French localization system implementation
- Enhanced annotation navigation

## 1.0.1
- Fixed issue where annotations with invalid line numbers caused initialization errors
- Added validation during annotation loading to remove invalid annotations
- Enhanced error handling and logging for better debugging
- Add, view, and delete annotations
- Track changes in files
- Support for multiple languages (English, French)
- Annotation threading and commenting system

## 1.0.0
- Initial release
