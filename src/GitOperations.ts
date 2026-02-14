import * as vscode from 'vscode';
import { GitService, FastPushIssue } from './gitService';
import { AuthService } from './authService';
import { Logger } from './logger';
import { Cache } from './cache';
import { parseGitHubUrl } from './utils';

export class GitOperations {
    private branchCache = new Cache<string[]>(300); // 5 min cache

    constructor(
        private context: vscode.ExtensionContext,
        private authService: AuthService
    ) {}

    public async getRepoSelection(): Promise<string | undefined> {
        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
            vscode.window.showErrorMessage("No workspace folder open");
            return undefined;
        }

        // Try to resolve workspace folder from active editor
        const editor = vscode.window.activeTextEditor;
        if (editor?.document?.uri?.fsPath) {
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
            if (workspaceFolder) {
                try {
                    const gs = new GitService(workspaceFolder.uri.fsPath);
                    if (await gs.isRepo()) {
                        return workspaceFolder.uri.fsPath;
                    }
                } catch (e) {
                    Logger.debug('Active editor workspace folder not a git repo', { error: e });
                }
            }
        }

        // Single workspace — use it directly
        if (vscode.workspace.workspaceFolders.length === 1) {
            return vscode.workspace.workspaceFolders[0].uri.fsPath;
        }

        // Multi-root workspace — prompt user to pick
        const items = vscode.workspace.workspaceFolders.map(folder => ({
            label: folder.name,
            description: folder.uri.fsPath,
            path: folder.uri.fsPath
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: "Select a repository"
        });

        return selected?.path;
    }

    public async executeGitAction(action: string, payload?: any): Promise<string> {
        const repoPath = await this.getRepoSelection();
        if (!repoPath) {
            throw new Error('No repository selected');
        }

        const gitService = new GitService(repoPath);

        if (action !== 'init' && !(await gitService.isRepo())) {
            const init = await vscode.window.showInformationMessage(
                "This folder is not a git repository. Do you want to initialize it?",
                "Yes", "No"
            );
            if (init === "Yes") {
                await gitService.init();
                vscode.window.showInformationMessage("Repository initialized!");
                return "Repository initialized";
            } else {
                throw new Error('Operation cancelled - not a git repository');
            }
        }

        switch (action) {
            case "status":
                return await gitService.getStatus();
            case "push":
                return await gitService.push();
            case "pull":
                return await gitService.pull();
            case "fetch":
                return await gitService.fetch();
            case "commit":
                return await this.handleCommit(gitService, payload);
            case "fast-push":
                return await this.handleFastPush(gitService, payload);
            case "stash":
                return await this.handleStash(gitService);
            case "set-remote":
                return await this.handleSetRemote(gitService, payload);
            case "create-branch":
                return await this.handleCreateBranch(gitService, repoPath, payload);
            case "delete-branch":
                return await this.handleDeleteBranch(gitService, repoPath, payload);
            case "switch-branch":
                return await this.handleSwitchBranch(gitService, payload);
            case "merge-branch":
                return await this.handleMergeBranch(gitService, payload);
            default:
                throw new Error(`Unknown action: ${action}`);
        }
    }

    private async handleCommit(gitService: GitService, payload?: any): Promise<string> {
        const commitMsg = payload?.message || await vscode.window.showInputBox({
            prompt: "Enter commit message",
            placeHolder: "feat: added new feature"
        });
        if (!commitMsg) {
            throw new Error('Commit message required');
        }
        return await gitService.commit(commitMsg);
    }

