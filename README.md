# GitMan: AI Git Helper for VS Code

![GitMan Logo](media/icon.png)

**GitMan** is a powerful VS Code extension that combines standard Git operations with AI-powered assistance. It streamlines your workflow by providing a modern sidebar interface for git commands and an integrated AI chat to answer your questions.

## 🚀 Features

*   **🤖 AI-Powered Chat**: Ask questions about Git, your code, or get help with errors using OpenAI, GLM, or Grok.
*   **⚡ Fast Push**: One-click workflow to Stage All -> Commit -> Push.
*   **📊 Dashboard**: View repository status, current branch, and remote details at a glance.
*   **🌿 Branch Management**: Create, switch, merge, and delete branches directly from the sidebar.
*   **🔒 Secure**: Your API keys and Personal Access Tokens (PAT) are stored securely using VS Code's Secret Storage.
*   **🛠️ Git Operations**:
    *   Commit, Push, Pull, Fetch
    *   Stash changes
    *   Manage Remotes

## 📦 Installation

1.  Open **VS Code**.
2.  Go to the **Extensions** view (`Ctrl+Shift+X`).
3.  Search for **GitMan**.
4.  Click **Install**.

## ⚙️ Setup

1.  **Open the Sidebar**: Click the GitMan icon in the Activity Bar.
2.  **Connect GitHub**:
    *   Click "Login with GitHub" to authenticate securely.
    *   Or manually enter a Personal Access Token (PAT).
3.  **Configure AI**:
    *   Select your provider (OpenAI, GLM, Grok).
    *   Enter your API Key.
    *   (Optional) Set a custom Base URL and Model Name.

## 📖 Usage

### Dashboard
The dashboard provides a quick overview of your repository:
*   **Repo Info**: Name, path, and remote URL.
*   **Status**: Clean or dirty working tree.
*   **Sync**: Quick buttons for Pull, Push, Commit, and Stash.

### AI Chat
Switch to the **Chat** tab to interact with the AI.
*   *Example*: "How do I undo the last commit?"
*   *Example*: "Explain the changes in this file."

## 🔧 Configuration

You can configure the extension via the Settings UI or `settings.json`:

*   `gitHelper.apiProvider`: AI Provider (Default: `OpenAI`)
*   `gitHelper.apiBaseUrl`: Custom API Base URL.
*   `gitHelper.modelName`: Model to use (e.g., `gpt-3.5-turbo`).

## 🤝 Contributing

Contributions are welcome!

1.  Fork the repository.
2.  Create a feature branch (`git checkout -b feature/amazing-feature`).
3.  Commit your changes (`git commit -m 'Add amazing feature'`).
4.  Push to the branch (`git push origin feature/amazing-feature`).
5.  Open a Pull Request.

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---
**Publisher**: [gitman](https://marketplace.visualstudio.com/publishers/gitman)
