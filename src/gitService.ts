import * as vscode from "vscode";
import * as cp from "child_process";
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './logger';

export class GitService {
  private workspaceRoot: string | undefined;

  constructor(workspaceRoot?: string) {
    if (workspaceRoot) {
      this.workspaceRoot = workspaceRoot;
    } else if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
      this.workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    }
  }

  // ───────────────────────────── VS Code Git Extension API ─────────────────────────────

  /**
   * Get the VS Code Git Extension repository matching this workspace.
   * VS Code handles auth automatically through its credential manager (GIT_ASKPASS).
   */
  private getVSCodeRepo(): any | undefined {
    try {
      const gitExt = vscode.extensions.getExtension('vscode.git');
      if (!gitExt || !gitExt.isActive) {
        Logger.debug('VS Code Git extension not active');
        return undefined;
      }

      const api = gitExt.exports.getAPI(1);
      if (!api?.repositories?.length) {
        Logger.debug('No Git repositories detected by VS Code');
        return undefined;
      }

      if (this.workspaceRoot) {
        const normalized = this.workspaceRoot.replace(/\\/g, '/').toLowerCase();
        const matched = api.repositories.find((r: any) =>
          r.rootUri.fsPath.replace(/\\/g, '/').toLowerCase() === normalized
        );
        if (matched) { return matched; }
      }

      return api.repositories[0];
    } catch (e) {
      Logger.warn('Failed to get VS Code Git repository', { error: e });
      return undefined;
    }
  }

  // ───────────────────────────── Shell Execution (local ops) ─────────────────────────────

  public async runGitCommand(command: string): Promise<string> {
    const parts = command.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    const bin = parts[0] || 'git';
    const args = parts.slice(1).map(a => a.replace(/^"|"$/g, ''));
    if (bin === 'git') {
      return await this.execGit(args);
    }
    return await this.execShell(command);
  }

  /**
   * Execute a local git command via child_process.
   * Inherits VS Code's GIT_ASKPASS environment for auth when needed.
   */
  private async execGit(args: string[], retries = 0): Promise<string> {
    if (!this.workspaceRoot) {
      throw new Error("No workspace folder open");
    }

    return new Promise((resolve, reject) => {
      const options: cp.ExecFileOptions = {
        cwd: this.workspaceRoot,
        timeout: 60000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env } // Inherits GIT_ASKPASS, VSCODE_GIT_* etc.
      };

      cp.execFile('git', args, options, async (err, stdout, stderr) => {
        const out = (stdout || '').toString();
        const errOut = (stderr || '').toString();

        if (err) {
          Logger.debug('Git command failed', { args: args.join(' '), error: err.message, stderr: errOut });

          if (retries < 2 && (err.message.includes('timeout') || err.message.includes('Connection'))) {
            Logger.warn(`Retrying git command (attempt ${retries + 1})`, { args });
            try {
              const result = await this.execGit(args, retries + 1);
              resolve(result);
              return;
            } catch (retryErr) { /* fall through */ }
          }

          // Filter out warning lines from stderr to keep error messages concise.
          // Git warnings (LF/CRLF, etc.) inflate error output and confuse users.
          const filteredStderr = errOut
            .split('\n')
            .filter(line => !line.startsWith('warning:'))
            .join('\n')
            .trim();

          const parts: string[] = [];
          if (filteredStderr) { parts.push(filteredStderr); }
          else if (err.message) { parts.push(err.message); }
          if (out && !out.includes('fatal')) { parts.push(`Stdout: ${out.trim()}`); }

          reject(new Error(parts.join('\n')));
          return;
        }
        resolve(out.trim());
      });
    });
  }

  private async execShell(command: string, retries = 0): Promise<string> {
    if (!this.workspaceRoot) {
      throw new Error("No workspace folder open");
    }

    return new Promise((resolve, reject) => {
      const options = {
        cwd: this.workspaceRoot,
        timeout: 60000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env }
      };

      cp.exec(command, options, async (err, stdout, stderr) => {
        const out = (stdout || '').toString();
        const errOut = (stderr || '').toString();

        if (err) {
          if (retries < 2 && (err.message.includes('timeout') || err.message.includes('Connection'))) {
            try {
              const result = await this.execShell(command, retries + 1);
              resolve(result);
              return;
            } catch (retryErr) { /* fall through */ }
          }
          const parts: string[] = [];
          if (errOut) { parts.push(errOut.trim()); }
          else if (err.message) { parts.push(err.message); }
          reject(new Error(parts.join('\n')));
          return;
        }
        resolve(out.trim());
      });
    });
  }

  // ───────────────────────────── Network Operations (VS Code Git API) ─────────────────────────────

  public async push(): Promise<string> {
    const repo = this.getVSCodeRepo();
    if (repo) {
      try {
        Logger.info('Pushing via VS Code Git API');
        const head = repo.state?.HEAD;
        const branchName = head?.name;
        const hasUpstream = !!head?.upstream;

        if (hasUpstream) {
          await repo.push();
        } else if (branchName) {
          Logger.info('Setting upstream and pushing', { branch: branchName });
          await repo.push('origin', branchName, true);
        } else {
          await repo.push();
        }
        return 'Pushed successfully';
      } catch (e: any) {
        Logger.warn('VS Code Git API push failed, falling back to CLI', { error: e.message });
        // Fall through to CLI fallback instead of throwing immediately.
        // This handles cases where VS Code Git extension hasn't detected
        // a newly initialized repo yet.
      }
    }

    // Fallback to CLI (GIT_ASKPASS handles auth)
    Logger.info('Pushing via git CLI fallback');
    try {
      return await this.execGit(['push']);
    } catch (e: any) {
      const msg = e.message || '';
      if (msg.includes("no upstream") || msg.includes("--set-upstream") || msg.includes("has no upstream")) {
        const currentBranch = await this.getCurrentBranch();
        if (currentBranch && currentBranch !== "Unknown") {
          return await this.execGit(['push', '--set-upstream', 'origin', currentBranch]);
        }
      }
      throw e;
    }
  }

  public async pull(): Promise<string> {
    const repo = this.getVSCodeRepo();
    if (repo) {
      try {
        Logger.info('Pulling via VS Code Git API');
        await repo.pull();
        return 'Pulled successfully';
      } catch (e: any) {
        Logger.error('VS Code Git API pull failed', e);
        throw new Error(`Pull failed: ${e.message}`);
      }
    }
    return await this.execGit(['pull']);
  }

  public async fetch(): Promise<string> {
    const repo = this.getVSCodeRepo();
    if (repo) {
      try {
        Logger.info('Fetching via VS Code Git API');
        await repo.fetch();
        return 'Fetched successfully';
      } catch (e: any) {
        Logger.error('VS Code Git API fetch failed', e);
        throw new Error(`Fetch failed: ${e.message}`);
      }
    }
    return await this.execGit(['fetch']);
  }

  public async fetchPrBranch(prNumber: number): Promise<string> {
    if (!this.workspaceRoot) {
      throw new Error("No repo open");
    }
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      throw new Error(`Invalid PR number: ${prNumber}`);
    }

    const branchName = `pr/${prNumber}`;
    Logger.info('Fetching PR branch', { prNumber, branchName });

    const repo = this.getVSCodeRepo();
    if (repo) {
      try {
        await repo.fetch('origin', `pull/${prNumber}/head:${branchName}`);
        await repo.checkout(branchName);
        return branchName;
      } catch (e: any) {
        Logger.warn('VS Code Git API PR fetch failed, trying CLI', { error: e.message });
      }
    }

    await this.execGit(['fetch', 'origin', `pull/${prNumber}/head:${branchName}`, '--force']);
    await this.execGit(['checkout', branchName]);
    return branchName;
  }

  // ───────────────────────────── Branch Operations ─────────────────────────────

  public async getCurrentBranch(): Promise<string> {
    const repo = this.getVSCodeRepo();
    if (repo?.state?.HEAD?.name) {
      return repo.state.HEAD.name;
    }
    if (!this.workspaceRoot) { return "No Repo"; }
    try {
      return await this.execGit(['rev-parse', '--abbrev-ref', 'HEAD']);
    } catch (e) {
      return "Unknown";
    }
  }

  public async getBranches(): Promise<string[]> {
    try {
      // Fetch latest
      const repo = this.getVSCodeRepo();
      if (repo) {
        try { await repo.fetch('origin', undefined, undefined, true); } catch { /* ok */ }
      } else {
        try { await this.execGit(['fetch', '--all', '--prune']); } catch { /* ok */ }
      }

      const localOutput = await this.execGit(['branch', '--list']);
      const localBranches = localOutput.split('\n')
        .map(b => b.replace(/^[\s*]+/, '').trim())
        .filter(b => b.length > 0 && !b.includes('->'));

      const remoteOutput = await this.execGit(['branch', '-r', '--list']);
      const remoteBranches = remoteOutput.split('\n')
        .map(b => b.replace(/^[\s*]+/, '').trim().replace(/^origin\//, ''))
        .filter(b => b.length > 0 && b !== 'HEAD' && !b.includes('->'));

      const allBranches = Array.from(new Set([...localBranches, ...remoteBranches]));
      Logger.info('Fetched branches', { count: allBranches.length });
      return allBranches;
    } catch (e) {
      Logger.error('Failed to get branches', e);
      return [];
    }
  }

  public async getCurrentRepoBranches(): Promise<string[]> {
    try {
      const repo = this.getVSCodeRepo();
      if (repo) {
        try { await repo.fetch('origin', undefined, undefined, true); } catch { /* ok */ }
      } else {
        try { await this.execGit(['fetch', 'origin', '--prune']); } catch { /* ok */ }
      }

      const remoteOutput = await this.execGit(['ls-remote', '--heads', 'origin']);
      const remoteBranches = remoteOutput.split('\n')
        .filter(line => line.trim().length > 0)
        .map(line => {
          const parts = line.split('\t');
          return parts.length >= 2 ? parts[1].replace('refs/heads/', '') : '';
        })
        .filter(b => b.length > 0);

      let currentBranch = '';
      try { currentBranch = await this.getCurrentBranch(); } catch { /* ok */ }

      const allBranches = Array.from(new Set([...remoteBranches, currentBranch].filter(b => b.length > 0)));
      return allBranches.sort();
    } catch (e) {
      Logger.error('Failed to get current repo branches', e);
      return [];
    }
  }

  public async getOriginBranches(): Promise<string[]> {
    if (!this.workspaceRoot) { return []; }
    try {
      const remoteOutput = await this.execGit(['branch', '-r', '--format=%(refname:short)']);
      return remoteOutput.split('\n')
        .filter(b => b.startsWith('origin/') && b !== 'origin/HEAD')
        .map(b => b.replace('origin/', '').trim())
        .filter(b => b.length > 0);
    } catch (e) {
      return [];
    }
  }

  public async hasLocalBranch(branchName: string): Promise<boolean> {
    try {
      await this.execGit(['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`]);
      return true;
    } catch {
      return false;
    }
  }

  public async hasRemoteBranch(branchName: string): Promise<boolean> {
    try {
      const out = await this.execGit(['ls-remote', '--heads', 'origin', branchName]);
      return !!out && out.trim().length > 0;
    } catch {
      return false;
    }
  }

  public async createBranch(branchName: string): Promise<string> {
    Logger.info('Creating new branch', { branchName });
    if (!/^[a-zA-Z0-9_\/-]+$/.test(branchName)) {
      throw new Error(`Invalid branch name: ${branchName}. Use only alphanumeric, _, /, -`);
    }

    const repo = this.getVSCodeRepo();
    if (repo) {
      try {
        await repo.createBranch(branchName, true);
        return `Switched to a new branch '${branchName}'`;
      } catch (e: any) {
        Logger.warn('VS Code Git API createBranch failed, trying CLI', { error: e.message });
      }
    }
    return await this.execGit(['checkout', '-b', branchName]);
  }

  public async renameBranch(newName: string): Promise<string> {
    Logger.info('Renaming current branch', { newName });
    return await this.execGit(['branch', '-M', newName]);
  }

  public async deleteBranch(branchName: string): Promise<string> {
    const currentBranch = await this.getCurrentBranch();
    if (currentBranch === branchName) {
      const branches = await this.getBranches();
      const target = branches.find(b => b !== branchName && (b === 'main' || b === 'master'))
        || branches.find(b => b !== branchName) || 'main';
      await this.switchBranch(target);
    }

    Logger.info('Deleting branch', { branchName });
    const repo = this.getVSCodeRepo();
    if (repo) {
      try {
        await repo.deleteBranch(branchName, true);
        return `Deleted branch ${branchName}`;
      } catch (e: any) {
        Logger.warn('VS Code Git API deleteBranch failed, trying CLI', { error: e.message });
      }
    }

    const result = await this.execGit(['branch', '-D', branchName]);
    try { await this.execGit(['fetch', '-p']); } catch { /* ok */ }
    return result;
  }

  public async deleteRemoteBranch(branchName: string): Promise<string> {
    if (!this.workspaceRoot) {
      throw new Error("No workspace folder open");
    }

    // Use VS Code Git API push with delete refspec
    const repo = this.getVSCodeRepo();
    if (repo) {
      try {
        await repo.push('origin', `:refs/heads/${branchName}`);
        return `Deleted remote branch ${branchName}`;
      } catch (e: any) {
        Logger.warn('VS Code API remote delete failed, trying CLI', { error: e.message });
      }
    }

    try {
      return await this.execGit(['push', 'origin', '--delete', branchName]);
    } catch (e: any) {
      throw new Error(`Failed to delete remote branch: ${e.message}`);
    }
  }

  public async switchBranch(branchName: string): Promise<string> {
    Logger.info('Switching branch', { branchName });

    // Fetch latest
    const repo = this.getVSCodeRepo();
    if (repo) {
      try { await repo.fetch('origin', undefined, undefined, true); } catch { /* ok */ }
    } else {
      try { await this.execGit(['fetch', '--prune']); } catch { /* ok */ }
    }

    // Try VS Code Git API first (handles remote tracking branches automatically)
    if (repo) {
      try {
        await repo.checkout(branchName);
        return `Switched to branch '${branchName}'`;
      } catch (e: any) {
        Logger.warn('VS Code Git API checkout failed, trying CLI', { error: e.message });
      }
    }

    const hasLocal = await this.hasLocalBranch(branchName);
    if (hasLocal) {
      return await this.execGit(['checkout', branchName]);
    }

    const hasRemote = await this.hasRemoteBranch(branchName);
    if (hasRemote) {
      return await this.execGit(['checkout', '-b', branchName, `origin/${branchName}`]);
    }

    throw new Error(`Branch '${branchName}' not found locally or on remote`);
  }

  public async mergeBranch(branchName: string): Promise<string> {
    Logger.info('Merging branch', { branchName });

    if (!(await this.hasLocalBranch(branchName))) {
      if (await this.hasRemoteBranch(branchName)) {
        await this.execGit(['checkout', '-b', branchName, `origin/${branchName}`]);
        const currentBranch = await this.getCurrentBranch();
        if (currentBranch === branchName) {
          // Need to switch back, but we don't know the original branch
          // This shouldn't happen normally
        }
      } else {
        throw new Error(`Branch '${branchName}' not found locally or on remote`);
      }
    }

    const repo = this.getVSCodeRepo();
    if (repo) {
      try {
        await repo.merge(branchName);
        try { await repo.push(); } catch { /* ok */ }
        return `Merged '${branchName}' successfully`;
      } catch (e: any) {
        if (e.message?.includes('CONFLICTS') || e.message?.includes('conflict')) {
          throw new Error(`Merge conflict detected when merging '${branchName}'. Resolve conflicts manually.`);
        }
        Logger.warn('VS Code Git API merge failed, trying CLI', { error: e.message });
      }
    }

    const mergeResult = await this.execGit(['merge', branchName]);
    try { await this.push(); } catch { /* ok */ }
    return mergeResult;
  }

  // ───────────────────────────── Local Git Operations ─────────────────────────────

  public async getStatus(): Promise<string> {
    if (!this.workspaceRoot) { return "No Repo"; }
    try {
      const status = await this.execGit(['status', '--porcelain=v1', '--untracked-files=all', '--branch']);
      if (!status) { return "Clean"; }
      const lines = status.split('\n').filter(line => !line.startsWith('##'));
      const hasChanges = lines.some(line => line.trim().length > 0);
      return hasChanges ? status : "Clean";
    } catch (e) {
      Logger.error('Failed to get git status', e);
      return "Error getting status";
    }
  }

  public async getRemote(): Promise<string> {
    // Try VS Code Git API first (instant, no subprocess)
    const repo = this.getVSCodeRepo();
    if (repo?.state?.remotes?.length) {
      const origin = repo.state.remotes.find((r: any) => r.name === 'origin');
      if (origin) {
        const url = origin.fetchUrl || origin.pushUrl || '';
        return url.replace(/https:\/\/.*?@/, "https://");
      }
    }

    if (!this.workspaceRoot) { return "No Repo"; }
    try {
      const remotes = await this.execGit(['remote', '-v']);
      const match = remotes.match(/origin\s+(.*?)\s+\(fetch\)/);
      if (match) {
        return match[1].replace(/https:\/\/.*?@/, "https://");
      }
      return "No origin";
    } catch (e) {
      return "Unknown";
    }
  }

  public async getRepoName(): Promise<string> {
    if (!this.workspaceRoot) { return "No Repo"; }
    try {
      let remoteUrl = "";
      try {
        remoteUrl = await this.execGit(['remote', 'get-url', 'origin']);
      } catch {
        remoteUrl = await this.getRemote();
      }

      if (remoteUrl && remoteUrl !== "No origin" && remoteUrl !== "Unknown") {
        const match = remoteUrl.match(/[\/:]?([^\/:]+?)(\.git)?$/);
        if (match) { return match[1]; }
      }
    } catch { /* fallback below */ }

    return this.workspaceRoot.split(/[\\/]/).pop() || "Unknown";
  }

  public async getRepoPath(): Promise<string> {
    return this.workspaceRoot || "No workspace open";
  }

  public async getLastPushedCommit(): Promise<string> {
    if (!this.workspaceRoot) { return "No Repo"; }
    try {
      const upstream = await this.execGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
      return await this.execGit(['log', '-1', '--format=%cr: %s', upstream]);
    } catch {
      try {
        return await this.execGit(['log', '-1', '--format=%cr: %s']);
      } catch {
        return "No commits";
      }
    }
  }

  public async getLastCommit(): Promise<string> {
    if (!this.workspaceRoot) { return "No Repo"; }
    try {
      return await this.execGit(['log', '-1', '--format=%cr: %s']);
    } catch {
      return "No commits";
    }
  }

  public async commit(message: string): Promise<string> {
    if (!message || message.trim().length === 0) {
      throw new Error('Commit message cannot be empty');
    }
    return await this.execGit(['commit', '-m', message]);
  }

  public async addAll(): Promise<string> {
    // On Windows, reserved device names (nul, con, aux, prn, etc.) cause
    // 'git add --all' to fail with "unable to index file 'nul'".
    // Also configure autocrlf to suppress LF/CRLF warnings.
    const isWindows = process.platform === 'win32';

    if (isWindows) {
      // Suppress CRLF warnings on Windows
      try { await this.execGit(['config', 'core.autocrlf', 'true']); } catch { /* ok */ }

      // Use pathspec exclusion to skip Windows reserved device names
      const reserved = ['nul', 'NUL', 'con', 'CON', 'aux', 'AUX', 'prn', 'PRN',
        'com1', 'COM1', 'com2', 'COM2', 'com3', 'COM3', 'com4', 'COM4',
        'lpt1', 'LPT1', 'lpt2', 'LPT2', 'lpt3', 'LPT3'];
      const exclusions = reserved.map(name => `:(exclude)${name}`);

      try {
        await this.execGit(['add', '-A', '--', '.', ...exclusions]);
      } catch (e: any) {
        const msg = e.message || '';
        // If pathspec exclusion isn't supported, fall back to add then reset
        if (msg.includes('pathspec') || msg.includes('not a valid')) {
          try {
            await this.execGit(['add', '--all']);
          } catch (addErr: any) {
            const addMsg = addErr.message || '';
            if (addMsg.includes('nul') || addMsg.includes('NUL') || addMsg.includes('unable to index')) {
              // Stage everything except reserved names: add tracked + new non-reserved files
              await this.execGit(['add', '-u']); // stage modifications/deletions
              // Get untracked files and add only non-reserved ones
              const untracked = await this.getUntrackedFiles();
              const reservedLower = new Set(reserved.map(n => n.toLowerCase()));
              const safeFiles = untracked.filter(f => {
                const baseName = f.split(/[\\/]/).pop()?.toLowerCase() || '';
                return !reservedLower.has(baseName);
              });
              if (safeFiles.length > 0) {
                // Add in batches to avoid command-line length limits
                const batchSize = 50;
                for (let i = 0; i < safeFiles.length; i += batchSize) {
                  const batch = safeFiles.slice(i, i + batchSize);
                  await this.execGit(['add', '--', ...batch]);
                }
              }
            } else {
              throw addErr;
            }
          }
        } else if (msg.includes('nul') || msg.includes('NUL') || msg.includes('unable to index')) {
          // Exclusion syntax worked but nul still slipped through somehow
          await this.execGit(['add', '-u']);
          const untracked = await this.getUntrackedFiles();
          const reservedLower = new Set(reserved.map(n => n.toLowerCase()));
          const safeFiles = untracked.filter(f => {
            const baseName = f.split(/[\\/]/).pop()?.toLowerCase() || '';
            return !reservedLower.has(baseName);
          });
          if (safeFiles.length > 0) {
            const batchSize = 50;
            for (let i = 0; i < safeFiles.length; i += batchSize) {
              const batch = safeFiles.slice(i, i + batchSize);
              await this.execGit(['add', '--', ...batch]);
            }
          }
        } else {
          throw e;
        }
      }
    } else {
      await this.execGit(['add', '--all']);
    }

    return 'All files staged';
  }

  public async stash(message?: string): Promise<string> {
    const repo = this.getVSCodeRepo();
    if (repo) {
      try {
        await repo.stash(message, true);
        return 'Stashed successfully';
      } catch (e: any) {
        Logger.warn('VS Code Git API stash failed, trying CLI', { error: e.message });
      }
    }
    if (message) {
      return await this.execGit(['stash', 'push', '-m', message]);
    }
    return await this.execGit(['stash']);
  }

  public async setRemote(url: string): Promise<string> {
    if (!url.match(/^(https:\/\/|git@)/)) {
      throw new Error('Invalid remote URL. Must start with https:// or git@');
    }
    try {
      try {
        await this.execGit(['remote', 'get-url', 'origin']);
        await this.execGit(['remote', 'set-url', 'origin', url]);
      } catch {
        const repo = this.getVSCodeRepo();
        if (repo) {
          try {
            await repo.addRemote('origin', url);
            return "Remote URL set";
          } catch { /* fall through to CLI */ }
        }
        await this.execGit(['remote', 'add', 'origin', url]);
      }
      return "Remote URL updated";
    } catch (e: any) {
      throw new Error(`Failed to set remote: ${e.message}`);
    }
  }

  public async isRepo(): Promise<boolean> {
    if (!this.workspaceRoot) { return false; }
    try {
      await this.execGit(['rev-parse', '--is-inside-work-tree']);
      return true;
    } catch {
      return false;
    }
  }

  public async init(): Promise<string> {
    const result = await this.execGit(['init']);
    // On Windows, configure autocrlf to prevent LF/CRLF warnings
    if (process.platform === 'win32') {
      try { await this.execGit(['config', 'core.autocrlf', 'true']); } catch { /* ok */ }
    }
    return result;
  }

  // ───────────────────────────── State Information ─────────────────────────────

  public async getRebaseStatus(): Promise<string | null> {
    if (!this.workspaceRoot) { return null; }
    try {
      const gitDir = await this.execGit(['rev-parse', '--git-dir']);
      const absoluteGitDir = path.isAbsolute(gitDir) ? gitDir : path.join(this.workspaceRoot, gitDir);
      if (fs.existsSync(path.join(absoluteGitDir, "rebase-apply")) ||
          fs.existsSync(path.join(absoluteGitDir, "rebase-merge"))) {
        return "Rebase in progress";
      }
      return null;
    } catch { return null; }
  }

  public async getMergeStatus(): Promise<string | null> {
    if (!this.workspaceRoot) { return null; }
    try {
      const gitDir = await this.execGit(['rev-parse', '--git-dir']);
      const absoluteGitDir = path.isAbsolute(gitDir) ? gitDir : path.join(this.workspaceRoot, gitDir);
      if (fs.existsSync(path.join(absoluteGitDir, "MERGE_HEAD"))) {
        return "Merge in progress";
      }
      return null;
    } catch { return null; }
  }

  public async getStashList(): Promise<string[]> {
    if (!this.workspaceRoot) { return []; }
    try {
      const output = await this.execGit(['stash', 'list']);
      if (!output) { return []; }
      return output.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    } catch { return []; }
  }

  public async getConflicts(): Promise<string[]> {
    if (!this.workspaceRoot) { return []; }
    try {
      const output = await this.execGit(['diff', '--name-only', '--diff-filter=U']);
      const conflicts = output ? output.split('\n').map(l => l.trim()).filter(l => l.length > 0) : [];
      if (conflicts.length === 0) {
        try {
          const statusShort = await this.execGit(['status', '--short']);
          return statusShort.split('\n')
            .filter(line => /^(DD|AU|UD|UA|DU|AA|UU)/.test(line))
            .map(line => line.substring(3).trim());
        } catch { return []; }
      }
      return conflicts;
    } catch {
      return [];
    }
  }

  public async getStagedFiles(): Promise<string[]> {
    if (!this.workspaceRoot) { return []; }
    try {
      const output = await this.execGit(['diff', '--cached', '--name-only']);
      return output ? output.split('\n').map(l => l.trim()).filter(l => l.length > 0) : [];
    } catch { return []; }
  }

  public async getUnstagedFiles(): Promise<string[]> {
    if (!this.workspaceRoot) { return []; }
    try {
      const output = await this.execGit(['diff', '--name-only']);
      return output ? output.split('\n').map(l => l.trim()).filter(l => l.length > 0) : [];
    } catch { return []; }
  }

  public async getUntrackedFiles(): Promise<string[]> {
    if (!this.workspaceRoot) { return []; }
    try {
      const output = await this.execGit(['ls-files', '--others', '--exclude-standard']);
      return output ? output.split('\n').map(l => l.trim()).filter(l => l.length > 0) : [];
    } catch { return []; }
  }

  public async isClean(): Promise<boolean> {
    if (!this.workspaceRoot) { return false; }
    try {
      const status = await this.execGit(['status', '--porcelain']);
      return !status || status.trim().length === 0;
    } catch { return false; }
  }

  public async getDiffStats(): Promise<{ files: number; insertions: number; deletions: number }> {
    if (!this.workspaceRoot) { return { files: 0, insertions: 0, deletions: 0 }; }
    try {
      const output = await this.execGit(['diff', '--shortstat']);
      const match = output.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
      if (match) {
        return {
          files: parseInt(match[1] || '0'),
          insertions: parseInt(match[2] || '0'),
          deletions: parseInt(match[3] || '0')
        };
      }
      return { files: 0, insertions: 0, deletions: 0 };
    } catch { return { files: 0, insertions: 0, deletions: 0 }; }
  }

  // ───────────────────────────── Fast Push Pre-flight Checks ─────────────────────────────

  /**
   * Comprehensive pre-flight check for Fast Push.
   * Returns an array of issues found, each with a description and resolution option.
   */
  public async diagnoseFastPushIssues(): Promise<FastPushIssue[]> {
    const issues: FastPushIssue[] = [];

    // 1. Check if repo exists
    if (!(await this.isRepo())) {
      issues.push({
        id: 'no-repo',
        title: 'Not a Git Repository',
        description: 'This folder is not initialized as a git repository.',
        resolution: 'Initialize a new git repository with "git init".',
        autoFixable: true
      });
      return issues; // Can't check anything else without a repo
    }

    // 2. Check for merge conflicts
    const conflicts = await this.getConflicts();
    if (conflicts.length > 0) {
      issues.push({
        id: 'merge-conflicts',
        title: 'Merge Conflicts Detected',
        description: `${conflicts.length} file(s) have unresolved merge conflicts:\n${conflicts.map(f => `  • ${f}`).join('\n')}`,
        resolution: 'Resolve the conflicts in the listed files, then stage them with "git add".',
        autoFixable: false
      });
    }

    // 3. Check for rebase in progress
    const rebaseStatus = await this.getRebaseStatus();
    if (rebaseStatus) {
      issues.push({
        id: 'rebase-in-progress',
        title: 'Rebase In Progress',
        description: 'A git rebase operation is currently in progress.',
        resolution: 'Complete the rebase with "git rebase --continue" or abort it with "git rebase --abort".',
        autoFixable: false
      });
    }

    // 4. Check for merge in progress
    const mergeStatus = await this.getMergeStatus();
    if (mergeStatus) {
      issues.push({
        id: 'merge-in-progress',
        title: 'Merge In Progress',
        description: 'A git merge operation is in progress. This can block commits.',
        resolution: 'Complete the merge by committing, or abort with "git merge --abort".',
        autoFixable: false
      });
    }

    // 5. Check if remote exists
    let hasRemote = false;
    try {
      const remote = await this.getRemote();
      hasRemote = !!remote && remote !== 'No origin' && remote !== 'Unknown' && remote !== 'No Repo';
    } catch { /* no remote */ }
    if (!hasRemote) {
      issues.push({
        id: 'no-remote',
        title: 'No Remote URL Configured',
        description: 'No "origin" remote is set. Push needs a remote destination.',
        resolution: 'Set a remote URL (e.g. https://github.com/user/repo.git).',
        autoFixable: true
      });
    }

    // 6. Check if branches have diverged or upstream is broken
    if (hasRemote) {
      const divergence = await this.getBranchDivergence();
      if (divergence.noUpstream) {
        // Upstream tracking branch is missing or broken
        const currentBranch = await this.getCurrentBranch();
        const remoteBranchExists = await this.hasRemoteBranch(currentBranch);
        if (!remoteBranchExists) {
          issues.push({
            id: 'upstream-missing',
            title: 'Remote Branch Does Not Exist',
            description: `Your local branch '${currentBranch}' tracks a remote branch that no longer exists. The remote may have been changed or the branch deleted.`,
            resolution: `Push will create the branch on the remote with "--set-upstream". This is safe to continue.`,
            autoFixable: true
          });
        } else {
          issues.push({
            id: 'upstream-broken',
            title: 'Upstream Tracking Is Broken',
            description: `Your local branch '${currentBranch}' has a broken upstream tracking configuration. The remote branch exists but the tracking link is misconfigured.`,
            resolution: `Reset the upstream tracking to 'origin/${currentBranch}'.`,
            autoFixable: true
          });
        }
      } else if (divergence.ahead > 0 && divergence.behind > 0) {
        issues.push({
          id: 'branches-diverged',
          title: 'Local & Remote Have Diverged',
          description: `Your branch is ${divergence.ahead} commit(s) ahead and ${divergence.behind} commit(s) behind the remote. A simple push will fail.`,
          resolution: 'Pull with rebase first to sync, then push. This will replay your local commits on top of the remote changes.',
          autoFixable: true
        });
      } else if (divergence.behind > 0) {
        issues.push({
          id: 'behind-remote',
          title: 'Branch Is Behind Remote',
          description: `Your branch is ${divergence.behind} commit(s) behind the remote.`,
          resolution: 'Pull the latest changes before pushing.',
          autoFixable: true
        });
      }
    }

    // 7. Check for dirty submodules
    const dirtySubmodules = await this.getDirtySubmodules();
    if (dirtySubmodules.length > 0) {
      issues.push({
        id: 'dirty-submodules',
        title: 'Submodules Have Uncommitted Changes',
        description: `${dirtySubmodules.length} submodule(s) have local changes:\n${dirtySubmodules.map(s => `  • ${s.name} (${s.status})`).join('\n')}\nParent repo cannot track these until they are committed inside the submodule.`,
        resolution: 'Commit changes inside each submodule first, then stage the submodule reference in the parent repo.',
        autoFixable: false
      });
    }

    // 8. Check if there are actually any changes to commit
    const hasChanges = !(await this.isClean());
    const staged = await this.getStagedFiles();
    if (!hasChanges && staged.length === 0) {
      // Check if there's anything to push even without local changes
      if (hasRemote) {
        const divergence = await this.getBranchDivergence();
        if (divergence.ahead === 0) {
          issues.push({
            id: 'nothing-to-do',
            title: 'No Changes to Commit or Push',
            description: 'Working tree is clean and the branch is up to date with remote. There is nothing to push.',
            resolution: 'Make some changes first, then try Fast Push again.',
            autoFixable: false
          });
        }
        // else: no local changes but ahead -> can still push existing commits
      }
    }

    // 9. Check for detached HEAD
    try {
      const headRef = await this.execGit(['symbolic-ref', '-q', 'HEAD']);
      if (!headRef) {
        issues.push({
          id: 'detached-head',
          title: 'Detached HEAD State',
          description: 'You are not on any branch. Commits in this state may be lost.',
          resolution: 'Create a new branch from this point, or checkout an existing branch.',
          autoFixable: true
        });
      }
    } catch {
      issues.push({
        id: 'detached-head',
        title: 'Detached HEAD State',
        description: 'You are not on any branch. Commits made here may be lost.',
        resolution: 'Create a new branch from this point with "git checkout -b <name>", or switch to an existing branch.',
        autoFixable: true
      });
    }

    // 10. Check for git lock files (stale locks from crashed git processes)
    await this.checkForLockFiles(issues);

    return issues;
  }

  /**
   * Get how far ahead/behind the current branch is relative to its upstream.
   * Returns noUpstream: true when tracking ref is missing or broken.
   */
  public async getBranchDivergence(): Promise<{ ahead: number; behind: number; noUpstream?: boolean }> {
    try {
      // First check if upstream is configured
      try {
        await this.execGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
      } catch {
        // No upstream tracking branch set
        return { ahead: 0, behind: 0, noUpstream: true };
      }

      // Fetch to make sure we have latest remote refs
      try { await this.execGit(['fetch', '--quiet']); } catch { /* ok if offline */ }

      // Check if the upstream ref actually exists after fetch
      try {
        const upstream = await this.execGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
        await this.execGit(['rev-parse', '--verify', upstream.trim()]);
      } catch {
        // Upstream is configured but the remote ref doesn't exist (remote repo changed, branch deleted, etc.)
        return { ahead: 0, behind: 0, noUpstream: true };
      }

      const output = await this.execGit(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']);
      const parts = output.trim().split(/\s+/);
      return {
        ahead: parseInt(parts[0] || '0', 10),
        behind: parseInt(parts[1] || '0', 10)
      };
    } catch {
      return { ahead: 0, behind: 0 };
    }
  }

  /**
   * Detect submodules with uncommitted or untracked changes.
   */
  public async getDirtySubmodules(): Promise<{ name: string; status: string }[]> {
    if (!this.workspaceRoot) { return []; }
    try {
      const output = await this.execGit(['submodule', 'status', '--recursive']);
      if (!output || !output.trim()) { return []; }
      const dirty: { name: string; status: string }[] = [];
      for (const line of output.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) { continue; }
        // Lines starting with + (modified), - (not initialized), or U (merge conflicts)
        const match = trimmed.match(/^([+\-U])\s*[a-f0-9]+\s+(\S+)/);
        if (match) {
          const marker = match[1];
          const name = match[2];
          const statusMap: Record<string, string> = {
            '+': 'modified content',
            '-': 'not initialized',
            'U': 'merge conflict'
          };
          dirty.push({ name, status: statusMap[marker] || 'unknown' });
        }
      }

      // Also check for untracked content via porcelain status
      try {
        const statusOutput = await this.execGit(['status', '--porcelain']);
        for (const line of statusOutput.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) { continue; }
          // Look for submodule entries with (untracked content) or (modified content)
          // git status shows submodules as regular modified entries
          const filePath = trimmed.substring(3).trim();
          if (dirty.some(d => d.name === filePath)) { continue; }
          // Check if path is a submodule by looking for .gitmodules
          try {
            const gitmodulesContent = await this.execGit(['config', '--file', '.gitmodules', '--get', `submodule.${filePath}.path`]);
            if (gitmodulesContent) {
              dirty.push({ name: filePath, status: 'untracked content' });
            }
          } catch { /* not a submodule, ignore */ }
        }
      } catch { /* ok */ }

      return dirty;
    } catch {
      return [];
    }
  }

  /**
   * Check for stale git lock files that can prevent operations.
   */
  private async checkForLockFiles(issues: FastPushIssue[]): Promise<void> {
    if (!this.workspaceRoot) { return; }
    try {
      const gitDir = await this.execGit(['rev-parse', '--git-dir']);
      const absoluteGitDir = path.isAbsolute(gitDir) ? gitDir : path.join(this.workspaceRoot, gitDir);
      const lockFile = path.join(absoluteGitDir, 'index.lock');
      if (fs.existsSync(lockFile)) {
        // Check if the lock is stale (older than 5 minutes)
        const stat = fs.statSync(lockFile);
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs > 5 * 60 * 1000) {
          issues.push({
            id: 'stale-lock',
            title: 'Stale Git Lock File Detected',
            description: 'A git lock file (index.lock) exists and appears stale. This can happen if a previous git process crashed.',
            resolution: 'Remove the stale lock file to unblock git operations.',
            autoFixable: true
          });
        } else {
          issues.push({
            id: 'active-lock',
            title: 'Git Lock File Exists',
            description: 'Another git process may be running. A git lock file (index.lock) exists.',
            resolution: 'Wait for the other git process to finish, or remove the lock if the process has crashed.',
            autoFixable: false
          });
        }
      }
    } catch { /* ignore */ }
  }

  /**
   * Auto-fix: Pull with rebase to resolve diverged branches.
   * Handles broken upstream tracking by falling back to explicit origin/branch.
   */
  public async pullRebase(): Promise<string> {
    const repo = this.getVSCodeRepo();
    if (repo) {
      try {
        Logger.info('Pulling with rebase via VS Code Git API');
        await repo.pull(true); // true = rebase
        return 'Pulled with rebase successfully';
      } catch (e: any) {
        Logger.warn('VS Code Git API pull --rebase failed, trying CLI', { error: e.message });
      }
    }

    try {
      return await this.execGit(['pull', '--rebase']);
    } catch (e: any) {
      const msg = e.message || '';
      // "no such ref was fetched" / "no tracking information" — upstream is broken
      if (msg.includes('no such ref') || msg.includes('no tracking information') || msg.includes('no upstream')) {
        Logger.warn('Pull --rebase failed due to broken upstream, trying explicit origin/<branch>');
        const currentBranch = await this.getCurrentBranch();
        if (currentBranch && currentBranch !== 'Unknown') {
          // Check if the branch exists on remote
          const remoteExists = await this.hasRemoteBranch(currentBranch);
          if (remoteExists) {
            // Fix the upstream and pull
            await this.execGit(['branch', '--set-upstream-to', `origin/${currentBranch}`, currentBranch]);
            return await this.execGit(['pull', '--rebase', 'origin', currentBranch]);
          } else {
            // Remote branch doesn't exist — nothing to pull, just push will create it
            Logger.info('Remote branch does not exist yet, nothing to pull');
            return 'Nothing to pull — remote branch will be created on push';
          }
        }
      }
      throw e;
    }
  }

  /**
   * Auto-fix: Reset upstream tracking for the current branch.
   */
  public async fixUpstreamTracking(): Promise<string> {
    const currentBranch = await this.getCurrentBranch();
    if (!currentBranch || currentBranch === 'Unknown') {
      throw new Error('Cannot determine current branch');
    }
    // Unset and re-set upstream
    try {
      await this.execGit(['branch', '--unset-upstream', currentBranch]);
    } catch { /* may not have upstream set */ }
    await this.execGit(['branch', '--set-upstream-to', `origin/${currentBranch}`, currentBranch]);
    return `Upstream tracking reset to origin/${currentBranch}`;
  }

  /**
   * Auto-fix: Remove stale index.lock file.
   */
  public async removeStaleLockFile(): Promise<boolean> {
    if (!this.workspaceRoot) { return false; }
    try {
      const gitDir = await this.execGit(['rev-parse', '--git-dir']);
      const absoluteGitDir = path.isAbsolute(gitDir) ? gitDir : path.join(this.workspaceRoot, gitDir);
      const lockFile = path.join(absoluteGitDir, 'index.lock');
      if (fs.existsSync(lockFile)) {
        fs.unlinkSync(lockFile);
        Logger.info('Removed stale git lock file');
        return true;
      }
    } catch (e) {
      Logger.error('Failed to remove lock file', e);
    }
    return false;
  }

  /**
   * Auto-fix: Create a new branch from detached HEAD.
   */
  public async createBranchFromDetachedHead(branchName: string): Promise<string> {
    return await this.execGit(['checkout', '-b', branchName]);
  }
}

export interface FastPushIssue {
  id: string;
  title: string;
  description: string;
  resolution: string;
  autoFixable: boolean;
}
