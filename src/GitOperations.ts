import * as vscode from 'vscode';
import { GitService } from './gitService';
import { AuthService } from './authService';
import { Logger } from './logger';
import { Cache } from './cache';

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

        const editor = vscode.window.activeTextEditor;
        if (editor?.document?.uri?.fsPath) {
            try {
                const fileDir = require('path').dirname(editor.document.uri.fsPath);
                const gs = new GitService(fileDir);
                if (await gs.isRepo()) {
                    return fileDir;
                }
            } catch (e) {
                Logger.debug('Active editor file not in a git repo', { error: e });
            }
        }

        if (vscode.workspace.workspaceFolders.length === 1) {
            return vscode.workspace.workspaceFolders[0].uri.fsPath;
        }

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
        await gitService.addAll();
        await gitService.commit(fpMsg);
        return await gitService.push();
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
            const { owner, repo } = this.parseGitHubUrl(remoteUrl);
            const token = await this.context.secrets.get("gitwise.githubPat");

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
        const token = await this.context.secrets.get('gitwise.githubPat');
        if (!token) {
            // Fallback to local git if no token
            return await gitService.getCurrentRepoBranches();
        }

        try {
            const remoteUrl = await gitService.getRemote();
            const { owner, repo } = this.parseGitHubUrl(remoteUrl);
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

        const gitService = new GitService(_repoPath);
        const token = await this.context.secrets.get('gitwise.githubPat');

        try {
            const remoteUrl = await gitService.getRemote();
            if (token && remoteUrl) {
                const { owner, repo } = this.parseGitHubUrl(remoteUrl);
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

    private parseGitHubUrl(url: string): { owner: string; repo: string } {
        let owner = '';
        let repo = '';

        if (url.startsWith('http')) {
            const parts = url.split('/');
            owner = parts[parts.length - 2] || '';
            repo = (parts[parts.length - 1] || '').replace('.git', '');
        } else if (url.startsWith('git@')) {
            const parts = url.split(':');
            const path = parts[1] || '';
            const pathParts = path.split('/');
            owner = pathParts[0] || '';
            repo = (pathParts[1] || '').replace('.git', '');
        }

        return { owner, repo };
    }

    public clearCache(): void {
        this.branchCache.clear();
    }
}
