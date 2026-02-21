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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const SidebarProvider_1 = require("./SidebarProvider");
const logger_1 = require("./logger");
const AIPreflightService_1 = require("./AIPreflightService");
function activate(context) {
    logger_1.Logger.initialize();
    logger_1.Logger.info('Gitsy extension activating...');
    console.log('Gitsy extension activated');
    // Register Sidebar Provider
    const sidebarProvider = new SidebarProvider_1.SidebarProvider(context.extensionUri, context);
    context.subscriptions.push(sidebarProvider, vscode.window.registerWebviewViewProvider("gitsySidebar", sidebarProvider));
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
    const aiPreflightService = new AIPreflightService_1.AIPreflightService(context);
    const configureAI = vscode.commands.registerCommand('gitsy.configureAI', async () => {
        await aiPreflightService.configureApiKey();
    });
    context.subscriptions.push(setPat, configureAI);
}
function deactivate() { }
//# sourceMappingURL=extension.js.map