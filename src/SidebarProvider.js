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
exports.SidebarProvider = void 0;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const crypto = __importStar(require("crypto"));
const authService_1 = require("./authService");
const MessageHandler_1 = require("./MessageHandler");
const GitOperations_1 = require("./GitOperations");
const StatsRefresher_1 = require("./StatsRefresher");
const logger_1 = require("./logger");
const AIPreflightService_1 = require("./AIPreflightService");
const FlowLogger_1 = require("./FlowLogger");
class SidebarProvider {
    _extensionUri;
    _context;
    _view;
    authService;
    messageHandler;
    gitOperations;
    statsRefresher;
    aiPreflightService;
    flowLogger;
    disposables = [];
    constructor(_extensionUri, _context) {
        this._extensionUri = _extensionUri;
        this._context = _context;
        this.authService = new authService_1.AuthService(_context);
        this.gitOperations = new GitOperations_1.GitOperations(_context, this.authService);
        this.aiPreflightService = new AIPreflightService_1.AIPreflightService(_context);
        this.flowLogger = new FlowLogger_1.FlowLogger(_context);
        this.statsRefresher = new StatsRefresher_1.StatsRefresher(_context, this.authService, (message) => this.postMessageSafe(message));
        this.messageHandler = new MessageHandler_1.MessageHandler(_context, this.authService, this.gitOperations, this.aiPreflightService, this.flowLogger, (message) => this.postMessageSafe(message), () => this.statsRefresher.refresh(true), () => this.checkAuth());
        // Real-time file monitoring for user's workspace
        this.setupFileWatchers();
        // Initialize git listener asynchronously to avoid blocking activation
        this.initGitListener();
        // Listen for authentication session changes (e.g., user authorizes in browser)
        this._context.subscriptions.push(vscode.authentication.onDidChangeSessions(e => {
            if (e.provider.id === 'github') {
                logger_1.Logger.info('GitHub authentication session changed, re-checking auth');
                this.checkAuth();
            }
        }));
    }
    setupFileWatchers() {
        // Watch for file changes in the workspace, EXCLUDING .git internals
        // (.git changes are handled by the Git extension listener instead)
        const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*', false, false, false);
        // All file system events use debounced scheduling (never bypass debounce)
        this._context.subscriptions.push(fileWatcher.onDidCreate((uri) => {
            // Ignore .git internal files — these are handled by Git extension
            if (uri.fsPath.includes('.git')) {
                return;
            }
            logger_1.Logger.debug('File created');
            this.statsRefresher.scheduleRefresh(true);
        }));
        this._context.subscriptions.push(fileWatcher.onDidChange((uri) => {
            if (uri.fsPath.includes('.git')) {
                return;
            }
            logger_1.Logger.debug('File changed on disk');
            this.statsRefresher.scheduleRefresh(true);
        }));
        this._context.subscriptions.push(fileWatcher.onDidDelete((uri) => {
            if (uri.fsPath.includes('.git')) {
                return;
            }
            logger_1.Logger.debug('File deleted');
            this.statsRefresher.scheduleRefresh(true);
        }));
        // Text document saved (more reliable for text files)
        this._context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((doc) => {
            logger_1.Logger.debug('Document saved', { file: doc.fileName });
            this.statsRefresher.scheduleRefresh(true);
        }));
        // *** REAL-TIME TYPING DETECTION ***
        // Text document changed (AS YOU TYPE - before saving)
        this._context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
            // Only refresh if the document is part of a workspace folder
            if (event.document.uri.scheme === 'file') {
                const folder = vscode.workspace.getWorkspaceFolder(event.document.uri);
                if (folder) {
                    // Use non-immediate (longer debounce) for typing
                    this.statsRefresher.scheduleRefresh();
                }
            }
        }));
        // Document opened — non-immediate debounce
        this._context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(() => {
            this.statsRefresher.scheduleRefresh();
        }));
        // Active editor changed — non-immediate debounce
        this._context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => {
            this.statsRefresher.scheduleRefresh();
        }));
        // Workspace folders changed (multi-root support)
        this._context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
            logger_1.Logger.info('Workspace folders changed, refreshing all');
            this.statsRefresher.scheduleRefresh(true);
        }));
        this._context.subscriptions.push(fileWatcher);
        logger_1.Logger.info('File watchers initialized for real-time monitoring (including unsaved changes)');
    }
    async initGitListener() {
        try {
            const gitExtension = vscode.extensions.getExtension('vscode.git');
            if (!gitExtension) {
                logger_1.Logger.warn('Git extension not found');
                return;
            }
            if (!gitExtension.isActive) {
                await gitExtension.activate();
            }
            const git = gitExtension.exports.getAPI(1);
            if (!git) {
                return;
            }
            const updateHandler = () => {
                logger_1.Logger.debug('Git state changed');
                this.statsRefresher.scheduleRefresh(true); // Debounced immediate
            };
            // Listen to all existing repositories
            if (git.repositories) {
                git.repositories.forEach((repo) => {
                    logger_1.Logger.info('Monitoring Git repository', { path: repo.rootUri.fsPath });
                    this._context.subscriptions.push(repo.state.onDidChange(updateHandler));
                });
            }
            // Listen when new repositories are opened
            this._context.subscriptions.push(git.onDidOpenRepository((repo) => {
                logger_1.Logger.info('New repository opened', { path: repo.rootUri.fsPath });
                this._context.subscriptions.push(repo.state.onDidChange(updateHandler));
                this.statsRefresher.scheduleRefresh(true);
            }));
            // Listen when repositories are closed
            this._context.subscriptions.push(git.onDidCloseRepository(() => {
                logger_1.Logger.info('Repository closed');
                this.statsRefresher.scheduleRefresh(true);
            }));
            logger_1.Logger.info('Git extension listeners initialized');
        }
        catch (e) {
            logger_1.Logger.error('Failed to initialize Git listener', e);
        }
    }
    postMessageSafe(message) {
        if (this._view) {
            this._view.webview.postMessage(message).then(() => logger_1.Logger.debug('Message sent to webview', { type: message.type }), (error) => logger_1.Logger.error('Failed to send message to webview', error, { type: message.type }));
        }
    }
    resolveWebviewView(webviewView) {
        logger_1.Logger.info('Resolving webview view');
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
        webviewView.webview.onDidReceiveMessage((data) => {
            this.messageHandler.handleMessage(data).catch(error => {
                logger_1.Logger.error('Unhandled error in message handler', error);
                vscode.window.showErrorMessage(`Gitsy error: ${error instanceof Error ? error.message : String(error)}`);
            });
        });
        // Check auth status on load
        this.checkAuth();
    }
    async checkAuth() {
        // Use cached auth state to show the correct view INSTANTLY (no network wait)
        const wasAuthenticated = this._context.globalState.get('gitsy.wasAuthenticated', false);
        const cachedUser = this._context.globalState.get('gitsy.cachedUser', '');
        if (wasAuthenticated) {
            // Show dashboard immediately from cache - no flicker
            this.postMessageSafe({ type: 'show-dashboard' });
            if (cachedUser) {
                this.postMessageSafe({
                    type: 'update-user-quick',
                    value: {
                        name: cachedUser,
                        login: cachedUser,
                        email: 'Loading...'
                    }
                });
            }
        }
        try {
            // Minimal scopes for Git operations
            const scopes = ['repo', 'read:user', 'user:email'];
            const session = await vscode.authentication.getSession('github', scopes, { createIfNone: false });
            if (session) {
                // Store token + cache auth state for instant next load
                await Promise.all([
                    this._context.secrets.store("gitsy.githubPat", session.accessToken),
                    this._context.globalState.update('gitsy.wasAuthenticated', true),
                    this._context.globalState.update('gitsy.cachedUser', session.account.label)
                ]);
                logger_1.Logger.info('Auth check: session found', { user: session.account.label });
                // If we didn't show dashboard from cache, show now
                if (!wasAuthenticated) {
                    this.postMessageSafe({ type: 'show-dashboard' });
                }
                this.postMessageSafe({
                    type: 'update-user-quick',
                    value: {
                        name: session.account.label,
                        login: session.account.label,
                        email: 'Loading...'
                    }
                });
                // Full stats refresh in background (non-blocking)
                this.statsRefresher.refresh(true).catch(e => logger_1.Logger.error('Background stats refresh failed', e));
            }
            else {
                // Clear cached auth state
                await Promise.all([
                    this._context.globalState.update('gitsy.wasAuthenticated', false),
                    this._context.globalState.update('gitsy.cachedUser', '')
                ]);
                logger_1.Logger.info('Auth check: No OAuth session, showing setup');
                this.postMessageSafe({ type: 'show-setup' });
            }
        }
        catch (error) {
            logger_1.Logger.error('Auth check failed', error);
            if (!wasAuthenticated) {
                this.postMessageSafe({ type: 'show-setup' });
            }
        }
    }
    dispose() {
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
    }
    revive(panel) {
        this._view = panel;
    }
    _getHtmlForWebview(webview) {
        const logoUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "media", "gitsy.svg"));
        const nonce = getNonce();
        const htmlPath = path.join(this._context.extensionPath, 'media', 'sidebar.html');
        let htmlContent = fs.readFileSync(htmlPath, 'utf8');
        htmlContent = htmlContent
            .replace(/{{logoUri}}/g, logoUri.toString())
            .replace(/{{nonce}}/g, nonce)
            .replace(/{{cspSource}}/g, webview.cspSource);
        return htmlContent;
    }
}
exports.SidebarProvider = SidebarProvider;
function getNonce() {
    return crypto.randomBytes(16).toString('hex');
}
//# sourceMappingURL=SidebarProvider.js.map