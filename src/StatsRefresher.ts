import * as vscode from 'vscode';
import { GitService } from './gitService';
import { AuthService } from './authService';
import { Logger } from './logger';
import { Cache } from './cache';
import { RepoStats, UserProfile, FileStatus } from './types';

export class StatsRefresher {
    private refreshTimeout: NodeJS.Timeout | undefined;
    private statsCache = new Cache<RepoStats>(30); // 30 sec cache
    private userCache = new Cache<UserProfile>(600); // 10 min cache for user profiles

    constructor(
        private context: vscode.ExtensionContext,
        private authService: AuthService,
        private postMessage: (message: any) => void
    ) {}

    public scheduleRefresh(immediate = false): void {
        if (this.refreshTimeout) {
            clearTimeout(this.refreshTimeout);
        }
        
        if (immediate) {
            // Immediate refresh for critical events (save, delete, etc.)
            // Clear cache to force fresh Git status
            this.statsCache.clear();
            this.refresh(true).catch(error => {
                Logger.error('Immediate stats refresh failed', error);
            });
        } else {
            // Debounced refresh for frequent file changes (typing)
            this.refreshTimeout = setTimeout(() => {
                this.refresh().catch(error => {
                    Logger.error('Scheduled stats refresh failed', error);
                });
            }, 500); // 500ms debounce for real-time feel
        }
    }