    private async handleFastPush(gitService: GitService, _payload?: any): Promise<string> {
        const fpMsg = await vscode.window.showInputBox({
            prompt: "Enter commit message for Fast Push",
            value: "Fast Push: Auto-commit"
        });
        if (!fpMsg) {
            throw new Error('Commit message required');
        }

        // ── Pre-flight diagnostics ──
        const issues = await gitService.diagnoseFastPushIssues();
        if (issues.length > 0) {
            const resolved = await this.resolveIssuesInteractively(gitService, issues);
            if (!resolved) {
                throw new Error('Fast Push cancelled — unresolved issues remain.');
            }
        }

        // ── Stage all files ──
        await gitService.addAll();

        // ── Commit (tolerate nothing-to-commit) ──
        try {
            await gitService.commit(fpMsg);
        } catch (e: any) {
            const msg = e.message || '';
            if (msg.includes('nothing to commit') || msg.includes('working tree clean') || msg.includes('no changes added to commit') || msg.includes('nothing added to commit')) {
                Logger.info('Nothing new to commit, proceeding to push');
            } else {
                throw e;
            }
        }

        // ── Push (handle push-specific failures) ──
        try {
            return await gitService.push();
        } catch (pushErr: any) {
            const pushMsg = pushErr.message || '';
            // If push fails because we're behind, offer to pull --rebase and retry
            if (pushMsg.includes('rejected') || pushMsg.includes('non-fast-forward') || pushMsg.includes('fetch first') || pushMsg.includes('failed to push')) {
                const pullFirst = await vscode.window.showWarningMessage(
                    'Push was rejected because the remote has newer commits. Pull with rebase and retry?',
                    { modal: true, detail: 'This will replay your commits on top of the remote changes. Your work will not be lost.' },
                    'Pull & Retry', 'Cancel'
                );
                if (pullFirst === 'Pull & Retry') {
                    await gitService.pullRebase();
                    return await gitService.push();
                }
            }
            throw pushErr;
        }
    }

    /**
     * Present each issue to the user with an explanation + resolution options.
     * Returns true if all issues were resolved or skipped, false if the user cancels.
     */
    private async resolveIssuesInteractively(gitService: GitService, issues: FastPushIssue[]): Promise<boolean> {
        // Separate blocking issues from non-blocking
        const blocking = issues.filter(i => !i.autoFixable);
        const fixable = issues.filter(i => i.autoFixable);

        // Show blocking issues first — user MUST handle these manually
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
            const resolved = await this.handleFixableIssue(gitService, issue);
            if (!resolved) {
                return false;
            }
        }

