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

  public async runGitCommand(command: string): Promise<string> {
    return await this.exec(command);
  }

  private async exec(command: string, retries = 0): Promise<string> {
    if (!this.workspaceRoot) {
      throw new Error("No workspace folder open");
    }

    return new Promise((resolve, reject) => {
      const options = {
        cwd: this.workspaceRoot,
        timeout: 30000, // 30 second timeout
        maxBuffer: 10 * 1024 * 1024 // 10MB buffer
      };

      cp.exec(command, options, async (err, stdout, stderr) => {
        const out = (stdout || '').toString();
        const errOut = (stderr || '').toString();
        
        if (err) {
          Logger.debug('Git command failed', { command, error: err.message, stderr: errOut });
          
          // Retry logic for transient failures
          if (retries < 2 && (err.message.includes('timeout') || err.message.includes('Connection'))) {
            Logger.warn(`Retrying git command (attempt ${retries + 1})`, { command });
            try {
              const result = await this.exec(command, retries + 1);
              resolve(result);
              return;
            } catch (retryErr) {
              // Continue to reject with original error
            }
          }

          const parts: string[] = [];
          if (err.message) {parts.push(err.message);}
          if (errOut) {parts.push(errOut.trim());}
          if (out && !out.includes('fatal')) {parts.push(`Stdout: ${out.trim()}`);}
          
          reject(new Error(parts.join('\n')));
          return;
        }
        resolve(out.trim());
      });
    });
  }

  public async getLastPushedCommit(): Promise<string> {
    if (!this.workspaceRoot) {
      return "No Repo";
    }
    try {
      // Try to get the upstream branch for the current HEAD
      const upstream = await this.exec("git rev-parse --abbrev-ref --symbolic-full-name @{u}");
      return await this.exec(`git log -1 --format="%cr: %s" ${upstream}`);
    } catch (e) {
      // Fallback to local HEAD if no upstream configured
      try {
        return await this.exec('git log -1 --format="%cr: %s"');
      } catch (e2) {
        return "No commits";
      }
    }
  }

  public async getOriginBranches(): Promise<string[]> {
    if (!this.workspaceRoot) {
      return [];
    }
    try {
      const remoteOutput = await this.exec("git branch -r --format='%(refname:short)'");
      const originBranches = remoteOutput
        .split('\n')
        .filter(b => b.startsWith('origin/') && b !== 'origin/HEAD')
        .map(b => b.replace('origin/', '').trim())
        .filter(b => b.length > 0);
      return originBranches;
    } catch (e) {
      return [];
    }
  }

  public async deleteRemoteBranch(branchName: string): Promise<string> {
    if (!this.workspaceRoot) {
      throw new Error("No workspace folder open");
    }
    try {
      return await this.exec(`git push origin --delete ${branchName}`);
    } catch (e: any) {
      throw new Error(`Failed to delete remote branch: ${e.message}`);
    }
  }
  public async getRepoName(): Promise<string> {
    if (!this.workspaceRoot) {
      return "No Repo";
    }
    // Try to get from remote origin first
    try {
      let remoteUrl = "";
      try {
        remoteUrl = await this.exec("git remote get-url origin");
      } catch {
        remoteUrl = await this.getRemote();
      }

      if (remoteUrl && remoteUrl !== "No origin" && remoteUrl !== "Unknown") {
        // Extract name from URL (supports https and ssh)
        // e.g., https://github.com/user/repo.git -> repo
        // e.g., git@github.com:user/repo.git -> repo
        const match = remoteUrl.match(/[\/:]?([^\/:]+?)(\.git)?$/);
        if (match) {
          return match[1];
        }
      }
    } catch (e) { }

    // Fallback to folder name
    return this.workspaceRoot.split(/[\\/]/).pop() || "Unknown";
  }

  public async getRepoPath(): Promise<string> {
    return this.workspaceRoot || "No workspace open";
  }

  /**
   * Get comprehensive file status with all changes
   * Returns porcelain v1 format with detailed status codes
   * Status codes: M(modified), A(added), D(deleted), R(renamed), C(copied), U(unmerged), ?(untracked), !(ignored)
   */
  public async getStatus(): Promise<string> {
    if (!this.workspaceRoot) {
      return "No Repo";
    }
    try {
      // Use porcelain format for consistent, machine-readable output
      // --short shows staged and unstaged changes
      // --untracked-files=all shows all untracked files including in subdirectories
      // --ignored shows ignored files when needed
      const status = await this.exec("git status --porcelain=v1 --untracked-files=all --branch");
      
      if (!status) {
        return "Clean";
      }
      
      // Remove the branch line (## branch...) to check if there are actual changes
      const lines = status.split('\n').filter(line => !line.startsWith('##'));
      const hasChanges = lines.some(line => line.trim().length > 0);
      
      // Return "Clean" if only branch line exists, otherwise return full status for parsing
      return hasChanges ? status : "Clean";
    } catch (e) {
      Logger.error('Failed to get git status', e);
      return "Error getting status";
    }
  }

  public async getCurrentBranch(): Promise<string> {
    if (!this.workspaceRoot) {
      return "No Repo";
    }
    try {
      return await this.exec("git rev-parse --abbrev-ref HEAD");
    } catch (e) {
      return "Unknown";
    }
  }

  public async getRemote(): Promise<string> {
    if (!this.workspaceRoot) {
      return "No Repo";
    }
    try {
      const remotes = await this.exec("git remote -v");
      // Parse first origin fetch
      const match = remotes.match(/origin\s+(.*?)\s+\(fetch\)/);
      if (match) {
        // Sanitize URL to remove credentials for display
        return match[1].replace(/https:\/\/.*?@/, "https://");
      }
      return "No origin";
    } catch (e) {
      return "Unknown";
    }
  }

  public async commit(message: string): Promise<string> {
    if (!message || message.trim().length === 0) {
      throw new Error('Commit message cannot be empty');
    }
    // Properly escape message for shell
    const escapedMessage = message.replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');
    Logger.debug('Creating commit', { messageLength: message.length });
    return await this.exec(`git commit -m "${escapedMessage}"`);
  }

  public async push(): Promise<string> {
    try {
      return await this.exec("git push");
    } catch (e: any) {
      Logger.warn('Initial push failed, attempting to set upstream', { error: e.message });
      // Handle "no upstream branch" error
      if (e.message.includes("no upstream branch") || e.message.includes("push.autoSetupRemote")) {
        const currentBranch = await this.getCurrentBranch();
        if (currentBranch && currentBranch !== "Unknown") {
          Logger.info('Setting upstream branch', { branch: currentBranch });
          return await this.exec(`git push --set-upstream origin "${currentBranch}"`);
        }
      }
      throw e;
    }
  }

  public async pull(): Promise<string> {
    return await this.exec("git pull");
  }

  public async fetch(): Promise<string> {
    return await this.exec("git fetch");
  }

  public async stash(message?: string): Promise<string> {
    if (message) {
      return await this.exec(`git stash push -m "${message}"`);
    }
    return await this.exec("git stash");
  }

  public async addAll(): Promise<string> {
    return await this.exec("git add .");
  }

  public async updateRemoteUrlWithToken(token: string): Promise<string> {
    try {
      const remoteUrl = await this.exec("git remote get-url origin");
      // Check if it's an HTTPS URL
      if (remoteUrl.startsWith("https://")) {
        // Remove existing auth if any
        const cleanUrl = remoteUrl.replace(/https:\/\/.*?@/, "https://");
        const newUrl = cleanUrl.replace("https://", `https://${token}@`);
        await this.exec(`git remote set-url origin ${newUrl}`);
        return "Remote URL updated with token";
      }
      return "Remote URL is not HTTPS, skipping token update";
    } catch (e) {
      return "Failed to update remote URL";
    }
  }

  public async setRemote(url: string): Promise<string> {
    try {
      // Check if origin exists
      try {
        await this.exec("git remote get-url origin");
        // If it exists, set-url
        await this.exec(`git remote set-url origin ${url}`);
      } catch (e) {
        // If it doesn't exist, add it
        await this.exec(`git remote add origin ${url}`);
      }
      return "Remote URL updated";
    } catch (e: any) {
      throw new Error(`Failed to set remote: ${e.message}`);
    }
  }

  public async getBranches(): Promise<string[]> {
    try {
      // First, ensure we have latest remote data
      try {
        await this.exec('git fetch --all --prune');
      } catch (e) {
        Logger.warn('Failed to fetch before getting branches', { error: e });
      }

      // Get local branches (without format to avoid quote issues)
      const localOutput = await this.exec("git branch --list");
      const localBranches = localOutput
        .split('\n')
        .map(b => b.replace(/^[\s*]+/, '').trim()) // Remove * and spaces
        .filter(b => b.length > 0 && !b.includes('->'));

      // Get remote branches
      const remoteOutput = await this.exec("git branch -r --list");
      const remoteBranches = remoteOutput
        .split('\n')
        .map(b => b.replace(/^[\s*]+/, '').trim())
        .map(b => b.replace(/^origin\//, '')) // Remove origin/ prefix
        .filter(b => b.length > 0 && b !== 'HEAD' && !b.includes('->'));

      // Merge and deduplicate
      const allBranches = Array.from(new Set([...localBranches, ...remoteBranches]));
      Logger.info('Fetched branches', { count: allBranches.length, branches: allBranches });
      return allBranches;
    } catch (e) {
      Logger.error('Failed to get branches', e);
      return [];
    }
  }

  /**
   * Gets branches from current repository's origin remote only (not all remotes)
   * This ensures we only see branches from the current repo, not from other remotes
   * Always fetches fresh data and prunes deleted branches
   */
  public async getCurrentRepoBranches(): Promise<string[]> {
    try {
      // Fetch and prune in one step
      try {
        await this.exec('git fetch origin --prune');
      } catch (e) {
        Logger.warn('Failed to fetch origin before getting branches', { error: e });
      }

      // Get remote branches from origin (source of truth)
      const remoteOutput = await this.exec("git ls-remote --heads origin");
      const remoteBranches = remoteOutput
        .split('\n')
        .filter(line => line.trim().length > 0)
        .map(line => {
          // Format: <hash>\trefs/heads/<branch-name>
          const parts = line.split('\t');
          if (parts.length >= 2) {
            return parts[1].replace('refs/heads/', '');
          }
          return '';
        })
        .filter(b => b.length > 0);

      // Get current local branch
      let currentBranch = '';
      try {
        currentBranch = await this.exec('git rev-parse --abbrev-ref HEAD');
      } catch (e) {
        Logger.warn('Failed to get current branch', { error: e });
      }

      // Combine remote branches with current branch (in case it's local-only)
      const allBranches = Array.from(new Set([...remoteBranches, currentBranch].filter(b => b.length > 0)));
      
      Logger.info('Fetched current repo branches', { 
        count: allBranches.length, 
        branches: allBranches
      });
      return allBranches.sort(); // Sort alphabetically
    } catch (e) {
      Logger.error('Failed to get current repo branches', e);
      return [];
    }
  }

  public async hasLocalBranch(branchName: string): Promise<boolean> {
    try {
      await this.exec(`git show-ref --verify --quiet "refs/heads/${branchName}"`);
      return true;
    } catch {
      return false;
    }
  }

  public async hasRemoteBranch(branchName: string): Promise<boolean> {
    try {
      const out = await this.exec(`git ls-remote --heads origin "${branchName}"`);
      return !!out && out.trim().length > 0;
    } catch {
      return false;
    }
  }

  public async createBranch(branchName: string): Promise<string> {
    Logger.info('Creating new branch', { branchName });
    // Validate branch name characters
    if (!/^[a-zA-Z0-9_\/-]+$/.test(branchName)) {
      throw new Error(`Invalid branch name: ${branchName}. Use only alphanumeric, _, /, -`);
    }
    return await this.exec(`git checkout -b "${branchName}"`);
  }

  public async deleteBranch(branchName: string): Promise<string> {
    const currentBranch = await this.getCurrentBranch();
    
    if (currentBranch === branchName) {
      Logger.info('Switching away from branch before deletion', { branchName });
      const branches = await this.getBranches();
      const target = branches.find(b => b !== branchName && (b === 'main' || b === 'master')) || branches.find(b => b !== branchName) || 'main';
      await this.switchBranch(target);
    }
    
    Logger.info('Deleting branch', { branchName });
    const result = await this.exec(`git branch -D "${branchName}"`);
    await this.exec('git fetch -p'); // Prune deleted remote branches
    return result;
  }

  public async switchBranch(branchName: string): Promise<string> {
    // Don't escape the branch name here - use the actual name
    Logger.info('Switching branch', { branchName });
    
    // Ensure we have latest branch info
    try {
      await this.exec('git fetch --prune');
    } catch (e) {
      Logger.warn('Fetch failed before branch switch', { error: e });
    }
    
    const hasLocal = await this.hasLocalBranch(branchName);
    const hasRemote = await this.hasRemoteBranch(branchName);
    
    Logger.debug('Branch availability', { branchName, hasLocal, hasRemote });
    
    if (hasLocal) {
      Logger.info('Switching to existing local branch', { branchName });
      return await this.exec(`git checkout "${branchName}"`);
    }

    if (hasRemote) {
      Logger.info('Creating tracking branch from remote', { branchName });
      return await this.exec(`git checkout -b "${branchName}" "origin/${branchName}"`);
    }

    throw new Error(`Branch '${branchName}' not found locally or on remote`);
  }

  public async mergeBranch(branchName: string): Promise<string> {
    Logger.info('Merging branch', { branchName });
    
    if (!(await this.hasLocalBranch(branchName))) {
      if (await this.hasRemoteBranch(branchName)) {
        Logger.info('Creating local tracking branch for merge', { branchName });
        await this.exec(`git checkout -b "${branchName}" "origin/${branchName}"`);
        // Switch back to original branch
        const currentBranch = await this.getCurrentBranch();
        if (currentBranch !== branchName) {
          await this.switchBranch(currentBranch);
        }
      } else {
        throw new Error(`Branch '${branchName}' not found locally or on remote`);
      }
    }
    
    const mergeResult = await this.exec(`git merge "${branchName}"`);
    Logger.info('Pushing merge to remote');
    try {
      await this.exec('git push'); // Push merge to remote
    } catch (e) {
      Logger.warn('Failed to push merge', { error: e });
    }
    return mergeResult;
  }

  public async getLastCommit(): Promise<string> {
    if (!this.workspaceRoot) {
      return "No Repo";
    }
    try {
      // Get relative time and subject of the last commit
      return await this.exec('git log -1 --format="%cr: %s"');
    } catch (e) {
      return "No commits";
    }
  }

  public async isRepo(): Promise<boolean> {
    if (!this.workspaceRoot) {
      return false;
    }
    try {
      await this.exec("git rev-parse --is-inside-work-tree");
      return true;
    } catch {
      return false;
    }
  }

  public async init(): Promise<string> {
    return await this.exec("git init");
  }

  public async getRebaseStatus(): Promise<string | null> {
    if (!this.workspaceRoot) {return null;}
    try {
      const gitDir = await this.exec("git rev-parse --git-dir");
      const absoluteGitDir = path.isAbsolute(gitDir) ? gitDir : path.join(this.workspaceRoot, gitDir);

      if (fs.existsSync(path.join(absoluteGitDir, "rebase-apply"))) {
        return "Rebase in progress";
      }
      if (fs.existsSync(path.join(absoluteGitDir, "rebase-merge"))) {
        return "Rebase in progress";
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  public async getMergeStatus(): Promise<string | null> {
    if (!this.workspaceRoot) {return null;}
    try {
      const gitDir = await this.exec("git rev-parse --git-dir");
      const absoluteGitDir = path.isAbsolute(gitDir) ? gitDir : path.join(this.workspaceRoot, gitDir);

      if (fs.existsSync(path.join(absoluteGitDir, "MERGE_HEAD"))) {
        return "Merge in progress";
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  public async getStashList(): Promise<string[]> {
    if (!this.workspaceRoot) {return [];}
    try {
      const output = await this.exec("git stash list");
      if (!output) {return [];}
      return output.split('\n').map(line => line.trim()).filter(l => l.length > 0);
    } catch (e) {
      return [];
    }
  }

  /**
   * Get all conflicted files (merge conflicts)
   * Returns array of file paths with unmerged changes
   */
  public async getConflicts(): Promise<string[]> {
    if (!this.workspaceRoot) {return [];}
    try {
      // Get unmerged files (both modified)
      const output = await this.exec("git diff --name-only --diff-filter=U");
      const conflicts = output ? output.split('\n').map(l => l.trim()).filter(l => l.length > 0) : [];
      
      // Also check for files with conflict markers in status
      if (conflicts.length === 0) {
        try {
          const statusShort = await this.exec("git status --short");
          const unmergedFiles = statusShort
            .split('\n')
            .filter(line => /^(DD|AU|UD|UA|DU|AA|UU)/.test(line))
            .map(line => line.substring(3).trim());
          return unmergedFiles;
        } catch {
          return [];
        }
      }
      
      return conflicts;
    } catch (e) {
      Logger.error('Failed to get conflicts', e);
      return [];
    }
  }

  /**
   * Get all staged files
   */
  public async getStagedFiles(): Promise<string[]> {
    if (!this.workspaceRoot) {return [];}
    try {
      const output = await this.exec("git diff --cached --name-only");
      return output ? output.split('\n').map(l => l.trim()).filter(l => l.length > 0) : [];
    } catch (e) {
      Logger.error('Failed to get staged files', e);
      return [];
    }
  }

  /**
   * Get all unstaged modified files
   */
  public async getUnstagedFiles(): Promise<string[]> {
    if (!this.workspaceRoot) {return [];}
    try {
      const output = await this.exec("git diff --name-only");
      return output ? output.split('\n').map(l => l.trim()).filter(l => l.length > 0) : [];
    } catch (e) {
      Logger.error('Failed to get unstaged files', e);
      return [];
    }
  }

  /**
   * Get all untracked files
   */
  public async getUntrackedFiles(): Promise<string[]> {
    if (!this.workspaceRoot) {return [];}
    try {
      const output = await this.exec("git ls-files --others --exclude-standard");
      return output ? output.split('\n').map(l => l.trim()).filter(l => l.length > 0) : [];
    } catch (e) {
      Logger.error('Failed to get untracked files', e);
      return [];
    }
  }

  /**
   * Check if working directory is clean (no changes)
   */
  public async isClean(): Promise<boolean> {
    if (!this.workspaceRoot) {return false;}
    try {
      const status = await this.exec("git status --porcelain");
      return !status || status.trim().length === 0;
    } catch (e) {
      return false;
    }
  }

  /**
   * Get file diff statistics (insertions/deletions)
   */
  public async getDiffStats(): Promise<{ files: number; insertions: number; deletions: number }> {
    if (!this.workspaceRoot) {
      return { files: 0, insertions: 0, deletions: 0 };
    }
    try {
      const output = await this.exec("git diff --shortstat");
      const match = output.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
      if (match) {
        return {
          files: parseInt(match[1] || '0'),
          insertions: parseInt(match[2] || '0'),
          deletions: parseInt(match[3] || '0')
        };
      }
      return { files: 0, insertions: 0, deletions: 0 };
    } catch (e) {
      return { files: 0, insertions: 0, deletions: 0 };
    }
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
    
    // Fetch into local branch pr/ID (force to update if exists)
    await this.exec(`git fetch origin pull/${prNumber}/head:${branchName} --force`);
    // Checkout the branch
    await this.exec(`git checkout ${branchName}`);
    return branchName;
  }

}
