import * as vscode from 'vscode';
import * as https from 'https';
import { Logger } from './logger';

/**
 * Simple serial request queue — runs one request at a time to prevent
 * TLS handshake failures from too many simultaneous connections.
 */
class RequestQueue {
  private queue: Array<{ run: () => Promise<any>; resolve: (v: any) => void; reject: (e: any) => void }> = [];
  private running = 0;
  private readonly maxConcurrent = 2; // max 2 simultaneous connections

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ run: fn, resolve, reject });
      this.drain();
    });
  }

  private async drain(): Promise<void> {
    while (this.running < this.maxConcurrent && this.queue.length > 0) {
      const item = this.queue.shift()!;
      this.running++;
      try {
        const result = await item.run();
        item.resolve(result);
      } catch (e) {
        item.reject(e);
      } finally {
        this.running--;
        this.drain(); // process next
      }
    }
  }
}

// Single shared queue for all GitHub API requests
const requestQueue = new RequestQueue();

export class AuthService {
	private context: vscode.ExtensionContext;

	constructor(context: vscode.ExtensionContext) {
		this.context = context;
		Logger.debug('AuthService initialized', { contextAvailable: !!context });
	}

	public async getUserProfile(token: string): Promise<any> {
		Logger.debug('Fetching user profile via REST');

		try {
			// Fetch sequentially to avoid connection flooding
			const headers = {
				'Authorization': `Bearer ${token}`,
				'User-Agent': 'VSCode-Gitsy',
				'Accept': 'application/vnd.github.v3+json'
			};

			// 1. User profile (required)
			const user = await this.makeRequest('https://api.github.com/user', 'GET', null, headers);

			if (!user || !user.login) {
				throw new Error('Invalid user response from GitHub API');
			}

			// 2. Emails (optional, sequential)
			let email = user.email || '';
			if (!email) {
				try {
					const emails = await this.makeRequest('https://api.github.com/user/emails', 'GET', null, headers);
					if (Array.isArray(emails)) {
						const primary = emails.find((e: any) => e.primary);
						if (primary) { email = primary.email; }
					}
				} catch {
					Logger.debug('Could not fetch email (non-critical)');
				}
			}

			// 3. Contributions (optional, sequential)
			let contributions = 0;
			try {
				const contribQuery = `query { viewer { contributionsCollection { contributionCalendar { totalContributions } } } }`;
				const gqlResponse: any = await this.postRequest('https://api.github.com/graphql', JSON.stringify({ query: contribQuery }), {
					'Authorization': `Bearer ${token}`,
					'Content-Type': 'application/json',
					'User-Agent': 'VSCode-Gitsy',
					'Accept': 'application/json'
				});
				contributions = gqlResponse?.data?.viewer?.contributionsCollection?.contributionCalendar?.totalContributions || 0;
			} catch {
				Logger.debug('Could not fetch contributions (non-critical)');
			}

			const profile = {
				login: user.login,
				name: user.name || user.login,
				email: email || 'No public email',
				avatarUrl: user.avatar_url || '',
				repositories: { totalCount: user.public_repos || 0 },
				contributionsCollection: { contributionCalendar: { totalContributions: contributions } }
			};

			Logger.info('User profile fetched successfully', { login: profile.login });
			return profile;
		} catch (e: any) {
			Logger.error('Failed to fetch user profile', e);
			throw new Error(`Failed to fetch user profile: ${e.message}`);
		}
	}