        return true;
    }

    /**
     * Handle a single auto-fixable issue: explain, confirm, fix.
     */
    private async handleFixableIssue(gitService: GitService, issue: FastPushIssue): Promise<boolean> {
        switch (issue.id) {
            case 'no-repo': {
                const choice = await vscode.window.showWarningMessage(
                    `⚠️ ${issue.title}`,
                    { modal: true, detail: `${issue.description}\n\n💡 Solution: ${issue.resolution}` },
                    'Initialize Repository', 'Cancel'
                );
                if (choice === 'Initialize Repository') {
                    await gitService.init();
                    vscode.window.showInformationMessage('✅ Git repository initialized.');
                    return true;
                }
                return false;
            }

            case 'no-remote': {
                const url = await vscode.window.showInputBox({
                    prompt: '⚠️ No remote URL configured. Enter the remote repository URL:',
                    placeHolder: 'https://github.com/username/repo.git',
                    ignoreFocusOut: true
                });
                if (url) {
                    await gitService.setRemote(url);
                    vscode.window.showInformationMessage('✅ Remote URL set.');
                    return true;
                }
                return false;
            }

            case 'branches-diverged':
            case 'behind-remote': {
                const choice = await vscode.window.showWarningMessage(
                    `⚠️ ${issue.title}`,
                    { modal: true, detail: `${issue.description}\n\n💡 Solution: ${issue.resolution}` },
                    'Pull with Rebase', 'Cancel'
                );
                if (choice === 'Pull with Rebase') {
                    try {
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
                    } else {
                        vscode.window.showErrorMessage('Failed to remove lock file.');
                        return false;
                    }
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

    private async handleStash(gitService: GitService): Promise<string> {
        const stashMsg = await vscode.window.showInputBox({
            prompt: "Enter stash message (optional)"
        });
        return await gitService.stash(stashMsg);
    }

    private async handleSetRemote(gitService: GitService, payload?: any): Promise<string> {
        const remoteUrl = payload?.url || await vscode.window.showInputBox({
            prompt: "Enter remote URL",
            placeHolder: "https://github.com/username/repo.git"
        });
        if (!remoteUrl) {
            throw new Error('Remote URL required');
        }
        return await gitService.setRemote(remoteUrl);
    }

    private async handleCreateBranch(gitService: GitService, repoPath: string, payload?: any): Promise<string> {
        try {
            // Clear cache and fetch fresh branches
            this.branchCache.clear();
            await gitService.runGitCommand('git fetch origin --prune');
        } catch (e) {
            Logger.warn('Failed to fetch before creating branch', { error: e });
        }

        const remoteBranches = await this.getWorkspaceRemoteBranches(repoPath);
        let name = payload?.name;

        while (true) {
            if (!name) {
                name = await vscode.window.showInputBox({
                    prompt: "Enter new branch name",
                    placeHolder: "Branch name"
                });
                if (!name) {
                    throw new Error('Branch name required');
                }
            }

            const remoteConflict = remoteBranches.includes(name);
            const localConflict = await gitService.hasLocalBranch(name);

            if (remoteConflict) {
                await vscode.window.showWarningMessage(
                    `Branch '${name}' already exists on remote. Choose a different name.`,
                    'OK'
                );
                name = undefined;
                continue;
            }

            if (localConflict) {
                const repoName = await gitService.getRepoName();
                const choice = await vscode.window.showQuickPick([
                    { label: 'Switch', description: `Switch to existing local branch '${name}'` },
                    { label: 'Overwrite', description: `Delete '${name}' and create fresh` },
                    { label: 'Use different name', description: 'Enter another branch name' },
                    { label: 'Cancel', description: 'Abort creating branch' }
                ], { placeHolder: `Branch '${name}' already exists locally in '${repoName}'` });

                if (!choice || choice.label === 'Cancel') {
                    throw new Error('Branch creation cancelled');
                }
                if (choice.label === 'Switch') {
                    const result = await gitService.switchBranch(name);
                    vscode.window.showInformationMessage(`Switched to existing branch '${name}'.`);
                    return result;
                }
                if (choice.label === 'Overwrite') {
                    await gitService.deleteBranch(name);
                }
                if (choice.label === 'Use different name') {
                    name = undefined;
                    continue;
                }
            }

            await gitService.createBranch(name);

            const created = await gitService.hasLocalBranch(name);
            if (!created) {
                const branches = await gitService.getBranches();
                Logger.error('Create branch failed validation', { name, branches });
                throw new Error(`Branch '${name}' was not found locally after creation attempt.`);
            }

            const pushNow = await vscode.window.showInformationMessage(
                `Created local branch '${name}'. Push it to remote now?`,
                { modal: false },
                'Push', 'Later'
            );
            if (pushNow === 'Push') {
                return await gitService.push();
            } else {
                return `Created local branch ${name} (not pushed)`;
            }
        }
    }

    private async handleDeleteBranch(gitService: GitService, _repoPath: string, payload?: any): Promise<string> {
        // Clear cache and get fresh branches from GitHub API
        this.branchCache.clear();
        const branches = await this.getGitHubBranches(gitService);
        const delBranch = payload?.name || await vscode.window.showQuickPick(branches, {
            placeHolder: "Select branch to delete"
        });
        if (!delBranch) {
            throw new Error('Branch selection required');
        }

        const isLocal = await gitService.hasLocalBranch(delBranch);
        const isRemote = await gitService.hasRemoteBranch(delBranch);

        if (!isLocal && !isRemote) {
            throw new Error(`Branch '${delBranch}' not found locally or on remote.`);
        }

        let message = `Are you sure you want to delete branch '${delBranch}'?`;
        if (isLocal && isRemote) {
            message = `Are you sure you want to delete branch '${delBranch}' from BOTH local and remote?`;
        } else if (isRemote) {
            message = `Are you sure you want to delete branch '${delBranch}' from remote?`;
        } else {
            message = `Are you sure you want to delete local branch '${delBranch}'?`;
        }

        const confirm = await vscode.window.showWarningMessage(
            message,
            { modal: true },
            "Delete"
        );
        if (confirm !== "Delete") {
            throw new Error('Branch deletion cancelled');
        }

        if (isRemote) {
            const remoteUrl = await gitService.getRemote();
            const { owner, repo } = parseGitHubUrl(remoteUrl);
            const token = await this.context.secrets.get("gitsy.githubPat");

            if (token && owner && repo) {
                try {
                    await this.authService.deleteRepoBranch(token, owner, repo, delBranch);
                } catch (e: any) {
                    Logger.warn('Remote delete failed via API, trying git command', { error: e });
                    await gitService.deleteRemoteBranch(delBranch);
                }
            } else {
                await gitService.deleteRemoteBranch(delBranch);
            }
        }

        if (isLocal) {
            await gitService.deleteBranch(delBranch);
        }

        await gitService.runGitCommand('git fetch -p');
        this.branchCache.clear();
        return `Deleted branch ${delBranch} ${isRemote ? '(Local & Remote)' : '(Local)'}`;
    }

    private async handleSwitchBranch(gitService: GitService, payload?: any): Promise<string> {
        // Clear cache and get fresh branches from GitHub API
        this.branchCache.clear();
        const branches = await this.getGitHubBranches(gitService);
        const switchBranch = payload?.name || await vscode.window.showQuickPick(branches, {
            placeHolder: "Select branch to switch to"
        });
        if (!switchBranch) {
            throw new Error('Branch selection required');
        }
        return await gitService.switchBranch(switchBranch);
    }

    private async handleMergeBranch(gitService: GitService, payload?: any): Promise<string> {
        // Clear cache and get fresh branches from GitHub API
        this.branchCache.clear();
        const branches = await this.getGitHubBranches(gitService);
        const mergeBranch = payload?.name || await vscode.window.showQuickPick(branches, {
            placeHolder: "Select branch to merge into current"
        });
        if (!mergeBranch) {
            throw new Error('Branch selection required');
        }
        return await gitService.mergeBranch(mergeBranch);
    }

    private async getGitHubBranches(gitService: GitService): Promise<string[]> {
        const token = await this.context.secrets.get('gitsy.githubPat');
        if (!token) {
            // Fallback to local git if no token
            return await gitService.getCurrentRepoBranches();
        }

        try {
            const remoteUrl = await gitService.getRemote();
            const { owner, repo } = parseGitHubUrl(remoteUrl);
            if (owner && repo) {
                const branches = await this.authService.getRepoBranches(token, owner, repo);
                if (branches && branches.length > 0) {
                    return branches;
                }
            }
        } catch (e) {
            Logger.warn('Failed to fetch branches via GitHub API, falling back to git', { error: e });
        }

        // Fallback to local git
        return await gitService.getCurrentRepoBranches();
    }

    public async getWorkspaceRemoteBranches(_repoPath?: string): Promise<string[]> {
        const cacheKey = `branches:${_repoPath || 'default'}`;
        const cached = this.branchCache.get(cacheKey);
        if (cached) {
            return cached;
        }

        const token = await this.context.secrets.get('gitsy.githubPat');
        const gitService = new GitService(_repoPath);

        try {
            const remoteUrl = await gitService.getRemote();
            if (token && remoteUrl) {
                const { owner, repo } = parseGitHubUrl(remoteUrl);
                if (owner && repo) {
                    const branches = await this.authService.getRepoBranches(token, owner, repo);
                    if (branches && branches.length > 0) {
                        this.branchCache.set(cacheKey, branches);
                        return branches;
                    }
                }
            }
        } catch (e) {
            Logger.warn('Failed to fetch branches via API, falling back to git', { error: e });
        }

        try {
            const branches = await gitService.getOriginBranches();
            this.branchCache.set(cacheKey, branches);
            return branches;
        } catch (e) {
            Logger.error('Failed to fetch branches', e);
            return [];
        }
    }

    public clearCache(): void {
        this.branchCache.clear();
    }
}
