import * as vscode from 'vscode';

export class Logger {
    private static outputChannel: vscode.OutputChannel;

    public static initialize() {
        if (!this.outputChannel) {
            this.outputChannel = vscode.window.createOutputChannel('GitWise');
        }
    }

    public static info(message: string, context?: any) {
        this.log('INFO', message, context);
    }

    public static warn(message: string, context?: any) {
        this.log('WARN', message, context);
    }

    public static error(message: string, error?: any, context?: any) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : undefined;
        this.log('ERROR', message, { ...context, error: errorMessage, stack });
    }

    public static debug(message: string, context?: any) {
        this.log('DEBUG', message, context);
    }

    private static log(level: string, message: string, context?: any) {
        const timestamp = new Date().toISOString();
        const contextStr = context ? ` | ${JSON.stringify(context)}` : '';
        const logMessage = `[${timestamp}] [${level}] ${message}${contextStr}`;
        
        if (this.outputChannel) {
            this.outputChannel.appendLine(logMessage);
        }

        // Also log to console for debugging in extension host
        if (level === 'ERROR') {
            console.error(logMessage);
        } else if (level === 'WARN') {
            console.warn(logMessage);
        } else {
            console.log(logMessage);
        }
    }

    public static show() {
        if (this.outputChannel) {
            this.outputChannel.show();
        }
    }
}
