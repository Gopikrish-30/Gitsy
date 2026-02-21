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
exports.Logger = void 0;
const vscode = __importStar(require("vscode"));
class Logger {
    static outputChannel;
    static initialize() {
        if (!this.outputChannel) {
            this.outputChannel = vscode.window.createOutputChannel('Gitsy');
        }
    }
    static info(message, context) {
        this.log('INFO', message, context);
    }
    static warn(message, context) {
        this.log('WARN', message, context);
    }
    static error(message, error, context) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : undefined;
        this.log('ERROR', message, { ...context, error: errorMessage, stack });
    }
    static debug(message, context) {
        this.log('DEBUG', message, context);
    }
    static log(level, message, context) {
        const timestamp = new Date().toISOString();
        const contextStr = context ? ` | ${JSON.stringify(context)}` : '';
        const logMessage = `[${timestamp}] [${level}] ${message}${contextStr}`;
        if (this.outputChannel) {
            this.outputChannel.appendLine(logMessage);
        }
        // Also log to console for debugging in extension host
        if (level === 'ERROR') {
            console.error(logMessage);
        }
        else if (level === 'WARN') {
            console.warn(logMessage);
        }
        else {
            console.log(logMessage);
        }
    }
    static show() {
        if (this.outputChannel) {
            this.outputChannel.show();
        }
    }
}
exports.Logger = Logger;
//# sourceMappingURL=logger.js.map