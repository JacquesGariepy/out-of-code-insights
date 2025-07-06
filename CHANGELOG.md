# Changelog


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
