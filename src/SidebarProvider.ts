import * as vscode from "vscode";
import * as path from 'path';
import * as fs from 'fs';
import { AuthService } from "./authService";
import { MessageHandler } from "./MessageHandler";
import { GitOperations } from "./GitOperations";
import { StatsRefresher } from "./StatsRefresher";
import { Logger } from "./logger";

export class SidebarProvider implements vscode.WebviewViewProvider {
    _view?: vscode.WebviewView;
    private authService: AuthService;
    private messageHandler: MessageHandler;
    private gitOperations: GitOperations;
    private statsRefresher: StatsRefresher;

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
    }

    private setupFileWatchers() {
        // Watch for any file changes in the workspace (real-time updates)
        const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*');
        
        const refreshHandler = () => this.statsRefresher.scheduleRefresh();
        
        // File created
        this._context.subscriptions.push(
            fileWatcher.onDidCreate(() => {
                Logger.debug('File created');
                this.statsRefresher.scheduleRefresh(true); // Immediate refresh
            })
        );
        
        // File changed/saved on disk
        this._context.subscriptions.push(
            fileWatcher.onDidChange(() => {
                Logger.debug('File changed on disk');
                this.statsRefresher.scheduleRefresh(true); // Immediate refresh
            })
        );
        
        // File deleted
        this._context.subscriptions.push(
            fileWatcher.onDidDelete(() => {
                Logger.debug('File deleted');
                this.statsRefresher.scheduleRefresh(true); // Immediate refresh
            })
        );
        
        // Text document saved (more reliable for text files)
        this._context.subscriptions.push(
            vscode.workspace.onDidSaveTextDocument((doc) => {
                Logger.debug('Document saved', { file: doc.fileName });
                // Force immediate refresh with cache bypass when saving
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
                        Logger.debug('Document content changed (typing)', { 
                            file: event.document.fileName,
                            changeCount: event.contentChanges.length 
                        });
                        this.statsRefresher.scheduleRefresh(); // Debounced for typing
                    }
                }
            })
        );
        
        // Document opened/closed
        this._context.subscriptions.push(
            vscode.workspace.onDidOpenTextDocument(() => {
                Logger.debug('Document opened');
                this.statsRefresher.scheduleRefresh();
            })
        );
        
        this._context.subscriptions.push(
            vscode.workspace.onDidCloseTextDocument(() => {
                Logger.debug('Document closed');
                this.statsRefresher.scheduleRefresh(true); // Immediate refresh
            })
        );
        
        // Active editor changed
        this._context.subscriptions.push(
            vscode.window.onDidChangeActiveTextEditor(refreshHandler)
        );
        
        // Workspace folders changed (multi-root support)
        this._context.subscriptions.push(
            vscode.workspace.onDidChangeWorkspaceFolders(() => {
                Logger.info('Workspace folders changed, refreshing all');
                this.statsRefresher.refresh(true);
            })
        );
        
        // Watch .git directory specifically for Git operations
        const gitWatcher = vscode.workspace.createFileSystemWatcher('**/.git/**');
        this._context.subscriptions.push(
            gitWatcher.onDidChange(() => {
                Logger.debug('Git directory changed');
                this.statsRefresher.scheduleRefresh(true); // Immediate refresh for Git ops
            })
        );
        
        this._context.subscriptions.push(fileWatcher, gitWatcher);
        
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
                this.statsRefresher.scheduleRefresh();
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
                    // Immediate refresh for new repo
                    this.statsRefresher.refresh(true);
                })
            );
            
            // Listen when repositories are closed
            this._context.subscriptions.push(
                git.onDidCloseRepository(() => {
                    Logger.info('Repository closed');
                    this.statsRefresher.refresh(true);
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

        webviewView.webview.onDidReceiveMessage(async (data) => {
            await this.messageHandler.handleMessage(data);
        });

        // Check auth status on load
        this.checkAuth();
    }

    private async checkAuth() {
        try {
            // Use comprehensive scopes for professional Git operations
            const scopes = [
                'repo', 'workflow', 'write:packages', 'delete:packages',
                'admin:org', 'admin:public_key', 'admin:repo_hook', 'admin:org_hook',
                'gist', 'user', 'read:org'
            ];
            const session = await vscode.authentication.getSession(
                'github',
                scopes,
                { createIfNone: false }
            );

            if (session) {
                await this._context.secrets.store("gitwise.githubPat", session.accessToken);
                Logger.info('Auth check: OAuth session found, showing dashboard', { user: session.account.label });
                this.postMessageSafe({ type: 'show-dashboard' });
                await this.statsRefresher.refresh();
            } else {
                // No active session - show setup to initiate OAuth
                Logger.info('Auth check: No OAuth session, showing setup');
                this.postMessageSafe({ type: 'show-setup' });
            }
        } catch (error) {
            Logger.error('Auth check failed', error);
            this.postMessageSafe({ type: 'show-setup' });
        }
    }

    public revive(panel: vscode.WebviewView) {
        this._view = panel;
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const styleResetUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "media", "reset.css"));
        const styleMainUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "media", "vscode.css"));
        const nonce = getNonce();

        const htmlPath = path.join(this._context.extensionPath, 'media', 'sidebar.html');
        let htmlContent = fs.readFileSync(htmlPath, 'utf8');

        htmlContent = htmlContent
            .replace('{{styleResetUri}}', styleResetUri.toString())
            .replace('{{styleMainUri}}', styleMainUri.toString())
            .replace(/{{nonce}}/g, nonce)
            .replace(/{{cspSource}}/g, webview.cspSource);

        return htmlContent;
    }
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
