"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.AIPreflightService = void 0;
const vscode = __importStar(require("vscode"));
const https = __importStar(require("https"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const logger_1 = require("./logger");
// ─────────────────── What each operation does (prevents bad AI advice) ───────────────────
const OPERATION_DESCRIPTIONS = {
    'fast-push': `Fast Push is a fully automated operation. It AUTOMATICALLY does ALL of the following in sequence:
1. Stages ALL changed files (git add .)
2. Commits them with the provided message
3. Pushes to the remote branch
DO NOT advise the user to stage files, commit manually, or push manually — the operation handles all of this automatically.`,
    'push': `Push sends already-committed local commits to the remote repository.
The user has already committed their changes. DO NOT advise to commit first — that is already done.`,
    'pull': `Pull fetches and merges remote changes into the current branch.
This can cause merge conflicts if local changes exist. Focus on whether uncommitted changes could conflict.`,
    'commit': `Commit saves the currently staged files as a new commit.
The user selects which files to stage separately. DO NOT advise to stage files — that is a separate step.`,
    'stash': `Stash temporarily saves uncommitted working directory changes and reverts to a clean state.
This is intentionally for saving in-progress work.`,
    'create-branch': `Create Branch creates a new git branch.
The branch name validity is already checked by Gitsy. Focus on branch naming conventions or if branching from the right base.`,
    'delete-branch': `Delete Branch removes a local or remote branch.
Gitsy already confirms before deleting. Focus on whether this branch has unmerged work.`,
    'merge': `Merge combines changes from another branch into the current branch.
Focus on potential merge conflicts or if merging into a protected branch.`,
    'fetch': `Fetch downloads remote changes without applying them.
This is a safe read-only operation. Only flag genuine issues.`,
    'rebase': `Rebase replays local commits on top of another branch.
This rewrites commit history — flag if rebasing a shared/public branch.`,
};
// ─────────────────── Smart Security Checks ───────────────────
const SECRET_PATTERNS = [
    /(?:api[_-]?key|apikey|secret|password|passwd|token|auth|private[_-]?key|access[_-]?key|aws[_-]?secret)\s*[:=]\s*["']?[a-zA-Z0-9_\-]{8,}/i,
    /(?:AIza|sk-|ghp_|gho_|github_pat_|glpat-|xoxb-|xoxp-)[a-zA-Z0-9_\-]{10,}/,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];
async function scanFilesForSecrets(workspaceRoot, stagedFiles) {
    const issues = [];
    const filesToScan = stagedFiles.slice(0, 30); // Limit scan
    for (const relPath of filesToScan) {
        // Skip binary, image, and very large files
        const ext = path.extname(relPath).toLowerCase();
        if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.woff', '.ttf', '.eot', '.zip', '.gz', '.pdf'].includes(ext)) {
            continue;
        }
        try {
            const fullPath = path.join(workspaceRoot, relPath);
            const stat = fs.statSync(fullPath);
            if (stat.size > 500 * 1024) {
                continue;
            } // Skip files > 500KB
            const content = fs.readFileSync(fullPath, 'utf8');
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
                for (const pattern of SECRET_PATTERNS) {
                    if (pattern.test(lines[i])) {
                        issues.push({
                            title: 'Possible Secret Detected',
                            file: relPath,
                            line: i + 1,
                            description: `Line ${i + 1} appears to contain a hardcoded secret, API key, or credential. This will be permanently visible in git history.`,
                            solution: 'Move secrets to environment variables or a .env file. Add .env to .gitignore immediately.',
                            severity: 'error'
                        });
                        break; // One issue per file
                    }
                }
                if (issues.length >= 3) {
                    break;
                }
            }
        }
        catch { /* skip unreadable */ }
        if (issues.length >= 3) {
            break;
        }
    }
    return issues;
}
async function checkEnvFiles(workspaceRoot, allChangedFiles) {
    const issues = [];
    // Check if any .env files are being committed
    const envFiles = allChangedFiles.filter(f => /^\.env(\.|$)/i.test(path.basename(f)) || f.endsWith('.env'));
    for (const envFile of envFiles) {
        // Check if .gitignore exists and has this file covered
        const gitignorePath = path.join(workspaceRoot, '.gitignore');
        let gitignoreCovered = false;
        try {
            const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
            gitignoreCovered = gitignoreContent.split('\n').some(line => line.trim() === '.env' || line.trim() === '*.env' || line.trim() === envFile);
        }
        catch { /* no .gitignore */ }
        if (!gitignoreCovered) {
            issues.push({
                title: '.env File Being Committed',
                file: envFile,
                description: `The file "${envFile}" is being committed. Environment files typically contain secrets, API keys, and credentials that should NEVER be committed.`,
                solution: 'Add ".env" to your .gitignore file immediately, then remove it from git tracking with: git rm --cached ' + envFile,
                severity: 'error'
            });
        }
    }
    // Check if .gitignore is missing entirely when there are many files
    const gitignorePath = path.join(workspaceRoot, '.gitignore');
    const hasGitignore = fs.existsSync(gitignorePath);
    if (!hasGitignore && allChangedFiles.length > 5) {
        issues.push({
            title: 'No .gitignore File Present',
            description: `This project has no .gitignore file. Without it, sensitive files (node_modules, .env, build artifacts, logs, OS files) may be accidentally committed.`,
            solution: 'Create a .gitignore file appropriate for your project type. GitHub provides templates at github.com/github/gitignore',
            severity: 'warning'
        });
    }
    return issues;
}
// ─────────────────── Prompt Builder ───────────────────
function buildSystemPrompt(operation) {
    const opDesc = OPERATION_DESCRIPTIONS[operation] || `The user is performing a "${operation}" git operation.`;
    return `You are an expert code quality and security reviewer embedded in a VS Code Git extension called Gitsy.

WHAT THIS OPERATION DOES:
${opDesc}

YOUR JOB: Review the provided git context and identify REAL issues that could cause problems SPECIFIC to this operation.

WHAT TO ACTUALLY CHECK (be specific and actionable):
1. SECURITY: Hardcoded API keys, tokens, passwords in code (not just .env files — in actual source files)
2. CODE QUALITY: Obvious syntax errors that would break the build, large "debugger;" statements left in, broken imports
3. LARGE FILES: Binary files, compiled artifacts, or node_modules accidentally included
4. BRANCH SAFETY: Pushing directly to main/master without a PR when it looks like a shared project
5. CONFIGURATION: Missing critical config files that are expected for this project type

WHAT NOT TO FLAG:
- DO NOT flag things the operation already handles automatically (see the description above)
- DO NOT give generic git workflow advice (like "make sure to test", "review your changes")
- DO NOT flag console.log statements — those are acceptable in most projects
- DO NOT flag TODO/FIXME comments — those are normal
- DO NOT flag the act of pushing to main if there's only one contributor visible
- If everything looks fine, say so with an empty issues array

Respond ONLY with a valid JSON object — no markdown, no explanation, just JSON:
{
  "passed": boolean,
  "issues": [
    {
      "title": string,
      "file": string | null,
      "line": number | null,
      "description": string,
      "solution": string,
      "severity": "error" | "warning" | "info"
    }
  ],
  "summary": string
}

Rules:
- "passed" = true if there are no "error" severity issues (warnings are OK to proceed)
- "passed" = false ONLY for genuine blockers like exposed secrets or broken builds
- Keep "summary" under 80 characters
- Maximum 4 issues — only the most critical ones
- If no issues found, return { "passed": true, "issues": [], "summary": "All checks passed ✓" }`;
}
function buildUserPrompt(operation, context) {
    return `Perform a pre-flight check for: "${operation}"

${context}

Return JSON only. Be conservative — only flag genuine problems.`;
}
// ─────────────────── AIPreflightService ───────────────────
class AIPreflightService {
    context;
    GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';
    consentGiven = false;
    // Resolver for webview dialog response
    preflightResolver = null;
    constructor(context) {
        this.context = context;
    }
    /**
     * Build rich context from git state + local file scanning.
     */
    async buildContext(operation, gitService) {
        const parts = [];
        try {
            const branch = await gitService.getCurrentBranch().catch(() => 'unknown');
            const remote = await gitService.getRemote().catch(() => 'unknown');
            const repoName = await gitService.getRepoName().catch(() => 'unknown');
            const status = await gitService.getStatus().catch(() => '');
            const conflicts = await gitService.getConflicts().catch(() => []);
            const rebaseStatus = await gitService.getRebaseStatus().catch(() => null);
            const mergeStatus = await gitService.getMergeStatus().catch(() => null);
            parts.push(`Repository: ${repoName}`);
            parts.push(`Current Branch: ${branch}`);
            parts.push(`Remote URL: ${remote}`);
            if (status && status !== 'Clean') {
                const statusLines = status.split('\n').filter(l => l.trim()).slice(0, 25);
                parts.push(`Changed Files (git status --short):\n${statusLines.join('\n')}`);
            }
            else {
                parts.push('Working Tree: Clean (no changes)');
            }
            if (conflicts.length > 0) {
                parts.push(`MERGE CONFLICTS in: ${conflicts.join(', ')}`);
            }
            if (rebaseStatus) {
                parts.push(`Rebase in progress: ${rebaseStatus}`);
            }
            if (mergeStatus) {
                parts.push(`Merge in progress: ${mergeStatus}`);
            }
            // Extract file lists from status for targeted scanning
            const allChangedFiles = [];
            if (status) {
                status.split('\n').forEach(line => {
                    const match = line.match(/^\s*[MADRCU?!]{1,2}\s+(.+)$/);
                    if (match) {
                        allChangedFiles.push(match[1].trim());
                    }
                });
            }
            // Staged diff stat
            try {
                const stagedStat = await gitService.runGitCommand('git diff --staged --stat');
                if (stagedStat && stagedStat.trim()) {
                    parts.push(`Staged Changes:\n${stagedStat.split('\n').slice(0, 20).join('\n')}`);
                }
                else {
                    // For fast-push, ALL files will be staged — show unstaged stat
                    if (operation === 'fast-push') {
                        const unstagedStat = await gitService.runGitCommand('git diff --stat').catch(() => '');
                        if (unstagedStat && unstagedStat.trim()) {
                            parts.push(`Files to be staged & committed:\n${unstagedStat.split('\n').slice(0, 20).join('\n')}`);
                        }
                        // Also list untracked files
                        const untracked = await gitService.runGitCommand('git ls-files --others --exclude-standard').catch(() => '');
                        if (untracked && untracked.trim()) {
                            parts.push(`Untracked files (will be included in fast-push):\n${untracked.split('\n').slice(0, 15).join('\n')}`);
                        }
                    }
                }
            }
            catch { /* ok */ }
            // Recent commits for context
            try {
                const log = await gitService.runGitCommand('git log --oneline -5').catch(() => '');
                if (log) {
                    parts.push(`Recent commits:\n${log}`);
                }
            }
            catch { /* ok */ }
            // LOCAL SECRET SCANNING (rule-based, fast, no AI needed for this)
            const workspaceRoot = (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath) || '';
            if (workspaceRoot && allChangedFiles.length > 0) {
                const envIssues = await checkEnvFiles(workspaceRoot, allChangedFiles);
                if (envIssues.length > 0) {
                    parts.push(`\nPRE-SCANNED SECURITY ISSUES (already detected, include in your response):\n${JSON.stringify(envIssues)}`);
                }
                // Scan for secrets in changed files
                const secretIssues = await scanFilesForSecrets(workspaceRoot, allChangedFiles);
                if (secretIssues.length > 0) {
                    parts.push(`\nPRE-SCANNED SECRET PATTERNS FOUND (include in your response):\n${JSON.stringify(secretIssues)}`);
                }
            }
        }
        catch (e) {
            logger_1.Logger.warn('Failed to build full AI context', { error: e });
        }
        return parts.join('\n\n');
    }
    /**
     * Main entry: runs AI pre-flight check using best available provider.
     */
    async runPreflightCheck(operation, gitService) {
        const startTime = Date.now();
        const config = vscode.workspace.getConfiguration('gitsy');
        const aiProvider = config.get('aiProvider', 'auto');
        if (aiProvider === 'disabled') {
            return this.skippedResult(startTime, 'none');
        }
        // One-time consent — shown in sidebar via webview now
        if (!this.consentGiven && !(this.context.globalState.get('gitsy.aiConsentGiven', false))) {
            const consent = await vscode.window.showInformationMessage('🤖 Gitsy AI Pre-flight will analyze your code diff and git state before operations. Code snippets are sent to the AI model.', { modal: true }, 'Allow', 'Disable');
            if (consent === 'Disable') {
                await config.update('aiProvider', 'disabled', vscode.ConfigurationTarget.Global);
                return this.skippedResult(startTime, 'none');
            }
            if (consent !== 'Allow') {
                return this.skippedResult(startTime, 'none');
            }
            this.consentGiven = true;
            await this.context.globalState.update('gitsy.aiConsentGiven', true);
        }
        else {
            this.consentGiven = true;
        }
        const context = await this.buildContext(operation, gitService);
        // Try VS Code LM API (GitHub Copilot) first
        if (aiProvider === 'auto' || aiProvider === 'copilot') {
            try {
                const result = await this.checkWithVSCodeLM(operation, context, startTime);
                if (result) {
                    return result;
                }
            }
            catch (e) {
                logger_1.Logger.debug('VS Code LM API unavailable, trying Gemini', { error: e });
            }
        }
        // Try Gemini
        if (aiProvider === 'auto' || aiProvider === 'gemini') {
            const geminiKey = await this.context.secrets.get('gitsy.geminiApiKey');
            if (geminiKey) {
                try {
                    return await this.checkWithGemini(operation, context, geminiKey, startTime);
                }
                catch (e) {
                    logger_1.Logger.warn('Gemini pre-flight check failed', { error: e });
                }
            }
        }
        return this.skippedResult(startTime, 'none');
    }
    /**
     * VS Code Language Model API (GitHub Copilot).
     */
    async checkWithVSCodeLM(operation, context, startTime) {
        if (!('lm' in vscode)) {
            return null;
        }
        const lm = vscode.lm;
        let model;
        for (const family of ['gpt-4o', 'gpt-4o-mini', 'claude-3.5-sonnet']) {
            const models = await lm.selectChatModels({ family }).catch(() => []);
            if (models[0]) {
                model = models[0];
                break;
            }
        }
        if (!model) {
            const any = await lm.selectChatModels({}).catch(() => []);
            model = any[0];
        }
        if (!model) {
            return null;
        }
        logger_1.Logger.info('AI pre-flight via VS Code LM', { model: model.id });
        const cts = new vscode.CancellationTokenSource();
        setTimeout(() => cts.cancel(), 20000);
        const messages = [
            vscode.LanguageModelChatMessage.Assistant(buildSystemPrompt(operation)),
            vscode.LanguageModelChatMessage.User(buildUserPrompt(operation, context))
        ];
        const response = await model.sendRequest(messages, {}, cts.token);
        let raw = '';
        for await (const chunk of response.text) {
            raw += chunk;
        }
        return this.parseAIResponse(raw, startTime, 'copilot');
    }
    /**
     * Google Gemini REST API fallback.
     */
    async checkWithGemini(operation, context, apiKey, startTime) {
        logger_1.Logger.info('AI pre-flight via Gemini API');
        const prompt = buildSystemPrompt(operation) + '\n\n' + buildUserPrompt(operation, context);
        const body = JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: 'application/json', temperature: 0.1, maxOutputTokens: 1024 }
        });
        const responseText = await this.httpsPost(`${this.GEMINI_API_URL}?key=${apiKey}`, body, {
            'Content-Type': 'application/json'
        });
        const parsed = JSON.parse(responseText);
        const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        return this.parseAIResponse(text, startTime, 'gemini');
    }
    parseAIResponse(raw, startTime, provider) {
        try {
            const cleaned = raw.replace(/```json\n?/gi, '').replace(/```\n?/gi, '').trim();
            const parsed = JSON.parse(cleaned);
            const issues = (parsed.issues || []).map((i) => ({
                title: i.title || 'Issue',
                file: i.file || undefined,
                line: i.line || undefined,
                description: i.description || '',
                solution: i.solution || '',
                severity: i.severity || 'warning'
            }));
            return {
                passed: parsed.passed !== false,
                skipped: false,
                issues,
                summary: parsed.summary || (issues.length === 0 ? 'All checks passed ✓' : `Found ${issues.length} issue(s)`),
                durationMs: Date.now() - startTime,
                provider
            };
        }
        catch (e) {
            logger_1.Logger.warn('Failed to parse AI response', { raw, error: e });
            return { passed: true, skipped: false, issues: [], summary: 'AI check completed.', durationMs: Date.now() - startTime, provider };
        }
    }
    skippedResult(startTime, provider) {
        return { passed: true, skipped: true, issues: [], summary: '', durationMs: Date.now() - startTime, provider };
    }
    /**
     * Show pre-flight result in the sidebar webview (custom UI).
     * Sends the result to webview and awaits user response (Proceed / Cancel).
     */
    showPreflightInWebview(result, operation, postMessage) {
        // If nothing to show, auto-proceed
        if (result.skipped || result.issues.length === 0) {
            return Promise.resolve(true);
        }
        return new Promise((resolve) => {
            this.preflightResolver = resolve;
            postMessage({ type: 'show-preflight-dialog', value: { result, operation } });
        });
    }
    /**
     * Resolve a pending webview preflight dialog.
     */
    resolvePreflightResponse(proceed) {
        if (this.preflightResolver) {
            this.preflightResolver(proceed);
            this.preflightResolver = null;
        }
    }
    /**
     * Configure AI provider command.
     */
    async configureApiKey() {
        const options = [
            { label: '🤖 Auto (Copilot → Gemini)', value: 'auto' },
            { label: '✨ GitHub Copilot only', value: 'copilot' },
            { label: '🔮 Google Gemini (free API key)', value: 'gemini' },
            { label: '🚫 Disable AI checks', value: 'disabled' }
        ];
        const selected = await vscode.window.showQuickPick(options, {
            placeHolder: 'Select AI provider for Gitsy pre-flight checks'
        });
        if (!selected) {
            return;
        }
        const config = vscode.workspace.getConfiguration('gitsy');
        await config.update('aiProvider', selected.value, vscode.ConfigurationTarget.Global);
        if (selected.value === 'gemini' || selected.value === 'auto') {
            const existing = await this.context.secrets.get('gitsy.geminiApiKey');
            const key = await vscode.window.showInputBox({
                prompt: 'Enter your free Google Gemini API key (aistudio.google.com → Get API Key)',
                placeHolder: 'AIza...',
                password: true,
                ignoreFocusOut: true,
                value: existing ? '••••••••••' : ''
            });
            if (key && !key.startsWith('•')) {
                await this.context.secrets.store('gitsy.geminiApiKey', key);
                vscode.window.showInformationMessage('✅ Gemini API key saved securely.');
            }
        }
        if (selected.value === 'disabled') {
            await this.context.globalState.update('gitsy.aiConsentGiven', false);
            vscode.window.showInformationMessage('AI pre-flight checks disabled.');
        }
        else {
            vscode.window.showInformationMessage(`AI provider: ${selected.label}`);
        }
    }
    httpsPost(url, body, headers) {
        return new Promise((resolve, reject) => {
            const urlObj = new URL(url);
            const req = https.request({
                hostname: urlObj.hostname,
                path: urlObj.pathname + urlObj.search,
                method: 'POST',
                headers: { ...headers, 'Content-Length': Buffer.byteLength(body).toString() },
                timeout: 20000
            }, res => {
                let data = '';
                res.on('data', c => { data += c; });
                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 400) {
                        reject(new Error(`Gemini HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
                    }
                    else {
                        resolve(data);
                    }
                });
                res.on('error', reject);
            });
            req.on('timeout', () => { req.destroy(); reject(new Error('Gemini request timed out')); });
            req.on('error', reject);
            req.write(body);
            req.end();
        });
    }
}
exports.AIPreflightService = AIPreflightService;
//# sourceMappingURL=AIPreflightService.js.map