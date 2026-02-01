import * as vscode from 'vscode';
import { GitService } from './gitService';
import { AuthService } from './authService';
import { GitOperations } from './GitOperations';
import { Logger } from './logger';
import { AIService } from './aiService';
import { WebviewMessage, Settings, FastPushPayload } from './types';

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
        if (!data || !data.type) {
            Logger.warn('Received invalid message from webview', { data });
            return;
        }

        Logger.debug('Handling webview message', { type: data.type });

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
                case 'chat-query':
                    await this.handleChatQuery(data.value);
                    break;
                case 'refresh-stats':
                    await this.refreshStats();
                    break;
                case 'save-settings':
                    await this.saveSettings(data.value);
                    break;
                case 'get-settings':
                    await this.sendSettings();
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
        this.postMessage({ type: 'set-loading', value: true });
        try {
            const result = await this.gitOperations.executeGitAction(action, payload);
            vscode.window.showInformationMessage(`Git ${action} success: ${result}`);
            
            // Always refresh stats after git action
            await this.refreshStats();
            
            // For branch operations, add a small delay to ensure git state is updated
            if (action === 'switch-branch' || action === 'create-branch' || action === 'delete-branch') {
                await new Promise(resolve => setTimeout(resolve, 500));
                await this.refreshStats();
            }
        } catch (error: any) {
            Logger.error(`Git action '${action}' failed`, error);
            vscode.window.showErrorMessage(`Git ${action} failed: ${error.message}`);
        } finally {
            this.postMessage({ type: 'set-loading', value: false });
        }
    }

    private async handleChatQuery(query: string): Promise<void> {
        if (!query) {
            return;
        }

        this.postMessage({
            type: "add-chat-message",
            value: { role: "user", content: query }
        });

        try {
            const aiService = new AIService();
            const response = await aiService.getCompletion(query);
            this.postMessage({
                type: "add-chat-message",
                value: { role: "assistant", content: response }
            });
        } catch (error: any) {
            Logger.error('Chat query failed', error);
            this.postMessage({
                type: "add-chat-message",
                value: { role: "system", content: `Error: ${error.message}` }
            });
        }
    }

    private async saveSettings(settings: Settings): Promise<void> {
        try {
            if (settings.apiKey) {
                await this.context.secrets.store("gitwise.apiKey", settings.apiKey);
            }
            if (settings.pat) {
                await this.context.secrets.store("gitwise.githubPat", settings.pat);
            }

            const config = vscode.workspace.getConfiguration("gitwise");
            if (settings.provider) {
                await config.update("apiProvider", settings.provider, vscode.ConfigurationTarget.Global);
            }
            if (settings.baseUrl) {
                await config.update("apiBaseUrl", settings.baseUrl, vscode.ConfigurationTarget.Global);
            }
            if (settings.modelName) {
                await config.update("modelName", settings.modelName, vscode.ConfigurationTarget.Global);
            }

            vscode.window.showInformationMessage("Settings saved successfully!");
            await this.checkAuth();
        } catch (error) {
            Logger.error('Failed to save settings', error);
            throw error;
        }
    }

    private async sendSettings(): Promise<void> {
        const config = vscode.workspace.getConfiguration("gitwise");
        const provider = config.get<string>("apiProvider");
        const baseUrl = config.get<string>("apiBaseUrl");
        const modelName = config.get<string>("modelName");

        this.postMessage({
            type: 'populate-settings',
            value: { provider, baseUrl, modelName }
        });
    }

    private async handleGitHubLogin(): Promise<void> {
        this.postMessage({ type: 'set-loading', value: true });
        try {
            // Request comprehensive read/write access for professional Git operations
            const scopes = [
                'repo',              // Full control of private repositories (read/write)
                'workflow',          // Update GitHub Action workflows
                'write:packages',    // Upload packages to GitHub Package Registry
                'delete:packages',   // Delete packages from GitHub Package Registry
                'admin:org',         // Full control of orgs and teams, read and write org projects
                'admin:public_key',  // Full control of user public keys
                'admin:repo_hook',   // Full control of repository hooks
                'admin:org_hook',    // Full control of organization hooks
                'gist',              // Create gists
                'user',              // Read/write access to profile info
                'read:org'           // Read org and team membership, read org projects
            ];
            const session = await vscode.authentication.getSession('github', scopes, { createIfNone: true });

            if (session) {
                await this.context.secrets.store("gitwise.githubPat", session.accessToken);
                vscode.window.showInformationMessage(`✅ Successfully authenticated as ${session.account.label}`);
                Logger.info('GitHub OAuth authentication successful', { user: session.account.label });
                this.postMessage({ type: 'github-connected', user: session.account.label });
                await this.checkAuth();
            }
        } catch (e: any) {
            Logger.error('GitHub OAuth authentication failed', e);
            vscode.window.showErrorMessage(`GitHub Login failed: ${e.message}`);
        } finally {
            this.postMessage({ type: 'set-loading', value: false });
        }
    }

    private async handleGitHubLogout(): Promise<void> {
        const confirm = await vscode.window.showWarningMessage(
            "Are you sure you want to logout? This will remove your GitHub token from GitWise.",
            { modal: true },
            "Logout"
        );

        if (confirm !== "Logout") {
            return;
        }

        await this.context.secrets.delete("gitwise.githubPat");
        vscode.window.showInformationMessage("Logged out from GitWise.");
        this.postMessage({ type: 'show-setup' });
    }

    private async handleGetRepos(): Promise<void> {
        const token = await this.context.secrets.get("gitwise.githubPat");
        if (!token) {
            this.postMessage({ type: 'error', value: 'Please login to GitHub first' });
            return;
        }

        try {
            const repos = await this.authService.getUserRepos(token);
            this.postMessage({ type: 'update-repos', value: repos });
        } catch (e: any) {
            Logger.error('Failed to fetch repos', e);
            this.postMessage({ type: 'error', value: `Failed to fetch repos: ${e.message}` });
        }
    }

    private async handleGetRemoteBranches(repoUrl: string): Promise<void> {
        const token = await this.context.secrets.get("gitwise.githubPat");
        if (!token) {
            return;
        }

        try {
            const { owner, repo } = this.parseGitHubUrl(repoUrl);
            if (owner && repo) {
                const branches = await this.authService.getRepoBranches(token, owner, repo);
                this.postMessage({ type: 'update-branches', value: branches });
            }
        } catch (e) {
            Logger.error('Failed to fetch branches', e);
        }
    }

    private async handleFastPushExecute(payload: FastPushPayload): Promise<void> {
        const repoPath = await this.gitOperations.getRepoSelection();
        if (!repoPath) {
            return;
        }

        const gitService = new GitService(repoPath);
        const token = await this.context.secrets.get("gitwise.githubPat");

        try {
            this.postMessage({ type: 'set-loading', value: true });

            if (!(await gitService.isRepo())) {
                const initConfirm = await vscode.window.showWarningMessage(
                    `Folder ${repoPath} is not a git repository. Initialize it?`,
                    { modal: true },
                    'Initialize'
                );
                if (initConfirm === 'Initialize') {
                    await gitService.init();
                } else {
                    return;
                }
            }

            let remoteUrl = payload.repoUrl;
            if (payload.repoType === 'new') {
                if (!token) {
                    throw new Error("GitHub login required to create repo");
                }
                if (!payload.newRepoName) {
                    throw new Error("Repository name required");
                }

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
                await gitService.setRemote(remoteUrl);
            }

            const currentBranch = await gitService.getCurrentBranch();
            if (currentBranch !== payload.branch) {
                const hasLocal = await gitService.hasLocalBranch(payload.branch);
                if (!hasLocal) {
                    await gitService.createBranch(payload.branch);
                } else {
                    await gitService.switchBranch(payload.branch);
                }
            }

            await gitService.addAll();
            await gitService.commit(payload.message);
            await gitService.push();

            vscode.window.showInformationMessage('Fast Push completed successfully! 🚀');
            await this.refreshStats();
        } catch (error: any) {
            Logger.error('Fast Push failed', error);
            vscode.window.showErrorMessage(`Fast Push failed: ${error.message}`);
        } finally {
            this.postMessage({ type: 'set-loading', value: false });
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

        const gitService = new GitService(repoPath);
        const remoteUrl = await gitService.getRemote();
        const { owner, repo } = this.parseGitHubUrl(remoteUrl);
        const token = await this.context.secrets.get("gitwise.githubPat");

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
            const repoPath = await this.gitOperations.getRepoSelection();
            if (!repoPath) {
                return;
            }

            const path = require('path');
            const fullPath = path.join(repoPath, filePath);
            const uri = vscode.Uri.file(fullPath);
            await vscode.window.showTextDocument(uri);
            Logger.info('Opened file from sidebar', { filePath });
        } catch (error: any) {
            Logger.error('Failed to open file', error, { filePath });
            vscode.window.showErrorMessage(`Failed to open file: ${error.message}`);
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
}
