import * as vscode from 'vscode';
import * as path from 'path';
import { GitService, FastPushIssue } from './gitService';
import { AuthService } from './authService';
import { GitOperations } from './GitOperations';
import { Logger } from './logger';
import { WebviewMessage, Settings, FastPushPayload } from './types';
import { parseGitHubUrl } from './utils';

export class MessageHandler {
    constructor(
        private context: vscode.ExtensionContext,
        private authService: AuthService,
        private gitOperations: GitOperations,
        private postMessage: (message: any) => void,
        private refreshStats: () => Promise<void>,
        private checkAuth: () => Promise<void>
    ) {}

    public async handleMessage(data: WebviewMessage): Promise<void> {
        if (!data || typeof data.type !== 'string') {
            Logger.warn('Received invalid message from webview', { data });
            return;
        }

        Logger.info('Webview message received', { type: data.type, action: data.action });
        console.log('[Gitsy] Message received:', data.type, data.action || '');

        try {
            switch (data.type) {
                case 'get-auth-state':
                    await this.checkAuth();
                    break;
                case 'error':
                    vscode.window.showErrorMessage(data.value);
                    break;
                case 'onInfo':
                    if (data.value) {
                        vscode.window.showInformationMessage(data.value);
                    }
                    break;
                case 'onError':
                    if (data.value) {
                        vscode.window.showErrorMessage(data.value);
                    }
                    break;
                case 'git-action':
                    await this.handleGitAction(data.action!, data.payload);
                    break;
                case 'refresh-stats':
                    await this.refreshStats();
                    break;
                case 'save-settings':
                    await this.saveSettings(data.value);
                    break;
                case 'login-github':
                    await this.handleGitHubLogin();
                    break;
                case 'open-external':
                    if (data.value) {
                        await vscode.env.openExternal(vscode.Uri.parse(data.value));
                    }
                    break;
                case 'logout-github':
                    await this.handleGitHubLogout();
                    break;
                case 'get-repos':
                    await this.handleGetRepos();
                    break;
                case 'get-remote-branches':
                    await this.handleGetRemoteBranches(data.value);
                    break;
                case 'fast-push-execute':
                    await this.handleFastPushExecute(data.payload);
                    break;
                case 'pr-checkout':
                    await this.handlePrCheckout(data.value);
                    break;
                case 'open-file':
                    await this.handleOpenFile(data.value);
                    break;
                case 'pr-merge':
                    await this.handlePrMerge(data.value);
                    break;
                default:
                    Logger.warn('Unknown message type', { type: data.type });
            }
        } catch (error) {
            Logger.error('Error handling message', error, { type: data.type });
            vscode.window.showErrorMessage(`Operation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async handleGitAction(action: string, payload?: any): Promise<void> {
        Logger.info(`Starting git action: ${action}`);
        this.postMessage({ type: 'set-loading', value: true });
        this.postMessage({ type: 'action-started', value: action });
        try {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `Gitsy: Running ${action}...`,
                    cancellable: false
                },
                async () => {
                    const result = await this.gitOperations.executeGitAction(action, payload);
                    vscode.window.showInformationMessage(`Git ${action} success: ${result}`);
                    await this.refreshStats();

                    if (action === 'switch-branch' || action === 'create-branch' || action === 'delete-branch') {
                        await new Promise(resolve => setTimeout(resolve, 500));
                        await this.refreshStats();
                    }
                }
            );
        } catch (error: any) {
            Logger.error(`Git action '${action}' failed`, error);
            vscode.window.showErrorMessage(`Git ${action} failed: ${error.message}`);
        } finally {
            this.postMessage({ type: 'set-loading', value: false });
            this.postMessage({ type: 'action-finished', value: action });
        }
    }

    private async saveSettings(_settings: Settings): Promise<void> {
        // Settings are now managed via GitHub OAuth - no manual PAT needed
        vscode.window.showInformationMessage("Settings saved.");
        await this.checkAuth();
    }

    private async handleGitHubLogin(): Promise<void> {
        this.postMessage({ type: 'set-loading', value: true });
        try {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'Gitsy: Connecting to GitHub...',
                    cancellable: false
                },
                async (progress) => {
                    progress.report({ increment: 20, message: 'Requesting authentication...' });

                    // Request minimal scopes for Git operations
                    const scopes = [
                        'repo',              // Read/write access to repositories
                        'read:user',         // Read user profile info
                        'user:email'         // Read user email addresses
                    ];
                    const session = await vscode.authentication.getSession('github', scopes, {
                        createIfNone: true,
                        clearSessionPreference: true
                    });

                    if (session) {
                        progress.report({ increment: 50, message: 'Storing credentials...' });
                        await Promise.all([
                            this.context.secrets.store("gitsy.githubPat", session.accessToken),
                            this.context.globalState.update('gitsy.wasAuthenticated', true),
                            this.context.globalState.update('gitsy.cachedUser', session.account.label)
                        ]);

                        progress.report({ increment: 20, message: 'Loading profile...' });
                        Logger.info('GitHub OAuth authentication successful', { user: session.account.label });

                        // Show dashboard immediately
                        this.postMessage({ type: 'show-dashboard' });
                        this.postMessage({ type: 'github-connected', user: session.account.label });
                        this.postMessage({
                            type: 'update-user-quick',
                            value: { name: session.account.label, login: session.account.label, email: 'Loading...' }
                        });

                        progress.report({ increment: 10, message: 'Loading workspace data...' });
                        // Full refresh in background
                        await this.refreshStats();

                        vscode.window.showInformationMessage(`Authenticated as ${session.account.label}`);
                    }
                }
            );
        } catch (e: any) {
            Logger.error('GitHub OAuth authentication failed', e);
            if (e.message?.includes('User did not consent')) {
                vscode.window.showWarningMessage('GitHub authentication was cancelled.');
            } else {
                vscode.window.showErrorMessage(`GitHub Login failed: ${e.message}`);
            }
        } finally {
            this.postMessage({ type: 'set-loading', value: false });
        }
    }

    private async handleGitHubLogout(): Promise<void> {
        const confirm = await vscode.window.showWarningMessage(
            "Are you sure you want to logout? This will remove your GitHub token from Gitsy.",
            { modal: true },
            "Logout"
        );

        if (confirm !== "Logout") {
            return;
        }

        // Clear token + cached auth state
        await Promise.all([
            this.context.secrets.delete("gitsy.githubPat"),
            this.context.globalState.update('gitsy.wasAuthenticated', false),
            this.context.globalState.update('gitsy.cachedUser', '')
        ]);
        Logger.info('User logged out from GitHub');
        vscode.window.showInformationMessage("Logged out from Gitsy.");
        this.postMessage({ type: 'show-setup' });
    }

    private async handleGetRepos(): Promise<void> {
        const token = await this.context.secrets.get("gitsy.githubPat");
        if (!token) {
            vscode.window.showErrorMessage('Please login to GitHub first');
            this.postMessage({ type: 'update-repos', value: [] });
            return;
        }

        try {
            const repos = await this.authService.getUserRepos(token);
            this.postMessage({ type: 'update-repos', value: repos });
        } catch (e: any) {
            Logger.error('Failed to fetch repos', e);
            vscode.window.showErrorMessage(`Failed to load repositories: ${e.message}`);
            this.postMessage({ type: 'update-repos', value: [] });
        }
    }

    private async handleGetRemoteBranches(repoUrl: string): Promise<void> {
        const token = await this.context.secrets.get("gitsy.githubPat");
        if (!token) {
            this.postMessage({ type: 'update-branches', value: ['main', 'master'] });
            return;
        }

        try {
            const { owner, repo } = parseGitHubUrl(repoUrl);
            if (owner && repo) {
                const branches = await this.authService.getRepoBranches(token, owner, repo);
                this.postMessage({ type: 'update-branches', value: branches.length > 0 ? branches : ['main'] });
            } else {
                this.postMessage({ type: 'update-branches', value: ['main', 'master'] });
            }
        } catch (e) {
            Logger.error('Failed to fetch branches', e);
            this.postMessage({ type: 'update-branches', value: ['main', 'master'] });
        }
    }

    private async handleFastPushExecute(payload: FastPushPayload): Promise<void> {
        const repoPath = await this.gitOperations.getRepoSelection();
        if (!repoPath) {
            vscode.window.showErrorMessage('No workspace folder open. Please open a folder first.');
            return;
        }

        const token = await this.context.secrets.get("gitsy.githubPat");
        const gitService = new GitService(repoPath);

        try {
            this.postMessage({ type: 'set-loading', value: true });

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'Gitsy: Fast Push',
                    cancellable: false
                },
                async (progress) => {
                    // ── Step 1: Ensure we have a repo ──
                    if (!(await gitService.isRepo())) {
                        const initConfirm = await vscode.window.showWarningMessage(
                            `Folder ${repoPath} is not a git repository. Initialize it?`,
                            { modal: true },
                            'Initialize'
                        );
                        if (initConfirm === 'Initialize') {
                            progress.report({ message: 'Initializing repository...' });
                            await gitService.init();
                        } else {
                            return;
                        }
                    }

                    // ── Step 2: Create remote repo / set remote ──
                    let remoteUrl = payload.repoUrl;

                    // Validate branch name — reject loading placeholders
                    let branch = payload.branch;
                    if (!branch || branch === 'Loading...' || branch.startsWith('Loading') || !/^[a-zA-Z0-9_\/-]+$/.test(branch)) {
                        Logger.warn('Invalid branch name received, defaulting to main', { branch });
                        branch = 'main';
                    }

                    if (payload.repoType === 'new') {
                        if (!token) {
                            throw new Error("GitHub login required to create repo");
                        }
                        if (!payload.newRepoName) {
                            throw new Error("Repository name required");
                        }

                        progress.report({ message: 'Creating GitHub repository...' });
                        const newRepo = await this.authService.createRepo(
                            token,
                            payload.newRepoName,
                            payload.newRepoPrivate || false,
                            payload.newRepoDesc
                        );
                        remoteUrl = newRepo.clone_url;
                        vscode.window.showInformationMessage(`Created GitHub repository: ${newRepo.full_name}`);
                    }

                    if (remoteUrl) {
                        progress.report({ message: 'Setting remote...' });
                        await gitService.setRemote(remoteUrl);
                    }

                    // ── Step 3: Check if repo has any commits yet ──
                    let hasCommits = true;
                    try {
                        await gitService.runGitCommand('git rev-parse HEAD');
                    } catch {
                        hasCommits = false;
                    }

                    // ── Step 4: Switch branch if needed ──
                    if (hasCommits) {
                        const currentBranch = await gitService.getCurrentBranch();
                        if (currentBranch !== branch) {
                            progress.report({ message: `Switching to branch ${branch}...` });
                            const hasLocal = await gitService.hasLocalBranch(branch);
                            if (!hasLocal) {
                                await gitService.createBranch(branch);
                            } else {
                                await gitService.switchBranch(branch);
                            }
                        }
                    }

                    // ── Step 5: Pre-flight diagnostics ──
                    progress.report({ message: 'Running pre-flight checks...' });
                    const issues = await gitService.diagnoseFastPushIssues();

                    // Filter out issues already handled above + false positives for new repos
                    const relevantIssues = issues.filter(i => {
                        // Already handled by steps above
                        if (i.id === 'no-repo' || i.id === 'no-remote') { return false; }
                        // For brand new repos (no commits), these are expected — not real issues
                        if (!hasCommits && (i.id === 'detached-head' || i.id === 'upstream-missing' || i.id === 'upstream-broken' || i.id === 'nothing-to-do')) { return false; }
                        return true;
                    });

                    if (relevantIssues.length > 0) {
                        const resolved = await this.resolveIssuesInteractively(gitService, relevantIssues, progress);
                        if (!resolved) {
                            vscode.window.showWarningMessage('Fast Push cancelled — unresolved issues remain.');
                            return;
                        }
                    }

                    // ── Step 6: Stage all files ──
                    progress.report({ message: 'Staging files...' });
                    await gitService.addAll();

                    // ── Step 7: Commit ──
                    progress.report({ message: 'Committing...' });
                    try {
                        await gitService.commit(payload.message || 'Fast Push: Auto-commit');
                    } catch (e: any) {
                        const msg = e.message || '';
                        if (msg.includes('nothing to commit') || msg.includes('working tree clean') || msg.includes('no changes added to commit') || msg.includes('nothing added to commit')) {
                            Logger.info('Nothing new to commit, proceeding to push');
                        } else {
                            throw e;
                        }
                    }

                    // ── Step 8: Rename branch on first commit ──
                    if (!hasCommits) {
                        try {
                            await gitService.renameBranch(branch);
                        } catch (e) {
                            Logger.warn('Branch rename after first commit failed (non-critical)', { error: e });
                        }
                    }

                    // ── Step 9: Push (with rejection recovery) ──
                    progress.report({ message: 'Pushing to remote...' });
                    try {
                        await gitService.push();
                    } catch (pushErr: any) {
                        const pushMsg = pushErr.message || '';
                        if (pushMsg.includes('rejected') || pushMsg.includes('non-fast-forward') || pushMsg.includes('fetch first') || pushMsg.includes('failed to push')) {
                            const pullFirst = await vscode.window.showWarningMessage(
                                'Push was rejected — the remote has newer commits.',
                                {
                                    modal: true,
                                    detail: 'This can happen if someone else pushed while you were working. Pulling with rebase will replay your commits on top of the remote changes. Your work will not be lost.'
                                },
                                'Pull & Retry', 'Cancel'
                            );
                            if (pullFirst === 'Pull & Retry') {
                                progress.report({ message: 'Pulling with rebase...' });
                                await gitService.pullRebase();
                                progress.report({ message: 'Retrying push...' });
                                await gitService.push();
                            } else {
                                throw new Error('Push cancelled by user after rejection.');
                            }
                        } else {
                            throw pushErr;
                        }
                    }

                    vscode.window.showInformationMessage('Fast Push completed successfully! 🚀');
                    await this.refreshStats();
                }
            );
        } catch (error: any) {
            Logger.error('Fast Push failed', error);
            vscode.window.showErrorMessage(`Fast Push failed: ${error.message}`);
        } finally {
            this.postMessage({ type: 'set-loading', value: false });
        }
    }

    /**
     * Interactive issue resolver for Fast Push pre-flight issues.
     */
    private async resolveIssuesInteractively(
        gitService: GitService,
        issues: FastPushIssue[],
        progress: vscode.Progress<{ message?: string }>
    ): Promise<boolean> {
        const blocking = issues.filter(i => !i.autoFixable);
        const fixable = issues.filter(i => i.autoFixable);

        // Show blocking issues — user must handle manually
        for (const issue of blocking) {
            const choice = await vscode.window.showWarningMessage(
                `⚠️ ${issue.title}`,
                {
                    modal: true,
                    detail: `${issue.description}\n\n💡 Solution: ${issue.resolution}`
                },
                'I Fixed It — Continue', 'Cancel Fast Push'
            );
            if (choice !== 'I Fixed It — Continue') {
                return false;
            }
        }

        // Handle auto-fixable issues with user confirmation
        for (const issue of fixable) {
            const resolved = await this.handleFixableIssue(gitService, issue, progress);
            if (!resolved) {
                return false;
            }
        }

        return true;
    }

    /**
     * Handle a single auto-fixable issue.
     */
    private async handleFixableIssue(
        gitService: GitService,
        issue: FastPushIssue,
        progress: vscode.Progress<{ message?: string }>
    ): Promise<boolean> {
        switch (issue.id) {
            case 'branches-diverged':
            case 'behind-remote': {
                const choice = await vscode.window.showWarningMessage(
                    `⚠️ ${issue.title}`,
                    { modal: true, detail: `${issue.description}\n\n💡 Solution: ${issue.resolution}` },
                    'Pull with Rebase', 'Cancel'
                );
                if (choice === 'Pull with Rebase') {
                    try {
                        progress.report({ message: 'Pulling with rebase...' });
                        await gitService.pullRebase();
                        vscode.window.showInformationMessage('✅ Pulled with rebase successfully.');
                        return true;
                    } catch (e: any) {
                        vscode.window.showErrorMessage(`Pull --rebase failed: ${e.message}. Resolve conflicts manually.`);
                        return false;
                    }
                }
                return false;
            }

            case 'detached-head': {
                const branchName = await vscode.window.showInputBox({
                    prompt: '⚠️ You are in detached HEAD state. Enter a branch name to save your work:',
                    placeHolder: 'my-branch',
                    ignoreFocusOut: true
                });
                if (branchName) {
                    await gitService.createBranchFromDetachedHead(branchName);
                    vscode.window.showInformationMessage(`✅ Created and switched to branch '${branchName}'.`);
                    return true;
                }
                return false;
            }

            case 'stale-lock': {
                const choice = await vscode.window.showWarningMessage(
                    `⚠️ ${issue.title}`,
                    { modal: true, detail: `${issue.description}\n\n💡 Solution: ${issue.resolution}` },
                    'Remove Lock File', 'Cancel'
                );
                if (choice === 'Remove Lock File') {
                    const removed = await gitService.removeStaleLockFile();
                    if (removed) {
                        vscode.window.showInformationMessage('✅ Stale lock file removed.');
                        return true;
                    }
                    vscode.window.showErrorMessage('Failed to remove lock file.');
                    return false;
                }
                return false;
            }

            case 'upstream-missing': {
                const choice = await vscode.window.showWarningMessage(
                    `⚠️ ${issue.title}`,
                    { modal: true, detail: `${issue.description}\n\n💡 Solution: ${issue.resolution}` },
                    'Continue — Push Will Create It', 'Cancel'
                );
                return choice === 'Continue — Push Will Create It';
            }

            case 'upstream-broken': {
                const choice = await vscode.window.showWarningMessage(
                    `⚠️ ${issue.title}`,
                    { modal: true, detail: `${issue.description}\n\n💡 Solution: ${issue.resolution}` },
                    'Fix Upstream Tracking', 'Cancel'
                );
                if (choice === 'Fix Upstream Tracking') {
                    try {
                        progress.report({ message: 'Fixing upstream tracking...' });
                        await gitService.fixUpstreamTracking();
                        vscode.window.showInformationMessage('✅ Upstream tracking fixed.');
                        return true;
                    } catch (e: any) {
                        vscode.window.showErrorMessage(`Failed to fix upstream: ${e.message}`);
                        return false;
                    }
                }
                return false;
            }

            case 'nothing-to-do': {
                await vscode.window.showInformationMessage(
                    'ℹ️ Nothing to push — your branch is clean and up to date with remote.',
                    { modal: true }
                );
                return false;
            }

            default: {
                const choice = await vscode.window.showWarningMessage(
                    `⚠️ ${issue.title}`,
                    { modal: true, detail: `${issue.description}\n\n💡 Solution: ${issue.resolution}` },
                    'Continue Anyway', 'Cancel'
                );
                return choice === 'Continue Anyway';
            }
        }
    }

    private async handlePrCheckout(value: any): Promise<void> {
        const { prNumber } = value;
        const repoPath = await this.gitOperations.getRepoSelection();
        if (!repoPath) {
            return;
        }

        const gitService = new GitService(repoPath);
        try {
            const branch = await gitService.fetchPrBranch(prNumber);
            vscode.window.showInformationMessage(`Checked out PR #${prNumber} to branch '${branch}'`);
            await this.refreshStats();
        } catch (e: any) {
            Logger.error('PR checkout failed', e);
            vscode.window.showErrorMessage(`Failed to checkout PR: ${e.message}`);
        }
    }

    private async handlePrMerge(value: any): Promise<void> {
        const { prNumber } = value;
        const repoPath = await this.gitOperations.getRepoSelection();
        if (!repoPath) {
            return;
        }

        const methodItem = await vscode.window.showQuickPick(
            [
                { label: 'Merge', description: 'Create a merge commit', value: 'merge' },
                { label: 'Squash', description: 'Squash and merge', value: 'squash' },
                { label: 'Rebase', description: 'Rebase and merge', value: 'rebase' }
            ],
            { placeHolder: `Select merge method for PR #${prNumber}` }
        );
        if (!methodItem) {
            return;
        }

        const token = await this.context.secrets.get("gitsy.githubPat");
        const gitService = new GitService(repoPath);
        const remoteUrl = await gitService.getRemote();
        const { owner, repo } = parseGitHubUrl(remoteUrl);

        if (!token || !owner || !repo) {
            vscode.window.showErrorMessage("Cannot merge PR: Missing GitHub token or invalid remote.");
            return;
        }

        try {
            await this.authService.mergePullRequest(token, owner, repo, prNumber, methodItem.value as any);
            vscode.window.showInformationMessage(`Merged PR #${prNumber} successfully via ${methodItem.value}!`);
            await this.refreshStats();
        } catch (e: any) {
            Logger.error('PR merge failed', e);
            vscode.window.showErrorMessage(`Failed to merge PR: ${e.message}`);
        }
    }

    private async handleOpenFile(filePath: string): Promise<void> {
        try {
            if (!filePath) { return; }

            const repoPath = await this.gitOperations.getRepoSelection();
            if (!repoPath) { return; }

            // Handle renamed files: "old_path -> new_path"
            let targetPath = filePath;
            if (targetPath.includes(' -> ')) {
                targetPath = targetPath.split(' -> ').pop()!.trim();
            }

            const fullPath = path.join(repoPath, targetPath);

            // Check if it's a directory — don't try to open directories as text
            const fs = await import('fs');
            try {
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) {
                    // Reveal directory in Explorer instead
                    const uri = vscode.Uri.file(fullPath);
                    await vscode.commands.executeCommand('revealInExplorer', uri);
                    return;
                }
            } catch {
                // File might not exist (deleted file) — that's ok, let showTextDocument handle it
            }

            const uri = vscode.Uri.file(fullPath);
            await vscode.window.showTextDocument(uri);
            Logger.info('Opened file from sidebar', { filePath: targetPath });
        } catch (error: any) {
            Logger.error('Failed to open file', error, { filePath });
            vscode.window.showErrorMessage(`Failed to open file: ${error.message}`);
        }
    }
}
