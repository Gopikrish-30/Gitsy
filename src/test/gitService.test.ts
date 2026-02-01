import * as assert from 'assert';
import * as vscode from 'vscode';
import { GitService } from '../gitService';

suite('GitService Test Suite', () => {
	vscode.window.showInformationMessage('Running GitService tests');

	test('GitService initializes with workspace', () => {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (workspaceFolders && workspaceFolders.length > 0) {
			const gitService = new GitService(workspaceFolders[0].uri.fsPath);
			assert.ok(gitService, 'GitService should be initialized');
		}
	});

	test('GitService detects repository', async () => {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (workspaceFolders && workspaceFolders.length > 0) {
			const gitService = new GitService(workspaceFolders[0].uri.fsPath);
			const isRepo = await gitService.isRepo();
			assert.ok(typeof isRepo === 'boolean', 'isRepo should return a boolean');
		}
	});

	test('Branch name escaping works correctly', () => {
		const gitService = new GitService('/tmp');
		// Access private method through any cast for testing
		const escapeBranchName = (gitService as any).escapeBranchName;
		
		assert.strictEqual(escapeBranchName('feature/test'), 'feature/test');
		assert.strictEqual(escapeBranchName('feature-test'), 'feature-test');
		assert.strictEqual(escapeBranchName('feature test'), 'feature_test');
		assert.strictEqual(escapeBranchName('feature;test'), 'feature_test');
		assert.strictEqual(escapeBranchName('feature$test'), 'feature_test');
	});
});