    public async refresh(forceRefresh = false): Promise<void> {
        Logger.debug('refreshStats called', { forceRefresh });

        const pat = await this.context.secrets.get("gitwise.githubPat");
        if (!pat) {
            Logger.debug('No GitHub PAT found, showing setup');
            this.postMessage({ type: 'show-setup' });
            return;
        }

        const repoPath = await this.resolveRepoPath();
        if (!repoPath) {
            Logger.warn('No repository path found - user may not have a workspace open');
            // Show empty state in UI
            this.postMessage({ 
                type: "update-stats", 
                value: {
                    branch: 'No Repo',
                    remote: 'No Repo',
                    status: 'No Repo',
                    repoName: 'No Workspace',
                    repoPath: 'Open a folder to get started',
                    lastCommit: 'N/A',
                    user: null,
                    rebaseStatus: null,
                    mergeStatus: null,
                    stashList: [],
                    conflicts: [],
                    pullRequests: [],
                    commitStatus: null
                }
            });
            this.postMessage({ type: 'update-repo-status-list', value: [] });
            return;
        }

        const cacheKey = `stats:${repoPath}`;
        if (!forceRefresh) {
            const cached = this.statsCache.get(cacheKey);
            if (cached) {
                this.postMessage({ type: "update-stats", value: cached });
                this.sendFileStatusList(cached.status);
                return;
            }
        }

        const gitService = new GitService(repoPath);

        try {
            // Parallelize git operations for better performance
            const [
                branch,
                remote,
                status,
                repoName,
                lastCommit,
                rebaseStatus,
                mergeStatus,
                stashList,
                conflicts
            ] = await Promise.all([
                gitService.getCurrentBranch(),
                gitService.getRemote(),
                gitService.getStatus(),
                gitService.getRepoName(),
                gitService.getLastPushedCommit(),
                gitService.getRebaseStatus(),
                gitService.getMergeStatus(),
                gitService.getStashList(),
                gitService.getConflicts()
            ]);

            // Fetch user profile if not cached
            let userProfile: UserProfile | null = this.userCache.get('user-profile') || null;
            if (!userProfile) {
                try {
                    const viewer = await this.authService.getUserProfile(pat);
                    userProfile = {
                        login: viewer.login,
                        name: viewer.name || viewer.login,
                        email: viewer.email || 'No email',
                        avatar: viewer.avatarUrl || '',
                        repos: viewer.repositories?.totalCount || 0,
                        contributions: viewer.contributionsCollection?.contributionCalendar?.totalContributions || 0
                    };
                    this.userCache.set('user-profile', userProfile, 600); // 10 min
                } catch (e: any) {
                    Logger.error('Failed to fetch user profile', e);
                    userProfile = {
                        login: 'User',
                        name: 'GitHub User',
                        email: 'Profile Error',
                        avatar: '',
                        repos: 0,
                        contributions: 0
                    };
                }
            }

            let pullRequests: any[] = [];
            let commitStatus: string | null = null;

            if (pat && remote && remote !== 'No origin' && remote !== 'Unknown') {
                try {
                    const { owner, repo } = this.parseGitHubUrl(remote);

                    if (owner && repo) {
                        // Parallelize GitHub API calls
                        const [prs, status] = await Promise.all([
                            this.authService.getPullRequests(pat, owner, repo),
                            branch && branch !== 'Unknown' 
                                ? this.authService.getCommitStatus(pat, owner, repo, branch)
                                : Promise.resolve(null)
                        ]);
                        pullRequests = prs;
                        commitStatus = status;
                    }
                } catch (e) {
                    Logger.error('Failed to fetch remote stats from GitHub', e);
                }
            }

            const stats: RepoStats = {
                branch,
                remote,
                status,
                repoName,
                repoPath: remote,
                lastCommit,
                user: userProfile,
                rebaseStatus,
                mergeStatus,
                stashList,
                conflicts,
                pullRequests,
                commitStatus
            };

            // Cache the stats
            this.statsCache.set(cacheKey, stats);

            // Send to webview
            this.postMessage({ type: "update-stats", value: stats });
            this.sendFileStatusList(status);

        } catch (error) {
            Logger.error('Failed to refresh stats', error, { repoPath });
            vscode.window.showErrorMessage(`Failed to refresh Git stats: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async resolveRepoPath(): Promise<string | undefined> {
        // 1. Try active editor's workspace folder
        if (vscode.window.activeTextEditor) {
            const docUri = vscode.window.activeTextEditor.document.uri;
            if (docUri.scheme === 'file') {
                const folder = vscode.workspace.getWorkspaceFolder(docUri);
                if (folder) {
                    Logger.debug('Resolved repo from active editor', { path: folder.uri.fsPath });
                    return folder.uri.fsPath;
                }
            }
        }

        // 2. Check all workspace folders and find first Git repository
        if (vscode.workspace.workspaceFolders) {
            for (const folder of vscode.workspace.workspaceFolders) {
                const gitService = new GitService(folder.uri.fsPath);
                try {
                    if (await gitService.isRepo()) {
                        Logger.debug('Found Git repository in workspace', { path: folder.uri.fsPath });
                        return folder.uri.fsPath;
                    }
                } catch (e) {
                    Logger.debug('Not a git repo', { path: folder.uri.fsPath });
                }
            }
            
            // 3. Fallback to first folder even if not a Git repo
            Logger.debug('Using first workspace folder', { path: vscode.workspace.workspaceFolders[0].uri.fsPath });
            return vscode.workspace.workspaceFolders[0].uri.fsPath;
        }

        return undefined;
    }

    /**
     * Parse git status output and send detailed file status list
     * Handles all git status codes including:
     * - M: Modified, A: Added, D: Deleted, R: Renamed, C: Copied
     * - U: Unmerged (conflicts), ?: Untracked, !: Ignored
     * - Staged (first char) vs Unstaged (second char)
     * Also includes unsaved changes in editor
     */
    private sendFileStatusList(status: string): void {
        let statusList: FileStatus[] = [];
        
        if (status && status !== 'Clean' && status !== 'No Repo' && status !== 'Error getting status') {
            const lines = status.split('\n').filter(line => line.trim().length > 0);
            
            for (const line of lines) {
                // Skip branch information line
                if (line.startsWith('##')) {
                    continue;
                }
                
                // Git status format: XY filename
                // X = index status (staged), Y = working tree status (unstaged)
                // Special cases: Renamed (R), Copied (C), Untracked (?), Ignored (!)
                
                if (line.length < 3) {
                    continue;
                }
                
                const indexStatus = line[0]; // Staged changes
                const workTreeStatus = line[1]; // Unstaged changes
                const filePath = line.substring(3).trim();
                
                if (!filePath) {
                    continue;
                }
                
                // Determine human-readable status
                let displayStatus = '';
                
                // Handle conflicts (unmerged files)
                if (indexStatus === 'U' || workTreeStatus === 'U' ||
                    (indexStatus === 'A' && workTreeStatus === 'A') ||
                    (indexStatus === 'D' && workTreeStatus === 'D')) {
                    displayStatus = 'U';
                } 
                // Handle renamed files
                else if (indexStatus === 'R' || workTreeStatus === 'R') {
                    displayStatus = 'R';
                }
                // Handle copied files
                else if (indexStatus === 'C' || workTreeStatus === 'C') {
                    displayStatus = 'C';
                }
                // Handle deleted files
                else if (indexStatus === 'D' || workTreeStatus === 'D') {
                    displayStatus = indexStatus === 'D' ? 'D' : 'D ';
                }
                // Handle added files
                else if (indexStatus === 'A') {
                    displayStatus = 'A';
                }
                // Handle modified files
                else if (indexStatus === 'M' || workTreeStatus === 'M') {
                    // MM = modified in both index and working tree
                    // M  = modified and staged
                    //  M = modified but not staged
                    displayStatus = indexStatus + workTreeStatus;
                }
                // Handle untracked files
                else if (line.startsWith('??')) {
                    displayStatus = '??';
                }
                // Handle ignored files
                else if (line.startsWith('!!')) {
                    displayStatus = '!!';
                }
                // Handle other cases
                else {
                    displayStatus = indexStatus + workTreeStatus;
                }
                
                statusList.push({ 
                    status: displayStatus.trim(), 
                    path: filePath 
                });
            }
        }
        
        // Add unsaved changes (dirty files in editor that haven't been saved yet)
        const dirtyFiles = this.getDirtyFiles();
        for (const dirtyFile of dirtyFiles) {
            // Check if this file is already in the status list
            const existingIndex = statusList.findIndex(item => {
                // Normalize paths for comparison (handle both forward and back slashes)
                const normalizedDirty = dirtyFile.replace(/\\/g, '/').toLowerCase();
                const normalizedExisting = item.path.replace(/\\/g, '/').toLowerCase();
                
                // Check if paths match (either exact or one ends with the other)
                return normalizedDirty === normalizedExisting || 
                       normalizedDirty.endsWith(normalizedExisting) || 
                       normalizedExisting.endsWith(normalizedDirty);
            });
            
            if (existingIndex >= 0) {
                // File already in Git status - add * indicator for unsaved changes
                const current = statusList[existingIndex];
                if (!current.status.includes('*')) {
                    // Add * to show unsaved changes for ANY status (M, A, D, ??, U, R, C)
                    statusList[existingIndex].status = current.status + '*';
                    Logger.debug('Added unsaved indicator to existing status', { 
                        file: dirtyFile, 
                        status: statusList[existingIndex].status 
                    });
                }
            } else {
                // File not in Git status yet - could be:
                // 1. New file not yet tracked (will show as M* until saved, then ??)
                // 2. File in a subdirectory with different path format
                // Add it as M* (modified but not in Git yet)
                statusList.push({
                    status: 'M*',
                    path: dirtyFile
                });
                Logger.debug('Added new unsaved file', { file: dirtyFile });
            }
        }
        
        Logger.debug('Parsed file status (including unsaved)', { 
            count: statusList.length,
            dirtyCount: dirtyFiles.length,
            statuses: statusList.map(s => `${s.status}: ${s.path}`)
        });
        this.postMessage({ type: 'update-repo-status-list', value: statusList });
    }
    
    /**
     * Get all files with unsaved changes in the editor
     */
    private getDirtyFiles(): string[] {
        const dirtyFiles: string[] = [];
        
        // Get all open text documents
        for (const doc of vscode.workspace.textDocuments) {
            // Check if document is dirty (has unsaved changes)
            if (doc.isDirty && doc.uri.scheme === 'file') {
                // Get relative path from workspace
                const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
                if (folder) {
                    const relativePath = vscode.workspace.asRelativePath(doc.uri, false);
                    dirtyFiles.push(relativePath);
                }
            }
        }
        
        return dirtyFiles;
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
        this.statsCache.clear();
    }
}
