# Gitsy — AI-Powered Git Helper for VS Code

![Gitsy Logo](media/gitsy.png)

**Gitsy** is an AI-powered Git extension for VS Code that makes everyday Git workflows faster and safer. It combines a beautiful sidebar UI with **AI Pre-flight Checks** powered by **GitHub Copilot** (or Gemini as fallback) to catch secrets, code issues, and safety risks *before* you push — all without leaving the editor.

---

## ✨ Features

### 🤖 AI Pre-flight Checks *(Powered by VS Code Copilot)*
Before any push, commit, or merge, Gitsy runs an intelligent pre-flight scan:
- **🔐 Secret Detection** — Finds hardcoded API keys, tokens, and passwords in your code (not just `.env` files)
- **📄 .env Safety** — Detects `.env` files being committed without `.gitignore` coverage
- **🛡️ Branch Safety** — Warns before pushing directly to `main`/`master` on shared projects
- **🧹 Code Quality** — Flags leftover `debugger;` statements, broken imports, and large binary files
- **⚖️ Smart per-operation analysis** — Merge checks conflict risk, Push checks secrets, Fast Push checks everything

> **No AI for simple ops:** Branch switching, creating, deleting, and fetching run instantly with no AI overhead — AI only runs where it adds real value.

### ⚡ Fast Push
One-click Stage All → Commit → Push with a custom commit message. The AI pre-flight check runs automatically before pushing so you always push with confidence.

### 📊 Dashboard
- Real-time repository status, branch, and remote info
- File change list with status badges (M · A · D · U · ??)
- Pull Request list for your current branch
- Stash manager, conflict detection, rebase/merge status

### 🌿 Branch Management
Create, switch, merge, and delete branches directly from the sidebar.

### ⚡ Flow — Session Log
A live, session-based log of every Git operation you run:
- Success ✅ / Failed ❌ / Running 🔄 status indicators
- AI pre-flight result badge (Passed / Warned)
- Duration, branch, and operation details
- Grouped by Today / Yesterday / Earlier

---

## 🔒 Privacy & Security

| What | How |
|---|---|
| **Your code** | Never stored, never sent to third-party servers. AI analysis runs through **your own VS Code Copilot subscription** |
| **GitHub token** | Stored in VS Code's encrypted **Secret Storage** — never in settings, logs, or plain text |
| **AI provider** | Uses GitHub Copilot by default (already signed into your VS Code). Gemini is optional and only used if Copilot is unavailable |
| **Consent** | One-time consent prompt before any AI analysis runs |
| **Secrets found** | Reported locally in the sidebar — never uploaded anywhere |

> **You are in control.** AI checks can be disabled entirely via `gitsy.aiProvider: "disabled"` in VS Code settings.

---

## 📦 Installation

1. Open **VS Code**
2. Go to Extensions (`Ctrl+Shift+X`)
3. Search for **Gitsy**
4. Click **Install**

> **Requires**: VS Code 1.106+ and a GitHub account. GitHub Copilot subscription recommended for AI features (falls back to Gemini if not available).

---

## ⚙️ Setup

1. Click the **Gitsy icon** in the Activity Bar
2. Click **Connect with GitHub** — authenticates via secure OAuth 2.0
3. That's it — Gitsy auto-detects your workspace repository

### AI Configuration *(Optional)*
```json
// settings.json
{
  "gitsy.aiProvider": "auto",        // "auto" | "copilot" | "gemini" | "disabled"
  "gitsy.geminiApiKey": ""           // Only needed if using Gemini directly
}
```

---

## 📖 Usage

### Fast Push
Click **⚡ Fast Push** → enter a commit message → AI pre-flight check runs → click **Proceed** → done.

### AI Pre-flight Dialog
When you trigger an operation that uses AI:
1. A scanning panel slides in showing what's being checked
2. Results appear with severity-coded issue cards (🔴 Error / 🟡 Warning / 🔵 Info)
3. Each issue includes a 💡 suggested fix
4. Click **Proceed** to continue or **Cancel** to abort

### Flow Tab
Switch to the **⚡ Flow** tab to see a full log of your session's Git operations, their outcomes, and AI check results.

---

## 🤝 Contributing

Contributions are welcome!

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Commit: `git commit -m 'Add amazing feature'`
4. Push: `git push origin feature/amazing-feature`
5. Open a Pull Request

---

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.

---

**Publisher**: [gitsy](https://marketplace.visualstudio.com/publishers/gitsy) · **Repository**: [GitHub](https://github.com/Gopikrish-30/Gitsy)
