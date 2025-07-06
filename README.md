# Out-of-code Insights [![Visual Studio Marketplace Downloads](https://img.shields.io/visual-studio-marketplace/d/JacquesGariepy.out-of-code-insights)](https://marketplace.visualstudio.com/items?itemName=JacquesGariepy.out-of-code-insights)

Out-of-code Insights is a Visual Studio Code extension that allows you to add annotations, comments, and notes **without modifying your source files**. It is ideal for avoiding clutter in your code with temporary comments or making the code unnecessarily heavy.

## 🌐 Connect with Me

You can find me on these platforms:

[![Github Badge](https://img.shields.io/badge/-0077B5?style=social&logo=github)](https://github.com/JacquesGariepy)
[![LinkedIn Badge](https://img.shields.io/badge/-0077B5?style=social&logo=linkedin)](https://linkedin.com/in/jacquesgariepy)
[![X Badge](https://img.shields.io/badge/-1DA1F2?style=social&logo=x)](https://X.com/jacquesgariepy)

We’d love to hear your thoughts, feedback, and ideas! Feel free to join the conversation on GitHub Discussions and connect with the community.

[![GitHub Discussions](https://img.shields.io/github/discussions/JacquesGariepy/out-of-code-insights)](https://github.com/JacquesGariepy/out-of-code-insights/discussions)



[![GitHub Discussions](https://img.shields.io/badge/buy_me_a_coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/jacquesgarx)

## Why use Out-of-code Insights?

- **Non-intrusive annotations**: Add comments without altering the source code, keeping your files clean and organized.
- **Optimized for code reviews**: Facilitate team communication by adding comments directly on the relevant lines.
- **Avoid code clutter**: Maintain clarity and readability of your code by avoiding unnecessary comments.
- **Annotations on all file types**: Add annotations to any file in your project, including source code, Markdown, JSON, XML, text, etc.
- **Intelligent change tracking**: Annotations automatically follow file changes as long as edits are made within Visual Studio Code.
- **Personalization**: Adapt the extension to your needs with various configuration options.
- **Threaded discussions**: Reply to annotations to create threads and enhance collaboration.
- **Advanced annotation management**: Move, filter, sort, and navigate annotations with ease.
- **Batch Edit Annotations**: Modify multiple annotations simultaneously to save time and effort.
- **Keyword Search**: Quickly find annotations by searching for specific keywords.
- **Filter by Severity**: Categorize and view annotations based on their severity levels.
- **Set Annotation Severity**: Assign severity levels (info, warning, error) to your annotations.
- **Show AI Suggestion**: Display simulated suggestions from AI.
- **Auto-Resolve Stale Annotations**: Automatically handle annotations that are no longer relevant or outdated.

[![Watch the video](https://github.com/user-attachments/assets/16cf301b-7eb1-480d-a616-ba4fae09a16f)](https://youtu.be/H6xjResrJzw)

![feature_add](https://github.com/user-attachments/assets/ea4d463e-a2d5-4eb4-85c8-04746533213f)
(`add in v1.0.3 - Activity bar`)

![binary file](https://github.com/user-attachments/assets/7096ade5-e84c-49f1-b7b3-1ae68f02b418)

(`PNG binary file`)

## Key Features

- **Add annotations**: Insert comments or notes on specific lines **without modifying the source file**, regardless of file type.
- **View and manage annotations**: See all your annotations in a dedicated panel, modify, delete, or reply to them.
- **Toggle annotation visibility**: Enable or disable annotation visibility in the editor.
- **Move annotations**: Drag annotations directly within the editor. Annotations follow their assigned lines; simply position above or below a line to move it.
- **CodeLens integration**: Manage annotations directly from the editor with CodeLens integration.
- **Filter and sort annotations**: Filter and sort annotations in the panel for efficient management.
- **Export and import**: Export your annotations to share or back them up, and import them into other projects.
- **Batch Edit Annotations**: Modify multiple annotations at once to streamline your workflow.
- **Keyword Search**: Quickly locate annotations by searching for specific terms or phrases.
- **Filter by Severity**: Organize annotations based on their severity to prioritize tasks.
- **Set Annotation Severity**: Assign severity levels (info, warning, error) to your annotations.
- **Edit Annotation Tags**: Add or modify tags on annotations to better categorize them.
- **Show AI Suggestion**: View simulated suggestions from AI to enhance your annotations.
- **Auto-Resolve Stale Annotations**: Automatically resolve annotations that are no longer relevant, keeping your workspace clean.
- **Navigation Stack**: Quickly jump back and forth between recently viewed annotations.

## ✨ Advanced Features (New in v1.0.14)

### 🔗 Linked Multi-File Annotations
Create relationships between annotations across different files to improve code traceability and documentation:
- **Create links**: Connect related annotations with contextual relationships (implements, references, depends-on, etc.)
- **Visual indicators**: 🔗 icon in TreeView shows linked annotations
- **Smart navigation**: `Ctrl+Alt+L` to quickly jump between linked annotations
- **Comprehensive visualization**: "Show All Links" command opens an interactive view with statistics and navigation

### 📋 Customizable Annotation Templates
Standardize your annotation format with reusable templates:
- **Pre-built templates**: Bug, TODO, Refactor, Performance, Security, Documentation
- **Custom templates**: Create your own with variable substitution (`{{description}}`, `{{priority}}`, etc.)
- **Quick access**: `Ctrl+Shift+Alt+T` to apply templates instantly
- **Team consistency**: Share templates across your development team

### 🔍 Smart Review Mode
Systematically review annotations with advanced filtering and tracking:
- **Structured review**: Navigate through annotations sequentially with `F8`/`Shift+F8`
- **Advanced filtering**: Filter by author, date, severity, tags, and status
- **Progress tracking**: Visual progress bar shows reviewed vs. total annotations
- **Review statistics**: Get insights on annotation distribution and completion

### 📋 Kanban-style Workspace
Manage annotations visually with a dedicated Kanban board:
- **Visual organization**: Drag & drop annotations between customizable columns (To Do, In Progress, Review, Done)
- **Smart filtering**: Filter by author, severity, tags, or file
- **Intelligent deletion**: Choose to remove from kanban or delete completely
- **Custom columns**: Create workflow-specific columns for your team
- **Quick navigation**: Double-click cards to jump to code location

### ⚡ Executable Code Snippets
Attach and execute code directly from annotations:
- **Code attachment**: Add reusable code snippets to annotations
- **Preview changes**: See modifications before applying them
- **Variable support**: Use placeholders (`$1`, `$2`) for dynamic snippets
- **Execution history**: Track applied snippets for better code management
- **Multiple languages**: Support for all programming languages

## Installation

1. **Open Visual Studio Code**.
2. **Access the Extensions Manager**:
   - Click the Extensions icon in the sidebar.
   - Or use the shortcut `Ctrl+Shift+X` (`Cmd+Shift+X` on Mac).
3. **Search for the extension**:
   - Type **"Out-of-code Insights"** in the search bar.
4. **Install the extension**:
   - Click **"Install"** next to the appropriate result.
5. **Restart Visual Studio Code** (if required).

## Quick Start Guide

### Your First Annotation
1. **Open any file** in your project
2. **Position your cursor** on the line you want to annotate
3. **Right-click** → "Out-of-Code Insight" → "Add Annotation"
4. **Enter your annotation** message and press Enter
5. **See your annotation** appear in the Activity Bar sidebar

### Essential Workflow
1. **Add annotations** during code review or development (`Ctrl+Alt+A`)
2. **Organize with templates** for consistent formatting (`Ctrl+Shift+Alt+T`)
3. **Link related annotations** across files (`Ctrl+Alt+L`)
4. **Review systematically** with Review Mode (`F8`/`Shift+F8`)
5. **Visualize progress** with the Kanban board (`Ctrl+Alt+K`)

### Common Use Cases
- **Code Review**: Add review comments without modifying source files
- **Technical Documentation**: Document complex logic and architectural decisions
- **Bug Tracking**: Track issues with linked corrections and code snippets
- **Team Collaboration**: Share insights and TODOs with your team
- **Project Management**: Organize tasks visually with the Kanban board

## Usage

### Adding an Annotation

- **Using the context menu**:
  - Right-click on the line where you want to add an annotation.
  - Select **`Add Annotation`**.
- **Using keyboard shortcuts**:
  - Place your cursor on the desired line.
  - Press `Ctrl+Alt+A` (Windows/Linux) or `Cmd+Alt+A` (Mac).

### Editing or Deleting an Annotation

- **Using the context menu**:
  - Right-click on the line containing the annotation.
  - Select **`Edit Annotation`** or **`Delete Annotation`**.
- **Using keyboard shortcuts**:
  - **Edit an annotation**:
    - Press `Ctrl+Alt+E` (Windows/Linux) or `Cmd+Alt+E` (Mac).
  - **Delete an annotation**:
    - Press `Ctrl+Alt+D` (Windows/Linux) or `Cmd+Alt+D` (Mac).

### Viewing and Managing Annotations

- **Open the annotations panel**:
  - Use the **`View Annotations`** command from the Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`).
  - Or click the annotations icon in the status bar.
- **Toggle annotation visibility**:
  - Use the **`Toggle Annotation Visibility`** command to make annotations visible or hidden in the editor.
  - Shortcut: `Ctrl+Alt+T` (Windows/Linux) or `Cmd+Alt+T` (Mac).

### Moving Annotations

- **Move an annotation within the editor**:
  - Position your cursor on the line above or below the annotation.
  - Use the **`Move Annotation Up`** or **`Move Annotation Down`** commands available in the context menu or annotations panel.
  - Annotations automatically follow their lines when you modify code within Visual Studio Code.

### Replying to an Annotation

- **Add a comment to an existing annotation**:
  - In the annotations panel, select the annotation you want to reply to.
  - Click **`Reply`** to add a comment and start a thread.

### Filtering and Sorting Annotations

- **Filter annotations**:
  - Use the filtering options in the annotations panel to display annotations by file or author.
- **Sort annotations**:
  - Sort annotations by date, number of comments, etc., for efficient management.

### Batch Editing Annotations

- **Modify multiple annotations**:
  - Open the annotations panel.
  - Select the annotations you wish to edit.
  - Use the **`Batch Edit Annotations`** command to apply changes to all selected annotations simultaneously.

### Keyword Search

- **Search for annotations by keyword**:
  - Use the **`Keyword Search`** feature in the annotations panel.
  - Enter the desired keyword to filter annotations containing that term.

### Filter by Severity

- **Categorize annotations**:
  - Use the **`Filter by Severity`** option to display annotations based on their assigned severity levels (e.g., info, warning, error).

### Set Annotation Severity

- **Adjust severity**:
  - Right-click on an annotated line and choose **`Set Annotation Severity`**.
  - Select the appropriate level (`info`, `warning`, or `error`) to better classify the annotation.

### Show AI Suggestion
- **View simulated suggestions**:
  - Use the **`Show AI Suggestion`** command to display simulated suggestions from AI within your annotations. Select a line in the code editor, right-click to bring up the context menu. In the "out-of-code-insight" submenu, select the "AI Suggest Annotation" option, and it will provide an annotation for that line. 
  - If you want to disabled or enabled AI Suggest, you can do it in the settings.
  - Press `Ctrl+Shift+P` to open the Command Palette.
    - Type the name of the command (for example, `Update OpenAI Key` or `Reset OpenAI Key`).
  - **Important**: Ensure you have an OpenAI API key configured to access this feature.
  


- **View simulated suggestions**:

![image](https://github.com/user-attachments/assets/47a41c70-b7dd-4057-9330-f1944d456035)

### Auto-Resolve Stale Annotations

- **Automatic management**:
  - Enable **`Auto-Resolve Stale Annotations`** to automatically handle annotations that are outdated or no longer relevant.

## 🚀 Using Advanced Features

### Creating and Managing Linked Annotations

**Create a Link:**
1. Position cursor on an existing annotation
2. Right-click → "Out-of-Code Insight" → "Create Link to Another Annotation"
3. Choose between linking to existing annotation or creating a new one
4. Select relationship type (implements, references, depends-on, etc.)
5. Navigate with `Ctrl+Alt+L` or click 🔗 indicators in TreeView

**Visualize All Links:**
- Use "Show All Links" command to open interactive link visualization
- View statistics, outgoing/incoming relationships, and navigate directly

### Working with Annotation Templates

**Apply a Template:**
1. Position cursor where you want to add an annotation
2. Use `Ctrl+Shift+Alt+T` or "Apply Template" command
3. Select from pre-built templates (Bug, TODO, Refactor, etc.)
4. Fill in template variables with your specific information

**Create Custom Templates:**
1. Use "Create Annotation Template" command
2. Define template name, content with variables (`{{variableName}}`)
3. Set default severity and tags
4. Save and share with your team

### Using Review Mode

**Start a Review Session:**
1. Open Command Palette (`Ctrl+Shift+P`) → "Start Review Mode"
2. Configure filters (optional): author, date range, severity, tags
3. Navigate with `F8` (next) / `Shift+F8` (previous)
4. Mark annotations as viewed or resolved during review
5. View progress and statistics in status bar

### Managing the Kanban Board

**Open Kanban:**
- Use `Ctrl+Alt+K` or "Show Kanban Board" command
- Drag & drop annotations between columns
- Add custom columns for your workflow
- Filter view by author, severity, or tags

**Kanban Actions:**
- **Move annotations**: Drag between columns or use "Move to Column"
- **Smart deletion**: Choose to remove from kanban only or delete completely
- **Quick navigation**: Double-click cards to open file location
- **Custom columns**: Add workflow-specific columns (e.g., "Testing", "Deployed")

### Working with Code Snippets

**Add Snippets to Annotations:**
1. Right-click on annotation → "Add Code Snippet to Annotation"
2. Enter code with optional variables (`$1`, `$2`, `${1:placeholder}`)
3. Set language and description
4. Use "Preview Snippet Changes" before applying
5. Apply with "Apply Code Snippet" command

## 💡 Practical Examples & Best Practices

### Example 1: Code Review Workflow
```
1. Reviewer adds annotation: "Consider using async/await here for better readability"
2. Create template: "REVIEW: {{suggestion}} - Priority: {{priority}}"
3. Link to implementation: annotation → corrected code in another file
4. Add code snippet: "async function fetchData() { ... }"
5. Move to Kanban: "To Do" → "In Progress" → "Review" → "Done"
```

### Example 2: Bug Tracking System
```
1. Bug report: "BUG: Authentication fails on token refresh"
2. Link related annotations:
   - Bug annotation → Implementation file
   - Implementation → Test file  
   - Test file → Documentation
3. Attach fix snippet: "if (token.isExpired()) { await refreshToken(); }"
4. Use Review Mode to systematically check all auth-related annotations
```

### Example 3: Team Documentation
```
1. Architect creates templates:
   - "ARCHITECTURE: {{component}} - Purpose: {{purpose}}"
   - "TODO: {{task}} - Assigned: {{developer}} - Due: {{date}}"
2. Team uses templates for consistency
3. Link annotations create knowledge graph
4. Kanban board shows project progress
5. Review Mode ensures nothing is missed
```

### Pre-built Templates Available
- **Bug**: Report bugs with steps to reproduce and expected vs actual results
- **TODO**: Task tracking with priority and assignment
- **Refactor**: Code improvement suggestions with rationale
- **Performance**: Performance issues with metrics and improvement plans
- **Security**: Security concerns with risk assessment
- **Documentation**: Documentation gaps with content guidelines
- **Question**: Questions for team discussion with context

### Best Practices
- **Use consistent templates** across your team for better communication
- **Link related annotations** to create a knowledge graph of your codebase
- **Review annotations regularly** using Review Mode to keep them current
- **Organize with Kanban** to visualize project progress and bottlenecks
- **Attach code snippets** for quick fixes and examples
- **Tag annotations** with project phases, components, or priorities
- **Export/import** annotations when sharing across projects or teams

### Configure the annotations.json File Path

- **Set the path to the annotations file**:
  - Access the extension settings.
  - Enter the desired path in the **`Path to annotations file`** field. Include the file name (e.g., `annotations.json`), if you not specify the file name, the extension will use the default name (`annotations.json`).
  - Per default, the annotations file is located in the **`.out-of-code-insights/annotations.json`** directory of your project.
  - If you change the path, ensure that the directory exists and is accessible. All project using the extension will use this path after the change, else the extension will use the default path in each project.

### Default Severity Setting

- **Specify a default severity**:
  - In the extension settings, modify **`Default Severity`** to define the severity level applied when creating new annotations.

### Exporting and Importing Annotations

- **Export Annotations to JSON**
  - Use the `Export Annotations to JSON` command to export all annotations to a JSON file.
  - Command: `annotations.exportJSON`
  
- **Import Annotations from JSON**
  - Use the `Import Annotations from JSON` command to import annotations from a JSON file.
  - Command: `annotations.importJSON`

### Managing Annotations

- **Toggle Annotation Pin**
  - Pin or unpin annotations to keep important notes visible.
  - Command: `annotations.pinToggle`

- **Convert Annotation to GitHub Issue**
  - Convert your annotations into GitHub issues for better tracking and management.
  - Command: `annotations.convertToIssue`

### Enhanced Features


- **Auto-Resolve Stale Annotations**
  - Automatically resolve annotations that are outdated or no longer relevant.
  - Command: `annotations.autoResolveStale`

- **Batch Edit Annotations in File**
  - Modify multiple annotations simultaneously within a file to streamline your workflow.
  - Command: `annotations.batchEdit`

- **Keyword Search in Annotations**
  - Quickly locate annotations by searching for specific keywords.
  - Command: `annotations.keywordSearch`

- **Filter Annotations by Severity**
  - Organize annotations based on their severity levels for better prioritization.
  - Command: `annotations.filterBySeverity`

### Important Notes

- **File modification**:
  - To ensure annotations track file changes correctly, always modify files **within Visual Studio Code**. External modifications may disrupt annotation tracking.
- **Compatibility with all file types**:
  - You can add annotations to **any file in your project**, including source code, Markdown, JSON, XML, text, etc.
- **Annotation storage**:
  - Annotations are stored in a JSON file named **`annotations.json`**, located by default in the **`.out-of-code-insights`** directory of your project.
  - **Include this file in your version control repository** if you want to preserve annotation history and share comments with your team.
- **OpenAI API Key Management**:
  - The extension uses your OpenAI API key for AI-powered features.
  - The key is securely stored using VS Code's Secret Storage, ensuring that your key is protected and only accessible by this extension.
  - **To remove or update your OpenAI API key**:
    1. **Open the Command Palette**:
       - Press `Ctrl+Shift+P` (Windows/Linux) or `Cmd+Shift+P` (Mac).
    2. **Type**: `Developer: Clear Extension Secret Storage`.
    3. **Select Your Extension**:
       - In the list that appears, select **Out-of-Code Insights**.
    - This will clear all secrets stored by the extension, including your OpenAI API key.

## Configuration

Customize the extension according to your needs by modifying the available settings:

- **Username** (`annotation.username`): Specifies the name that will appear as the annotation author.
  - **Important**: Update the username to properly identify authors.
- **Enable annotations** (`annotation.enableAnnotations`): Toggles annotation visibility in the editor.
- **Custom colors** (`annotation.colors`):
  - Customize annotation colors, highlight background, and comment borders for both light and dark themes.
- **Enable CodeLens** (`annotation.codelens.enable`): Toggles CodeLens integration.
- **Show commands in CodeLens** (`annotation.codelens.showCommands`): Toggles command display in CodeLens.
- **Batch Edit Annotations** (`annotation.batchEdit`): Enable or disable the batch editing feature.
- **Keyword Search** (`annotation.keywordSearch`): Configure settings for keyword-based annotation searching.
- **Filter by Severity** (`annotation.filterBySeverity`): Set preferences for severity-based annotation filtering.
- **Default Severity** (`annotation.defaultSeverity`): Choose the severity level automatically applied to new annotations.
- **Advanced settings**:
  - **Change detection delay** (`annotation.debounceDelay`)
  - **Maximum annotations per file** (`annotation.maxAnnotationsPerFile`)

**Access settings**:

1. Go to **`File`** > **`Preferences`** > **`Settings`** (or **`Code`** > **`Preferences`** > **`Settings`** on Mac).
2. Search for **`annotation`** to view all available settings.

## Extension Settings Overview

You can customize Out-of-Code Insights using the following settings (available in VS Code settings under `annotation` or `llm`):

- **annotation.provider**: Select the LLM provider to use for AI-powered features. Supported values: `openai`, `anthropic`, `azure`, `cerebras`, `deepseek`, `google`, `groq`, `meta`, `mistralai`, `ollama`, `openrouter`, `togetherai`, `xai`.
- **annotation.model**: Specify the model to use for the selected provider (e.g., `gpt-4o-mini`, `claude-3-haiku`, etc.).
- **llm.apiKeys**: Object containing API keys for all supported LLM providers. Example:
  ```json
  "llm.apiKeys": {
    "openai": "sk-...",
    "anthropic": "...",
    "azure": "...",
    "mistralai": "...",
    "groq": "...",
    "ollama": "...",
    "google": "...",
    "openrouter": "...",
    "togetherai": "...",
    "xai": "..."
  }
  ```
- **annotation.colors.light.annotation**: Annotation color for light theme.
- **annotation.colors.light.highlightBackground**: Highlight background for annotations in light theme.
- **annotation.colors.light.commentBorder**: Comment border color in light theme.
- **annotation.colors.dark.annotation**: Annotation color for dark theme.
- **annotation.colors.dark.highlightBackground**: Highlight background for annotations in dark theme.
- **annotation.colors.dark.commentBorder**: Comment border color in dark theme.
- **annotation.debounceDelay**: Debounce delay (ms) for refreshing annotations.
- **annotation.maxAnnotationsPerFile**: Maximum number of annotations per file.
- **annotation.username**: Username to display as the annotation author.
- **annotation.codelens.enable**: Enable or disable CodeLens for annotations.
- **annotation.codelens.showCommands**: Show or hide commands in CodeLens.
- **annotation.github.repository**: GitHub repository (format: `owner/repo`) for creating issues from annotations.
- **annotation.enableAiSuggest**: Enable or disable the AI Suggest Annotation feature.
- **annotation.path**: Custom path to the annotations file or directory.
- **annotation.defaultSeverity**: Default severity for new annotations (`info`, `warning`, `error`).

---

## LLM Provider and API Key Configuration

To use AI-powered annotation generation, you can choose from multiple LLM providers (OpenAI, Anthropic, Azure, MistralAI, Groq, Ollama, Google, and more).

### 1. Select the LLM Provider and Model

- Open the extension settings (File > Preferences > Settings or `Ctrl+,`).
- Set `annotation.provider` to your desired LLM provider (e.g., `openai`, `anthropic`, `mistralai`, etc.).
- Set `annotation.model` to the model you want to use for the selected provider (e.g., `gpt-4o-mini`, `claude-3-haiku`, etc.).

### 2. Enter Your API Key

- On the first AI request for a given provider, the extension will automatically prompt you for the corresponding API key in a secure dialog.
- You can also manually enter or update all your API keys in the settings, under the `llm.apiKeys` object (see above).
- Keys are securely stored using VS Code's Secret Storage.
- If you switch providers, the extension will prompt for the new provider's API key if it is not already set.
- You can update or reset any key at any time in the settings or via the dedicated command.

### 3. Usage

- Once the provider, model, and key are configured, use the **AI Suggest Annotation** command (`annotations.aiSuggest`) to generate an AI-powered annotation for the current line.
- You can change providers or models at any time in the settings; the relevant key will be requested if needed.

### Notes
- If no key is set for the selected provider, the extension will prompt you to enter it on first use.
- All keys can be managed in the settings for quick and centralized access.
- The multi-provider system lets you easily switch between LLMs and models according to your needs or quotas.

## Keyboard Shortcuts

| **Action**                          | **Shortcut (Windows/Linux)** | **Shortcut (Mac)**  |
|-------------------------------------|------------------------------|---------------------|
| Add an annotation                   | `Ctrl+Alt+A`                 | `Cmd+Alt+A`         |
| Edit an annotation                  | `Ctrl+Alt+E`                 | `Cmd+Alt+E`         |
| Delete an annotation                | `Ctrl+Alt+D`                 | `Cmd+Alt+D`         |
| Show annotations panel              | `Ctrl+Alt+S`                 | `Cmd+Alt+S`         |
| Toggle annotation visibility        | `Ctrl+Alt+T`                 | `Cmd+Alt+T`         |
| Batch Edit Annotations              | `Ctrl+Alt+B`                 | `Cmd+Alt+B`         |
| Keyword Search                      | `Ctrl+Alt+K`                 | `Cmd+Alt+K`         |
| Filter by Severity                  | `Ctrl+Alt+F`                 | `Cmd+Alt+F`         |
| Show AI Suggestion             | `Ctrl+Alt+G`                 | `Cmd+Alt+G`         |
| Auto-Resolve Stale Annotations      | `Ctrl+Alt+R`                 | `Cmd+Alt+R`         |
| **Advanced Features**               |                               |                     |
| Create Link to Annotation          | `Ctrl+Alt+L`                 | `Cmd+Alt+L`         |
| Apply Annotation Template          | `Ctrl+Shift+Alt+T`           | `Cmd+Shift+Alt+T`   |
| Show Kanban Board                  | `Ctrl+Alt+K`                 | `Cmd+Alt+K`         |
| Next Annotation (Review Mode)      | `F8`                         | `F8`                |
| Previous Annotation (Review Mode)  | `Shift+F8`                   | `Shift+F8`          |

Below is the complete list of commands (available via **Ctrl+Shift+P**) in a tabular format, suitable for inclusion in your README. Each command can be run by opening the Command Palette (**Ctrl+Shift+P**) and typing its name:

| **Action**                        | **Command**                  | **Description**                                                            |
|-----------------------------------|------------------------------|----------------------------------------------------------------------------|
| Add Annotation                    | `annotations.add`            | Adds a new annotation to the current line of code.                         |
| Reply to Annotation               | `annotations.reply`          | Adds a reply/comment to an existing annotation.                            |
| Clear All Annotations             | `annotations.clearAll`       | Removes all annotations from the project.                                  |
| Delete Annotation                 | `annotations.delete`         | Deletes the annotation on the current line.                                |
| Edit Annotation                   | `annotations.edit`           | Edits the annotation on the current line.                                  |
| Edit Annotation Tags             | `annotations.editTags`       | Adds or removes tags on the current annotation.                            |
| Toggle Annotations Display        | `annotations.toggleDisplay`  | Shows or hides all annotations in the editor.                              |
| Navigate to Annotation            | `annotations.navigate`       | Jumps directly to the specified annotation.                                |
| Export Annotations to JSON        | `annotations.exportJSON`     | Exports all annotations to a JSON file.                                    |
| Import Annotations from JSON      | `annotations.importJSON`     | Imports annotations from a JSON file.                                      |
| Toggle Annotation Pin             | `annotations.pinToggle`      | Pins or unpins the annotation at the current line.                         |
| Batch Edit Annotations in File    | `annotations.batchEdit`      | Updates all annotations within the current file at once.                   |
| Keyword Search in Annotations     | `annotations.keywordSearch`   | Searches annotations by a keyword.                                         |
| AI Suggest Annotation             | `annotations.aiSuggest`      | Requests an AI-generated annotation for the current line of code.          |
| Move Annotation Up                | `annotations.moveUp`         | Moves the annotation on the current line up by one line.                   |
| Move Annotation Down              | `annotations.moveDown`       | Moves the annotation on the current line down by one line.                 |
| Show Annotations Panel            | `annotations.show`           | Opens the annotations panel to view and manage all annotations.            |
| Update OpenAI Key                 | `annotations.updateOpenAIKey`| Prompts you to enter a new OpenAI API key.                                 |
| Reset OpenAI Key                  | `annotations.resetOpenAIKey` | Clears the stored OpenAI API key, requiring a new key on the next AI call. |
| **Advanced Features**             |                              |                                                                            |
| Create Link to Another Annotation| `annotations.createLink`     | Creates a relationship link between two annotations across files.           |
| Navigate to Linked Annotation    | `annotations.navigateToLinked`| Navigates to annotations linked to the current one.                       |
| Show All Links                    | `annotations.showAllLinks`   | Opens interactive visualization of all annotation links.                   |
| Apply Annotation Template        | `annotations.applyTemplate`  | Applies a pre-built or custom template to create structured annotations.   |
| Create Annotation Template       | `annotations.createTemplate` | Creates a new custom annotation template with variables.                   |
| Manage Templates                  | `annotations.manageTemplates`| Opens template management interface.                                       |
| Start Review Mode                 | `annotations.startReview`    | Begins systematic review of annotations with filtering options.            |
| Stop Review Mode                  | `annotations.stopReview`     | Ends the current review session and shows statistics.                     |
| Next Annotation                   | `annotations.nextAnnotation` | Navigates to the next annotation in review mode.                          |
| Previous Annotation               | `annotations.prevAnnotation` | Navigates to the previous annotation in review mode.                      |
| Show Kanban Board                 | `annotations.showKanban`     | Opens the visual Kanban board for annotation management.                  |
| Add Code Snippet to Annotation   | `annotations.addSnippet`     | Attaches an executable code snippet to an annotation.                     |
| Apply Code Snippet               | `annotations.applySnippet`   | Executes and applies a code snippet from an annotation.                   |

## Additional Features

- **Renamed or deleted files**: Automatically updates or removes annotations when files are renamed or deleted.
- **Export and import annotations**: Share or back up annotations, and import them into other projects.
- **Status bar integration**: Displays the number of annotations in the status bar for quick access.
- **Navigate to annotations**: Quickly jump to a specific annotation from the annotations panel.
- **Advanced customization**: Adjust the extension’s behavior to suit your preferences.
- **Batch Edit Annotations**: Efficiently manage multiple annotations with batch editing capabilities.
- **Keyword Search**: Enhance your workflow by searching annotations using specific keywords.
- **Filter by Severity**: Organize annotations based on their severity levels for better prioritization.
- **Set Annotation Severity**: Assign severity levels to existing annotations.
- **Show AI Suggestion**: Benefit from simulated suggestions to improve your annotation process.
- **Auto-Resolve Stale Annotations**: Maintain a clean workspace by automatically resolving outdated annotations.

## Tree View and Activity Bar

The **Out-of-Code Insights** extension includes a **Tree View** and an **Activity Bar** for efficient annotation management. Here is a detailed description of these features:

### Tree View

The **Tree View** allows you to visualize and manage annotations in a structured manner. It is accessible via the Activity Bar in Visual Studio Code.

- **Grouping by file**: Annotations are grouped by file, making navigation and management easier.
### Example Usage
- **Annotation display**: Each file contains a list of annotations with details such as the author, date, and annotation message.
- **Annotation actions**: You can navigate to an annotation, edit it, delete it, or add comments directly from the Tree View.

### Activity Bar

The **Activity Bar** adds a dedicated icon for **Out-of-Code Insights** in the Visual Studio Code sidebar. Clicking this icon opens the Tree View of annotations.

- **Quick access**: The Activity Bar provides quick access to all annotations in your project.
- **Centralized management**: All annotations are centralized in a single view, making them easier to manage and navigate.

### Example Usage

1. **Open the Tree View**:
   - Click the **Out-of-Code Insights** icon in the Activity Bar.
   - The Tree View opens, displaying annotations grouped by file.

2. **Navigate to an annotation**:
   - Click on an annotation in the Tree View.
   - The code editor automatically positions itself on the line of the selected annotation.

3. **Edit or delete an annotation**:
   - Right-click on an annotation in the Tree View.
   - Select **Edit** or **Delete** from the context menu.

4. **Add a comment**:
   - Select an annotation in the Tree View.
   - Click **Reply** to add a comment to the annotation.

These features enhance annotation management by providing an overview and management tools directly integrated into the Visual Studio Code interface.

## 🔧 Troubleshooting

### Common Issues and Solutions

#### "Annotations not showing in editor"
- **Check visibility**: Use `Ctrl+Alt+T` to toggle annotation display
- **Verify file path**: Ensure annotations.json is in the correct location (`.out-of-code-insights/` by default)
- **Restart VS Code**: Sometimes a restart is needed after installation

#### "Template variables not working"
- **Use correct syntax**: Variables should be `{{variableName}}` with double curly braces
- **Check template format**: Ensure template is properly saved and contains variables
- **Verify input**: Make sure you're entering values for all template variables

#### "Linked annotations not navigating correctly"
- **Check file paths**: Ensure linked files exist and paths are correct
- **Verify line numbers**: Line numbers should match the actual annotation location
- **Use relative paths**: For better portability, use relative paths when linking

#### "Kanban board not updating"
- **Refresh manually**: Use the refresh button in the Kanban board
- **Check column assignments**: Ensure annotations are assigned to valid columns
- **Restart extension**: Disable and re-enable the extension if needed

#### "Code snippets not applying"
- **Position correctly**: Ensure cursor is on the annotation line before applying
- **Check snippet syntax**: Variables should use `$1`, `$2`, `${1:placeholder}` format
- **Verify language**: Make sure the snippet language matches the target file

#### "Review Mode not starting"
- **Check filters**: Ensure filter settings aren't excluding all annotations
- **Verify annotations exist**: Make sure there are annotations to review
- **Reset filters**: Clear all filters and try again

#### "Performance issues with large projects"
- **Increase limits**: Adjust `annotation.maxAnnotationsPerFile` in settings
- **Use filters**: Filter annotations by file, author, or date to reduce load
- **Close unused features**: Close Kanban board and Review Mode when not needed

### Getting Help
- **Check settings**: Review all extension settings in VS Code preferences
- **Console logs**: Open Developer Tools (F12) to check for error messages
- **Extension page**: Visit the VS Code marketplace page for updates and known issues
- **Community support**: Use GitHub Discussions for questions and community help

## Contribution

Contributions are welcome! Feel free to suggest improvements, report issues, or submit pull requests.

## License

See the [LICENSE](https://github.com/JacquesGariepy/out-of-code-insights/blob/main/license.txt) file for more information.

## Conclusion

Out-of-code Insights helps you manage comments and notes in your projects **without cluttering your source code**. By providing a platform for non-intrusive annotations, precise change tracking, and seamless integration into your development environment, this extension is a practical tool for developers and teams looking to improve collaboration and productivity.

---

**Try Out-of-code Insights today and streamline your workflow without overloading your code!**

[<img src="media/bmc_qr.png" alt="Buy me a coffee" height="128px"/>](https://www.buymeacoffee.com/jacquesgarX)