    public async getUserRepos(token: string): Promise<any[]> {
        // Fetch ALL user's repositories with pagination
        const allRepos: any[] = [];
        let page = 1;
        const perPage = 100;
        const maxPages = 10; // Safety limit: 1000 repos max

        try {
            while (page <= maxPages) {
                const url = `https://api.github.com/user/repos?per_page=${perPage}&sort=updated&type=owner&page=${page}`;
                const response: any = await this.makeRequest(url, 'GET', null, {
                    'Authorization': `Bearer ${token}`,
                    'User-Agent': 'VSCode-Gitsy',
                    'Accept': 'application/vnd.github.v3+json'
                });

                if (!Array.isArray(response) || response.length === 0) {
                    break;
                }

                allRepos.push(...response);

                if (response.length < perPage) {
                    break; // Last page
                }
                page++;
            }

            Logger.info(`Fetched ${allRepos.length} repos across ${page} page(s)`);

            return allRepos.map((repo: any) => ({
                name: repo.name,
                full_name: repo.full_name,
                html_url: repo.html_url,
                ssh_url: repo.ssh_url,
                clone_url: repo.clone_url,
                private: repo.private
            }));
        } catch (e: any) {
            Logger.error('Failed to fetch repos', e);
            throw new Error(`Failed to fetch repos: ${e.message}`);
        }
    }

    public async createRepo(token: string, name: string, isPrivate: boolean, description?: string): Promise<any> {
        const body = JSON.stringify({
            name: name,
            private: isPrivate,
            description: description,
            auto_init: false
        });

        const response: any = await this.postRequest('https://api.github.com/user/repos', body, {
            'Authorization': `Bearer ${token}`,
            'User-Agent': 'VSCode-Gitsy',
            'Content-Type': 'application/json',
            'Accept': 'application/vnd.github.v3+json'
        });

        if (response.errors) {
            throw new Error(response.message || "Failed to create repository");
        }

        return {
            name: response.name,
            full_name: response.full_name,
            html_url: response.html_url,
            ssh_url: response.ssh_url,
            clone_url: response.clone_url
        };
    }

    public async getRepoBranches(token: string, owner: string, repo: string): Promise<string[]> {
        // Fetch ALL branches with pagination
        const allBranches: string[] = [];
        let page = 1;
        const perPage = 100;

        try {
            while (page <= 5) {
                const url = `https://api.github.com/repos/${owner}/${repo}/branches?per_page=${perPage}&page=${page}`;
                const response: any = await this.makeRequest(url, 'GET', null, {
                    'Authorization': `Bearer ${token}`,
                    'User-Agent': 'VSCode-Gitsy',
                    'Accept': 'application/vnd.github.v3+json'
                });

                if (!Array.isArray(response) || response.length === 0) {
                    break;
                }

                allBranches.push(...response.map((branch: any) => branch.name));

                if (response.length < perPage) {
                    break;
                }
                page++;
            }

            return allBranches;
        } catch (e) {
            Logger.warn('Failed to fetch branches from GitHub API', { error: e, owner, repo });
            return [];
        }
    }

    public async getPullRequests(token: string, owner: string, repo: string): Promise<any[]> {
        const query = `
        query($owner: String!, $repo: String!) {
            repository(owner: $owner, name: $repo) {
                pullRequests(first: 10, states: OPEN, orderBy: {field: CREATED_AT, direction: DESC}) {
                    nodes {
                        title
                        url
                        number
                        author { login }
                        createdAt
                        isDraft
                        mergeable
                        headRefName
                        headRepository { owner { login } url }
                    }
                }
            }
        }`;

        try {
            const response: any = await this.postRequest('https://api.github.com/graphql', JSON.stringify({ query, variables: { owner, repo } }), {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'User-Agent': 'VSCode-Gitsy'
            });
            return response?.data?.repository?.pullRequests?.nodes || [];
        } catch (e) {
            Logger.error("Failed to fetch PRs", e);
            return [];
        }
    }

    public async getCommitStatus(token: string, owner: string, repo: string, branch: string): Promise<string | null> {
        const query = `
        query($owner: String!, $repo: String!, $branch: String!) {
            repository(owner: $owner, name: $repo) {
                object(expression: $branch) {
                    ... on Commit {
                        statusCheckRollup {
                            state
                        }
                    }
                }
            }
        }`;
        try {
            const response: any = await this.postRequest('https://api.github.com/graphql', JSON.stringify({ query, variables: { owner, repo, branch } }), {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'User-Agent': 'VSCode-Gitsy'
            });
            return response?.data?.repository?.object?.statusCheckRollup?.state || null;
        } catch (e) {
            return null;
        }
    }

