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
exports.AuthService = void 0;
const https = __importStar(require("https"));
const logger_1 = require("./logger");
/**
 * Simple serial request queue — runs one request at a time to prevent
 * TLS handshake failures from too many simultaneous connections.
 */
class RequestQueue {
    queue = [];
    running = 0;
    maxConcurrent = 2; // max 2 simultaneous connections
    enqueue(fn) {
        return new Promise((resolve, reject) => {
            this.queue.push({ run: fn, resolve, reject });
            this.drain();
        });
    }
    async drain() {
        while (this.running < this.maxConcurrent && this.queue.length > 0) {
            const item = this.queue.shift();
            this.running++;
            try {
                const result = await item.run();
                item.resolve(result);
            }
            catch (e) {
                item.reject(e);
            }
            finally {
                this.running--;
                this.drain(); // process next
            }
        }
    }
}
// Single shared queue for all GitHub API requests
const requestQueue = new RequestQueue();
class AuthService {
    context;
    constructor(context) {
        this.context = context;
        logger_1.Logger.debug('AuthService initialized', { contextAvailable: !!context });
    }
    async getUserProfile(token) {
        logger_1.Logger.debug('Fetching user profile via REST');
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
                        const primary = emails.find((e) => e.primary);
                        if (primary) {
                            email = primary.email;
                        }
                    }
                }
                catch {
                    logger_1.Logger.debug('Could not fetch email (non-critical)');
                }
            }
            // 3. Contributions (optional, sequential)
            let contributions = 0;
            try {
                const contribQuery = `query { viewer { contributionsCollection { contributionCalendar { totalContributions } } } }`;
                const gqlResponse = await this.postRequest('https://api.github.com/graphql', JSON.stringify({ query: contribQuery }), {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'User-Agent': 'VSCode-Gitsy',
                    'Accept': 'application/json'
                });
                contributions = gqlResponse?.data?.viewer?.contributionsCollection?.contributionCalendar?.totalContributions || 0;
            }
            catch {
                logger_1.Logger.debug('Could not fetch contributions (non-critical)');
            }
            const profile = {
                login: user.login,
                name: user.name || user.login,
                email: email || 'No public email',
                avatarUrl: user.avatar_url || '',
                repositories: { totalCount: user.public_repos || 0 },
                contributionsCollection: { contributionCalendar: { totalContributions: contributions } }
            };
            logger_1.Logger.info('User profile fetched successfully', { login: profile.login });
            return profile;
        }
        catch (e) {
            logger_1.Logger.error('Failed to fetch user profile', e);
            throw new Error(`Failed to fetch user profile: ${e.message}`);
        }
    }
    async getUserRepos(token) {
        // Fetch ALL user's repositories with pagination
        const allRepos = [];
        let page = 1;
        const perPage = 100;
        const maxPages = 10; // Safety limit: 1000 repos max
        try {
            while (page <= maxPages) {
                const url = `https://api.github.com/user/repos?per_page=${perPage}&sort=updated&type=owner&page=${page}`;
                const response = await this.makeRequest(url, 'GET', null, {
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
            logger_1.Logger.info(`Fetched ${allRepos.length} repos across ${page} page(s)`);
            return allRepos.map((repo) => ({
                name: repo.name,
                full_name: repo.full_name,
                html_url: repo.html_url,
                ssh_url: repo.ssh_url,
                clone_url: repo.clone_url,
                private: repo.private
            }));
        }
        catch (e) {
            logger_1.Logger.error('Failed to fetch repos', e);
            throw new Error(`Failed to fetch repos: ${e.message}`);
        }
    }
    async createRepo(token, name, isPrivate, description) {
        const body = JSON.stringify({
            name: name,
            private: isPrivate,
            description: description,
            auto_init: false
        });
        const response = await this.postRequest('https://api.github.com/user/repos', body, {
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
    async getRepoBranches(token, owner, repo) {
        // Fetch ALL branches with pagination
        const allBranches = [];
        let page = 1;
        const perPage = 100;
        try {
            while (page <= 5) {
                const url = `https://api.github.com/repos/${owner}/${repo}/branches?per_page=${perPage}&page=${page}`;
                const response = await this.makeRequest(url, 'GET', null, {
                    'Authorization': `Bearer ${token}`,
                    'User-Agent': 'VSCode-Gitsy',
                    'Accept': 'application/vnd.github.v3+json'
                });
                if (!Array.isArray(response) || response.length === 0) {
                    break;
                }
                allBranches.push(...response.map((branch) => branch.name));
                if (response.length < perPage) {
                    break;
                }
                page++;
            }
            return allBranches;
        }
        catch (e) {
            logger_1.Logger.warn('Failed to fetch branches from GitHub API', { error: e, owner, repo });
            return [];
        }
    }
    async getPullRequests(token, owner, repo) {
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
            const response = await this.postRequest('https://api.github.com/graphql', JSON.stringify({ query, variables: { owner, repo } }), {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'User-Agent': 'VSCode-Gitsy'
            });
            return response?.data?.repository?.pullRequests?.nodes || [];
        }
        catch (e) {
            logger_1.Logger.error("Failed to fetch PRs", e);
            return [];
        }
    }
    async getCommitStatus(token, owner, repo, branch) {
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
            const response = await this.postRequest('https://api.github.com/graphql', JSON.stringify({ query, variables: { owner, repo, branch } }), {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'User-Agent': 'VSCode-Gitsy'
            });
            return response?.data?.repository?.object?.statusCheckRollup?.state || null;
        }
        catch (e) {
            return null;
        }
    }
    async deleteRepoBranch(token, owner, repo, branch) {
        const url = `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`;
        try {
            await this.makeRequest(url, 'DELETE', null, {
                'Authorization': `Bearer ${token}`,
                'User-Agent': 'VSCode-Gitsy',
                'Accept': 'application/vnd.github.v3+json'
            });
            return true;
        }
        catch (e) {
            throw new Error(e.message || 'Failed to delete branch via API');
        }
    }
    async mergePullRequest(token, owner, repo, prNumber, method) {
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
        }
        else {
            throw new Error(response.message || 'Merge failed');
        }
    }
    postRequest(url, body, headers = {}) {
        return this.makeRequest(url, 'POST', body, headers);
    }
    /**
     * Make an HTTP request through the serial queue with retry logic.
     * The queue ensures at most 2 concurrent requests to prevent TLS flooding.
     */
    async makeRequest(url, method, body, headers = {}, retries = 3) {
        return requestQueue.enqueue(() => this._makeRequestWithRetry(url, method, body, headers, retries));
    }
    async _makeRequestWithRetry(url, method, body, headers, retries) {
        let lastError = null;
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const result = await this._doRequest(url, method, body, { ...headers });
                return result;
            }
            catch (e) {
                lastError = e;
                const isRetryable = /ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|socket hang up|TLS|disconnected/i.test(e.message);
                if (isRetryable && attempt < retries) {
                    const delay = attempt * 1500; // 1.5s, 3s backoff
                    logger_1.Logger.warn(`Request failed (attempt ${attempt}/${retries}), retrying in ${delay}ms`, { url, error: e.message });
                    await new Promise(r => setTimeout(r, delay));
                }
                else {
                    break;
                }
            }
        }
        throw lastError || new Error('Request failed');
    }
    _doRequest(url, method, body, headers) {
        return new Promise((resolve, reject) => {
            const urlObj = new URL(url);
            let bodyStr;
            if (body) {
                bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
                headers['Content-Length'] = Buffer.byteLength(bodyStr, 'utf8').toString();
            }
            // Create a fresh agent per request — no persistent sockets that can go stale
            const options = {
                hostname: urlObj.hostname,
                path: urlObj.pathname + urlObj.search,
                method: method,
                headers: headers,
                timeout: 30000
            };
            logger_1.Logger.debug('Making HTTP request', { method, url });
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
                            logger_1.Logger.error('HTTP request failed', null, { statusCode: res.statusCode, response: parsed });
                            reject(new Error(parsed.message || `HTTP ${res.statusCode}`));
                            return;
                        }
                        resolve(parsed);
                    }
                    catch (e) {
                        logger_1.Logger.error('Failed to parse response', e, { data: data.substring(0, 200) });
                        reject(e);
                    }
                });
                res.on('error', (e) => {
                    reject(e);
                });
            });
            req.on('timeout', () => {
                req.destroy();
                logger_1.Logger.error('HTTP request timed out', null, { url, method });
                reject(new Error('Request timed out'));
            });
            req.on('error', (e) => {
                logger_1.Logger.error('HTTP request error', e, { url, method });
                reject(e);
            });
            if (bodyStr) {
                req.write(bodyStr);
            }
            req.end();
        });
    }
}
exports.AuthService = AuthService;
//# sourceMappingURL=authService.js.map