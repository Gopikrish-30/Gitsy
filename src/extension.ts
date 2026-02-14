import * as vscode from 'vscode';
import { SidebarProvider } from './SidebarProvider';
import { Logger } from './logger';

export function activate(context: vscode.ExtensionContext) {
	Logger.initialize();
	Logger.info('Gitsy extension activating...');
	console.log('Gitsy extension activated');

    // Register Sidebar Provider
    const sidebarProvider = new SidebarProvider(context.extensionUri, context);
    context.subscriptions.push(
        sidebarProvider,
        vscode.window.registerWebviewViewProvider(
            "gitsySidebar",
            sidebarProvider
        )
    );

    const setPat = vscode.commands.registerCommand('gitsy.setPat', async () => {
        const pat = await vscode.window.showInputBox({
            placeHolder: "Enter your GitHub Personal Access Token",
            password: true,
            ignoreFocusOut: true,
            prompt: "This will be stored securely in VS Code's secret storage."
        });
        if (pat) {
            await context.secrets.store("gitsy.githubPat", pat);
            vscode.window.showInformationMessage("GitHub PAT stored securely.");
        }
    });

	context.subscriptions.push(setPat);
}

export function deactivate() {}
