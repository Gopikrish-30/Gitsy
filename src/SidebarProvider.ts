import * as vscode from "vscode";
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { AuthService } from "./authService";
import { MessageHandler } from "./MessageHandler";
import { GitOperations } from "./GitOperations";
import { StatsRefresher } from "./StatsRefresher";
import { Logger } from "./logger";

export class SidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    _view?: vscode.WebviewView;
    private authService: AuthService;
    private messageHandler: MessageHandler;
    private gitOperations: GitOperations;
    private statsRefresher: StatsRefresher;
    private disposables: vscode.Disposable[] = [];

    constructor(private readonly _extensionUri: vscode.Uri, private readonly _context: vscode.ExtensionContext) {
        this.authService = new AuthService(_context);
        this.gitOperations = new GitOperations(_context, this.authService);
        this.statsRefresher = new StatsRefresher(
            _context,
            this.authService,
            (message) => this.postMessageSafe(message)
        );
        this.messageHandler = new MessageHandler(
            _context,
            this.authService,
            this.gitOperations,
            (message) => this.postMessageSafe(message),
            () => this.statsRefresher.refresh(true),
            () => this.checkAuth()
        );

        // Real-time file monitoring for user's workspace
        this.setupFileWatchers();
        
        // Initialize git listener asynchronously to avoid blocking activation
        this.initGitListener();

        // Listen for authentication session changes (e.g., user authorizes in browser)
        this._context.subscriptions.push(
            vscode.authentication.onDidChangeSessions(e => {
                if (e.provider.id === 'github') {
                    Logger.info('GitHub authentication session changed, re-checking auth');
                    this.checkAuth();
                }
            })
        );
    }

    private setupFileWatchers() {
        // Watch for file changes in the workspace, EXCLUDING .git internals
        // (.git changes are handled by the Git extension listener instead)
        const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*', false, false, false);
        
        // All file system events use debounced scheduling (never bypass debounce)
        this._context.subscriptions.push(
            fileWatcher.onDidCreate((uri) => {
                // Ignore .git internal files — these are handled by Git extension
                if (uri.fsPath.includes('.git')) { return; }
                Logger.debug('File created');
                this.statsRefresher.scheduleRefresh(true);
            })
        );
        
        this._context.subscriptions.push(
            fileWatcher.onDidChange((uri) => {
                if (uri.fsPath.includes('.git')) { return; }
                Logger.debug('File changed on disk');
                this.statsRefresher.scheduleRefresh(true);
            })
        );
        
        this._context.subscriptions.push(
            fileWatcher.onDidDelete((uri) => {
                if (uri.fsPath.includes('.git')) { return; }
                Logger.debug('File deleted');
                this.statsRefresher.scheduleRefresh(true);
            })
        );
        
        // Text document saved (more reliable for text files)
        this._context.subscriptions.push(
            vscode.workspace.onDidSaveTextDocument((doc) => {
                Logger.debug('Document saved', { file: doc.fileName });
                this.statsRefresher.scheduleRefresh(true);
            })
        );
        
        // *** REAL-TIME TYPING DETECTION ***
        // Text document changed (AS YOU TYPE - before saving)
        this._context.subscriptions.push(
            vscode.workspace.onDidChangeTextDocument((event) => {
                // Only refresh if the document is part of a workspace folder
                if (event.document.uri.scheme === 'file') {
                    const folder = vscode.workspace.getWorkspaceFolder(event.document.uri);
                    if (folder) {
                        // Use non-immediate (longer debounce) for typing
                        this.statsRefresher.scheduleRefresh();
                    }
                }
            })
        );
        
        // Document opened — non-immediate debounce
        this._context.subscriptions.push(
            vscode.workspace.onDidOpenTextDocument(() => {
                this.statsRefresher.scheduleRefresh();
            })
        );
        
        // Active editor changed — non-immediate debounce
        this._context.subscriptions.push(
            vscode.window.onDidChangeActiveTextEditor(() => {
                this.statsRefresher.scheduleRefresh();
            })
        );
        
        // Workspace folders changed (multi-root support)
        this._context.subscriptions.push(
            vscode.workspace.onDidChangeWorkspaceFolders(() => {
                Logger.info('Workspace folders changed, refreshing all');
                this.statsRefresher.scheduleRefresh(true);
            })
        );
        
        this._context.subscriptions.push(fileWatcher);
        
        Logger.info('File watchers initialized for real-time monitoring (including unsaved changes)');
    }

    private async initGitListener() {
        try {
            const gitExtension = vscode.extensions.getExtension('vscode.git');
            if (!gitExtension) {
                Logger.warn('Git extension not found');
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
                Logger.debug('Git state changed');
                this.statsRefresher.scheduleRefresh(true); // Debounced immediate
            };

            // Listen to all existing repositories
            if (git.repositories) {
                git.repositories.forEach((repo: any) => {
                    Logger.info('Monitoring Git repository', { path: repo.rootUri.fsPath });
                    this._context.subscriptions.push(
                        repo.state.onDidChange(updateHandler)
                    );
                });
            }

            // Listen when new repositories are opened
            this._context.subscriptions.push(
                git.onDidOpenRepository((repo: any) => {
                    Logger.info('New repository opened', { path: repo.rootUri.fsPath });
                    this._context.subscriptions.push(
                        repo.state.onDidChange(updateHandler)
                    );
                    this.statsRefresher.scheduleRefresh(true);
                })
            );
            
            // Listen when repositories are closed
            this._context.subscriptions.push(
                git.onDidCloseRepository(() => {
                    Logger.info('Repository closed');
                    this.statsRefresher.scheduleRefresh(true);
                })
            );
            
            Logger.info('Git extension listeners initialized');
        } catch (e) {
            Logger.error('Failed to initialize Git listener', e);
        }
    }

    private postMessageSafe(message: any): void {
        if (this._view) {
            this._view.webview.postMessage(message).then(
                () => Logger.debug('Message sent to webview', { type: message.type }),
                (error) => Logger.error('Failed to send message to webview', error, { type: message.type })
            );
        }
    }

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        Logger.info('Resolving webview view');
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage((data) => {
            this.messageHandler.handleMessage(data).catch(error => {
                Logger.error('Unhandled error in message handler', error);
                vscode.window.showErrorMessage(`Gitsy error: ${error instanceof Error ? error.message : String(error)}`);
            });
        });

        // Check auth status on load
        this.checkAuth();
    }

    private async checkAuth() {
        // Use cached auth state to show the correct view INSTANTLY (no network wait)
        const wasAuthenticated = this._context.globalState.get<boolean>('gitsy.wasAuthenticated', false);
        const cachedUser = this._context.globalState.get<string>('gitsy.cachedUser', '');

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
            const session = await vscode.authentication.getSession(
                'github',
                scopes,
                { createIfNone: false }
            );

            if (session) {
                // Store token + cache auth state for instant next load
                await Promise.all([
                    this._context.secrets.store("gitsy.githubPat", session.accessToken),
                    this._context.globalState.update('gitsy.wasAuthenticated', true),
                    this._context.globalState.update('gitsy.cachedUser', session.account.label)
                ]);

                Logger.info('Auth check: session found', { user: session.account.label });

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
                this.statsRefresher.refresh(true).catch(e =>
                    Logger.error('Background stats refresh failed', e)
                );
            } else {
                // Clear cached auth state
                await Promise.all([
                    this._context.globalState.update('gitsy.wasAuthenticated', false),
                    this._context.globalState.update('gitsy.cachedUser', '')
                ]);
                Logger.info('Auth check: No OAuth session, showing setup');
                this.postMessageSafe({ type: 'show-setup' });
            }
        } catch (error) {
            Logger.error('Auth check failed', error);
            if (!wasAuthenticated) {
                this.postMessageSafe({ type: 'show-setup' });
            }
        }
    }

    public dispose(): void {
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
    }

    public revive(panel: vscode.WebviewView) {
        this._view = panel;
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
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

function getNonce(): string {
    return crypto.randomBytes(16).toString('hex');
}
