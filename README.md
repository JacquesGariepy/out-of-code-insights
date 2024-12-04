# Out-of-code Insights

https://marketplace.visualstudio.com/items?itemName=JacquesGariepy.out-of-code-insights

Out-of-code Insights is a Visual Studio Code extension that allows you to add annotations, comments, and notes **without modifying your source files**. It is ideal for avoiding clutter in your code with temporary comments or making the code unnecessarily heavy.

## Why use Out-of-code Insights?

- **Non-intrusive annotations**: Add comments without altering the source code, keeping your files clean and organized.
- **Optimized for code reviews**: Facilitate team communication by adding comments directly on the relevant lines.
- **Avoid code clutter**: Maintain clarity and readability of your code by avoiding unnecessary comments.
- **Annotations on all file types**: Add annotations to any file in your project, including source code, Markdown, JSON, XML, text, etc.
- **Intelligent change tracking**: Annotations automatically follow file changes as long as edits are made within Visual Studio Code.
- **Personalization**: Adapt the extension to your needs with various configuration options.
- **Threaded discussions**: Reply to annotations to create threads and enhance collaboration.
- **Advanced annotation management**: Move, filter, sort, and navigate annotations with ease.

![Demonstration of Out-of-code Insights features](media.gif)

## Key Features

- **Add annotations**: Insert comments or notes on specific lines **without modifying the source file**, regardless of file type.
- **View and manage annotations**: See all your annotations in a dedicated panel, modify, delete, or reply to them.
- **Toggle annotation visibility**: Enable or disable annotation visibility in the editor.
- **Move annotations**: Drag annotations directly within the editor. Annotations follow their assigned lines; simply position above or below a line to move it.
- **CodeLens integration**: Manage annotations directly from the editor with CodeLens integration.
- **Filter and sort annotations**: Filter and sort annotations in the panel for efficient management.
- **Export and import**: Export your annotations to share or back them up, and import them into other projects.

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

### Important Notes

- **File modification**:
  - To ensure annotations track file changes correctly, always modify files **within Visual Studio Code**. External modifications may disrupt annotation tracking.
- **Compatibility with all file types**:
  - You can add annotations to **any file in your project**, including source code, Markdown, JSON, XML, text, etc.
- **Annotation storage**:
  - Annotations are stored in a JSON file named **`annotations.json`**, located by default in the **`.out-of-code-insights`** directory of your project.
  - **Include this file in your version control repository** if you want to preserve annotation history and share comments with your team.

## Configuration

Customize the extension according to your needs by modifying the available settings:

- **Username** (`annotation.username`): Specifies the name that will appear as the annotation author.
  - **Important**: Update the username to properly identify authors.
- **Enable annotations** (`annotation.enableAnnotations`): Toggles annotation visibility in the editor.
- **Custom colors** (`annotation.colors`):
  - Customize annotation colors, highlight background, and comment borders for both light and dark themes.
- **Enable CodeLens** (`annotation.codelens.enable`): Toggles CodeLens integration.
- **Show commands in CodeLens** (`annotation.codelens.showCommands`): Toggles command display in CodeLens.
- **Advanced settings**:
  - **Change detection delay** (`annotation.debounceDelay`)
  - **Maximum annotations per file** (`annotation.maxAnnotationsPerFile`)

**Access settings**:

1. Go to **`File`** > **`Preferences`** > **`Settings`** (or **`Code`** > **`Preferences`** > **`Settings`** on Mac).
2. Search for **`annotation`** to view all available settings.

## Keyboard Shortcuts

| **Action**                          | **Shortcut (Windows/Linux)** | **Shortcut (Mac)**  |
|-------------------------------------|------------------------------|---------------------|
| Add an annotation                   | `Ctrl+Alt+A`                 | `Cmd+Alt+A`         |
| Edit an annotation                  | `Ctrl+Alt+E`                 | `Cmd+Alt+E`         |
| Delete an annotation                | `Ctrl+Alt+D`                 | `Cmd+Alt+D`         |
| Show annotations panel              | `Ctrl+Alt+S`                 | `Cmd+Alt+S`         |
| Toggle annotation visibility        | `Ctrl+Alt+T`                 | `Cmd+Alt+T`         |

## Additional Features

- **Renamed or deleted files**: Automatically updates or removes annotations when files are renamed or deleted.
- **Export and import annotations**: Share or back up annotations, and import them into other projects.
- **Status bar integration**: Displays the number of annotations in the status bar for quick access.
- **Navigate to annotations**: Quickly jump to a specific annotation from the annotations panel.
- **Advanced customization**: Adjust the extension’s behavior to suit your preferences.

## Tree View and Activity Bar

The **Out-of-Code Insights** extension includes a **Tree View** and an **Activity Bar** for efficient annotation management. Here is a detailed description of these features:

### Tree View

The **Tree View** allows you to visualize and manage annotations in a structured manner. It is accessible via the Activity Bar in Visual Studio Code.

- **Grouping by file**: Annotations are grouped by file, making navigation and management easier.
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

## Contribution

Contributions are welcome! Feel free to suggest improvements, report issues, or submit pull requests.

## License

This extension is licensed under the MIT License. See the [LICENSE](LICENSE) file for more information.

## Conclusion

Out-of-code Insights helps you manage comments and notes in your projects **without cluttering your source code**. By providing a platform for non-intrusive annotations, precise change tracking, and seamless integration into your development environment, this extension is a practical tool for developers and teams looking to improve collaboration and productivity.

---

**Try Out-of-code Insights today and streamline your workflow without overloading your code!**
