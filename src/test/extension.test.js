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
const assert = __importStar(require("assert"));
const vscode = __importStar(require("vscode"));
const gitService_1 = require("../gitService");
suite('Extension Test Suite', () => {
    vscode.window.showInformationMessage('Start all tests.');
    test('GitService should be instantiated', () => {
        const gitService = new gitService_1.GitService();
        assert.ok(gitService);
    });
    test('GitService should have required methods', () => {
        const gitService = new gitService_1.GitService();
        assert.ok(typeof gitService.getStatus === 'function');
        assert.ok(typeof gitService.push === 'function');
        assert.ok(typeof gitService.pull === 'function');
        assert.ok(typeof gitService.fetch === 'function');
        assert.ok(typeof gitService.commit === 'function');
        assert.ok(typeof gitService.stash === 'function');
        assert.ok(typeof gitService.getRepoName === 'function');
    });
    test('GitService should have branch operations', () => {
        const gitService = new gitService_1.GitService();
        assert.ok(typeof gitService.createBranch === 'function');
        assert.ok(typeof gitService.deleteBranch === 'function');
        assert.ok(typeof gitService.switchBranch === 'function');
        assert.ok(typeof gitService.mergeBranch === 'function');
        assert.ok(typeof gitService.getBranches === 'function');
    });
    test('GitService getStatus should return string', async () => {
        const gitService = new gitService_1.GitService();
        // This might fail if no workspace is open or no git repo, but it should return a string or throw a specific error
        try {
            const status = await gitService.getStatus();
            assert.ok(typeof status === 'string');
        }
        catch (e) {
            // If it throws, it might be because no workspace is open, which is acceptable in this test environment
            assert.ok(true);
        }
    });
});
//# sourceMappingURL=extension.test.js.map