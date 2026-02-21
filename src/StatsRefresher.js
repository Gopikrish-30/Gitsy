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
exports.StatsRefresher = void 0;
const vscode = __importStar(require("vscode"));
const gitService_1 = require("./gitService");
const logger_1 = require("./logger");
const cache_1 = require("./cache");
const utils_1 = require("./utils");
class StatsRefresher {
    context;
    authService;
    postMessage;
    refreshTimeout;
    statsCache = new cache_1.Cache(30); // 30 sec cache
    userCache = new cache_1.Cache(600); // 10 min cache for user profiles
    isRefreshing = false; // Prevents concurrent refresh calls
    pendingRefresh = false; // Queues one refresh if busy
    lastRefreshTime = 0; // Timestamp of last completed refresh
    static MIN_REFRESH_INTERVAL = 1000; // Min 1s between refreshes
    constructor(context, authService, postMessage) {
        this.context = context;
        this.authService = authService;
        this.postMessage = postMessage;
    }
    scheduleRefresh(immediate = false) {
        if (this.refreshTimeout) {
            clearTimeout(this.refreshTimeout);
        }
        if (immediate) {
            // "Immediate" still goes through debounce to coalesce bursts
            // (e.g. git operations that touch many .git files at once)
            this.refreshTimeout = setTimeout(() => {
                this.statsCache.clear();
                this.throttledRefresh(true);
            }, 300); // 300ms debounce for "immediate" events
        }
        else {
            // Debounced refresh for frequent file changes (typing)
            this.refreshTimeout = setTimeout(() => {
                this.throttledRefresh(false);
            }, 800); // 800ms debounce for typing
        }
    }
    /**
     * Ensures only one refresh runs at a time and enforces a minimum interval.
     */
    throttledRefresh(forceRefresh) {
        if (this.isRefreshing) {
            // Already refreshing — queue at most one pending refresh
            this.pendingRefresh = true;
            return;
        }
        const elapsed = Date.now() - this.lastRefreshTime;
        if (elapsed < StatsRefresher.MIN_REFRESH_INTERVAL) {
            // Too soon — schedule for later
            if (this.refreshTimeout) {
                clearTimeout(this.refreshTimeout);
            }
            this.refreshTimeout = setTimeout(() => {
                this.throttledRefresh(forceRefresh);
            }, StatsRefresher.MIN_REFRESH_INTERVAL - elapsed);
            return;
        }
        this.isRefreshing = true;
        this.refresh(forceRefresh)
            .catch(error => logger_1.Logger.error('Stats refresh failed', error))
            .finally(() => {
            this.isRefreshing = false;
            this.lastRefreshTime = Date.now();
            if (this.pendingRefresh) {
                this.pendingRefresh = false;
                // Process queued refresh after a short delay
                setTimeout(() => this.throttledRefresh(true), 300);
            }
        });
    }
    async refresh(forceRefresh = false) {
        logger_1.Logger.debug('refreshStats called', { forceRefresh });
        const pat = await this.context.secrets.get("gitsy.githubPat");
        if (!pat) {
            logger_1.Logger.debug('No GitHub PAT found, showing setup');
            this.postMessage({ type: 'show-setup' });
            return;
        }
        // === PHASE 0: Send cached profile immediately (0ms) ===
        let userProfile = this.userCache.get('user-profile') || null;
        if (userProfile) {
            this.postMessage({ type: 'update-user-quick', value: userProfile });
        }
        // === PHASE 1: Resolve repo path (fast) ===
        const repoPath = await this.resolveRepoPath();
        if (!repoPath) {
            logger_1.Logger.warn('No repository path found');
            this.postMessage({
                type: "update-stats",
                value: {
                    branch: 'No Repo', remote: 'No Repo', status: 'No Repo',
                    repoName: 'No Workspace', repoPath: 'Open a folder to get started',
                    lastCommit: 'N/A', user: userProfile, rebaseStatus: null,
                    mergeStatus: null, stashList: [], conflicts: [], pullRequests: [], commitStatus: null
                }
            });
            this.postMessage({ type: 'update-repo-status-list', value: [] });
            return;
        }
        // Check stats cache
        const cacheKey = `stats:${repoPath}`;
        if (!forceRefresh) {
            const cached = this.statsCache.get(cacheKey);
            if (cached) {
                cached.user = userProfile;
                this.postMessage({ type: "update-stats", value: cached });
                this.sendFileStatusList(cached.status);
                return;
            }
        }
        const gitService = new gitService_1.GitService(repoPath);
        try {
            // === PHASE 2: Run LOCAL git commands (~200-500ms) ===
            // These are all local disk operations — very fast
            const [branch, remote, status, repoName, lastCommit, rebaseStatus, mergeStatus, stashList, conflicts] = await Promise.all([
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
            // SEND GIT DATA TO WEBVIEW IMMEDIATELY — don't wait for network
            const stats = {
                branch, remote, status, repoName,
                repoPath: remote, lastCommit, user: userProfile,
                rebaseStatus, mergeStatus, stashList, conflicts,
                pullRequests: [], commitStatus: null
            };
            this.postMessage({ type: "update-stats", value: stats });
            this.sendFileStatusList(status);
            // === PHASE 3: Network calls in background (non-blocking) ===
            // Profile + PRs + CI status — update webview when each arrives
            this.fetchNetworkDataInBackground(pat, remote, branch, stats, cacheKey, userProfile);
        }
        catch (error) {
            logger_1.Logger.error('Failed to refresh stats', error, { repoPath });
            vscode.window.showErrorMessage(`Failed to refresh Git stats: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    /**
     * Fetches profile, PRs, and CI status in background without blocking the UI.
     * Updates the webview incrementally as each piece of data arrives.
     */
    fetchNetworkDataInBackground(pat, remote, branch, stats, cacheKey, currentProfile) {
        // Profile fetch (if not cached)
        if (!currentProfile) {
            this.authService.getUserProfile(pat)
                .then(viewer => {
                const profile = {
                    login: viewer.login,
                    name: viewer.name || viewer.login,
                    email: viewer.email || 'No email',
                    avatar: viewer.avatarUrl || '',
                    repos: viewer.repositories?.totalCount || 0,
                    contributions: viewer.contributionsCollection?.contributionCalendar?.totalContributions || 0
                };
                this.userCache.set('user-profile', profile, 600);
                this.postMessage({ type: 'update-user-quick', value: profile });
                // Update cached stats with profile
                stats.user = profile;
                this.statsCache.set(cacheKey, stats);
            })
                .catch(e => logger_1.Logger.error('Background profile fetch failed', e));
        }
        // PRs + CI status fetch (sequential to avoid flooding)
        if (remote && remote !== 'No origin' && remote !== 'Unknown') {
            try {
                const { owner, repo } = (0, utils_1.parseGitHubUrl)(remote);
                if (owner && repo) {
                    // Sequential: PRs first, then CI status
                    this.authService.getPullRequests(pat, owner, repo)
                        .then(async (prs) => {
                        stats.pullRequests = prs;
                        this.postMessage({ type: "update-stats", value: stats });
                        if (branch && branch !== 'Unknown') {
                            try {
                                const ciStatus = await this.authService.getCommitStatus(pat, owner, repo, branch);
                                stats.commitStatus = ciStatus;
                            }
                            catch (e) {
                                logger_1.Logger.debug('CI status fetch failed (non-critical)', { error: e });
                            }
                        }
                        this.statsCache.set(cacheKey, stats);
                        this.postMessage({ type: "update-stats", value: stats });
                    })
                        .catch(e => logger_1.Logger.error('Background GitHub API fetch failed', e));
                }
            }
            catch (e) {
                logger_1.Logger.error('Failed to parse remote URL for API calls', e);
            }
        }
        else {
            // No remote — just cache what we have
            this.statsCache.set(cacheKey, stats);
        }
    }
    async resolveRepoPath() {
        // 1. Try active editor's workspace folder
        if (vscode.window.activeTextEditor) {
            const docUri = vscode.window.activeTextEditor.document.uri;
            if (docUri.scheme === 'file') {
                const folder = vscode.workspace.getWorkspaceFolder(docUri);
                if (folder) {
                    logger_1.Logger.debug('Resolved repo from active editor', { path: folder.uri.fsPath });
                    return folder.uri.fsPath;
                }
            }
        }
        // 2. Check all workspace folders and find first Git repository
        if (vscode.workspace.workspaceFolders) {
            for (const folder of vscode.workspace.workspaceFolders) {
                const gitService = new gitService_1.GitService(folder.uri.fsPath);
                try {
                    if (await gitService.isRepo()) {
                        logger_1.Logger.debug('Found Git repository in workspace', { path: folder.uri.fsPath });
                        return folder.uri.fsPath;
                    }
                }
                catch (e) {
                    logger_1.Logger.debug('Not a git repo', { path: folder.uri.fsPath });
                }
            }
            // 3. Fallback to first folder even if not a Git repo
            logger_1.Logger.debug('Using first workspace folder', { path: vscode.workspace.workspaceFolders[0].uri.fsPath });
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
    sendFileStatusList(status) {
        let statusList = [];
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
                    logger_1.Logger.debug('Added unsaved indicator to existing status', {
                        file: dirtyFile,
                        status: statusList[existingIndex].status
                    });
                }
            }
            else {
                // File not in Git status yet - could be:
                // 1. New file not yet tracked (will show as M* until saved, then ??)
                // 2. File in a subdirectory with different path format
                // Add it as M* (modified but not in Git yet)
                statusList.push({
                    status: 'M*',
                    path: dirtyFile
                });
                logger_1.Logger.debug('Added new unsaved file', { file: dirtyFile });
            }
        }
        logger_1.Logger.debug('Parsed file status (including unsaved)', {
            count: statusList.length,
            dirtyCount: dirtyFiles.length,
            statuses: statusList.map(s => `${s.status}: ${s.path}`)
        });
        this.postMessage({ type: 'update-repo-status-list', value: statusList });
    }
    /**
     * Get all files with unsaved changes in the editor
     */
    getDirtyFiles() {
        const dirtyFiles = [];
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
    clearCache() {
        this.statsCache.clear();
    }
}
exports.StatsRefresher = StatsRefresher;
//# sourceMappingURL=StatsRefresher.js.map