    public async deleteRepoBranch(token: string, owner: string, repo: string, branch: string): Promise<boolean> {
        const url = `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`;
        try {
            await this.makeRequest(url, 'DELETE', null, {
                'Authorization': `Bearer ${token}`,
                'User-Agent': 'VSCode-Gitsy',
                'Accept': 'application/vnd.github.v3+json'
            });
            return true;
        } catch (e: any) {
            throw new Error(e.message || 'Failed to delete branch via API');
        }
    }

    public async mergePullRequest(token: string, owner: string, repo: string, prNumber: number, method: 'merge' | 'squash' | 'rebase'): Promise<boolean> {
        const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/merge`;
        const body = JSON.stringify({
            merge_method: method
        });

        const response = await this.makeRequest(url, 'PUT', body, {
            'Authorization': `Bearer ${token}`,
            'User-Agent': 'VSCode-Gitsy',
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json'
        });

        if (response.merged) {
            return true;
        } else {
            throw new Error(response.message || 'Merge failed');
        }
    }

    private postRequest(url: string, body: any, headers: any = {}): Promise<any> {
        return this.makeRequest(url, 'POST', body, headers);
    }

    /**
     * Make an HTTP request through the serial queue with retry logic.
     * The queue ensures at most 2 concurrent requests to prevent TLS flooding.
     */
    private async makeRequest(url: string, method: string, body: any, headers: any = {}, retries = 3): Promise<any> {
        return requestQueue.enqueue(() => this._makeRequestWithRetry(url, method, body, headers, retries));
    }

    private async _makeRequestWithRetry(url: string, method: string, body: any, headers: any, retries: number): Promise<any> {
        let lastError: Error | null = null;

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const result = await this._doRequest(url, method, body, { ...headers });
                return result;
            } catch (e: any) {
                lastError = e;
                const isRetryable = /ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|socket hang up|TLS|disconnected/i.test(e.message);

                if (isRetryable && attempt < retries) {
                    const delay = attempt * 1500; // 1.5s, 3s backoff
                    Logger.warn(`Request failed (attempt ${attempt}/${retries}), retrying in ${delay}ms`, { url, error: e.message });
                    await new Promise(r => setTimeout(r, delay));
                } else {
                    break;
                }
            }
        }

        throw lastError || new Error('Request failed');
    }

    private _doRequest(url: string, method: string, body: any, headers: any): Promise<any> {
        return new Promise((resolve, reject) => {
            const urlObj = new URL(url);

            let bodyStr: string | undefined;
            if (body) {
                bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
                headers['Content-Length'] = Buffer.byteLength(bodyStr, 'utf8').toString();
            }

            // Create a fresh agent per request — no persistent sockets that can go stale
            const options: https.RequestOptions = {
                hostname: urlObj.hostname,
                path: urlObj.pathname + urlObj.search,
                method: method,
                headers: headers,
                timeout: 30000
            };

            Logger.debug('Making HTTP request', { method, url });

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try {
                        if (!data || data.trim() === '') {
                            resolve(null);
                            return;
                        }
                        const parsed = JSON.parse(data);
                        if (res.statusCode && res.statusCode >= 400) {
                            Logger.error('HTTP request failed', null, { statusCode: res.statusCode, response: parsed });
                            reject(new Error(parsed.message || `HTTP ${res.statusCode}`));
                            return;
                        }
                        resolve(parsed);
                    } catch (e) {
                        Logger.error('Failed to parse response', e, { data: data.substring(0, 200) });
                        reject(e);
                    }
                });
                res.on('error', (e) => {
                    reject(e);
                });
            });

            req.on('timeout', () => {
                req.destroy();
                Logger.error('HTTP request timed out', null, { url, method });
                reject(new Error('Request timed out'));
            });

            req.on('error', (e: any) => {
                Logger.error('HTTP request error', e, { url, method });
                reject(e);
            });

            if (bodyStr) {
                req.write(bodyStr);
            }
            req.end();
        });
    }
}
