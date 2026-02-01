import * as vscode from 'vscode';
import * as https from 'https';
import { Logger } from './logger';

export class AuthService {
	// @ts-ignore - context reserved for future use (e.g., secret storage)
	private context: vscode.ExtensionContext;

	constructor(context: vscode.ExtensionContext) {
		this.context = context;
		Logger.debug('AuthService initialized', { contextAvailable: !!context });
	}

	public async getUserProfile(token: string): Promise<any> {
		Logger.debug('Fetching user profile');
		const query = `query {
			viewer {
				login
				name
				email
				avatarUrl
				createdAt
				followers { totalCount }
				following { totalCount }
				repositories(ownerAffiliations: OWNER) { totalCount }
				starredRepositories { totalCount }
				gists { totalCount }
				organizations(first: 10) { nodes { login avatarUrl } }
				contributionsCollection { contributionCalendar { totalContributions } }
			}
		}`;

		try {
			const response: any = await this.postRequest('https://api.github.com/graphql', JSON.stringify({ query }), {
				'Authorization': `Bearer ${token}`,
				'Content-Type': 'application/json',
				'User-Agent': 'VSCode-GitWise',
			});

			if (response.errors) {
				Logger.error('GitHub GraphQL error', null, { errors: response.errors });
				throw new Error(response.errors[0].message);
			}

			const viewer = response.data.viewer;

			// Try to get primary email if missing
			if (!viewer.email) {
				try {
					const emails: any = await this.makeRequest('https://api.github.com/user/emails', 'GET', null, {
						'Authorization': `Bearer ${token}`,
						'User-Agent': 'VSCode-GitWise',
					});
					if (Array.isArray(emails)) {
						const primary = emails.find((e: any) => e.primary);
						if (primary) {
							viewer.email = primary.email;
						}
					}
				} catch (e) {
					Logger.warn("Failed to fetch emails via REST", { error: e });
				}
			}

			Logger.info('User profile fetched successfully', { login: viewer.login });
			return viewer;
		} catch (e: any) {
			Logger.error('Failed to fetch user profile', e);
			throw new Error(`Failed to fetch user profile: ${e.message}`);
		}
	}

    public async getUserRepos(token: string): Promise<any[]> {
        // Fetch user's repositories (first 100)
        try {
            const response: any = await this.makeRequest('https://api.github.com/user/repos?per_page=100&sort=updated&type=owner', 'GET', null, {
                'Authorization': `Bearer ${token}`,
                'User-Agent': 'VSCode-GitWise',
                'Accept': 'application/vnd.github.v3+json'
            });

            if (Array.isArray(response)) {
                return response.map((repo: any) => ({
                    name: repo.name,
                    full_name: repo.full_name,
                    html_url: repo.html_url,
                    ssh_url: repo.ssh_url,
                    clone_url: repo.clone_url,
                    private: repo.private
                }));
            }
            return [];
        } catch (e: any) {
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
            'User-Agent': 'VSCode-GitWise',
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
        try {
            const response: any = await this.makeRequest(`https://api.github.com/repos/${owner}/${repo}/branches`, 'GET', null, {
                'Authorization': `Bearer ${token}`,
                'User-Agent': 'VSCode-GitWise',
                'Accept': 'application/vnd.github.v3+json'
            });

            if (Array.isArray(response)) {
                return response.map((branch: any) => branch.name);
            }
            return [];
        } catch (e) {
            return [];
        }
    }

    public async getPullRequests(token: string, owner: string, repo: string): Promise<any[]> {
        const query = `
        query {
            repository(owner: "${owner}", name: "${repo}") {
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
            const response: any = await this.postRequest('https://api.github.com/graphql', JSON.stringify({ query }), {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'User-Agent': 'VSCode-GitWise'
            });
            return response?.data?.repository?.pullRequests?.nodes || [];
        } catch (e) {
            Logger.error("Failed to fetch PRs", e);
            return [];
        }
    }

    public async getCommitStatus(token: string, owner: string, repo: string, branch: string): Promise<string | null> {
        const query = `
        query {
            repository(owner: "${owner}", name: "${repo}") {
                object(expression: "${branch}") {
                    ... on Commit {
                        statusCheckRollup {
                            state
                        }
                    }
                }
            }
        }`;
        try {
            const response: any = await this.postRequest('https://api.github.com/graphql', JSON.stringify({ query }), {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'User-Agent': 'VSCode-GitWise'
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
                'User-Agent': 'VSCode-GitWise',
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
            'User-Agent': 'VSCode-GitWise',
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

    private makeRequest(url: string, method: string, body: any, headers: any = {}): Promise<any> {
        return new Promise((resolve, reject) => {
            const urlObj = new URL(url);
            const options = {
                hostname: urlObj.hostname,
                path: urlObj.pathname + urlObj.search,
                method: method,
                headers: headers,
                timeout: 30000 // 30 second timeout
            };

            Logger.debug('Making HTTP request', { method, url });

            const req = https.request(options, (res: any) => {
                let data = '';
                res.on('data', (chunk: any) => {
                    data += chunk;
                });
                res.on('end', () => {
                    try {
                        if (!data || data.toString().trim() === '') {
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
                        Logger.error('Failed to parse response', e, { data });
                        reject(e);
                    }
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

            if (body) {
                req.write(body.toString());
            }
            req.end();
        });
    }
}
