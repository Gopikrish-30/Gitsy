"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseGitHubUrl = parseGitHubUrl;
/**
 * Parse a GitHub remote URL (HTTPS or SSH) into owner and repo.
 * Supports:
 *   - https://github.com/owner/repo.git
 *   - git@github.com:owner/repo.git
 */
function parseGitHubUrl(url) {
    let owner = '';
    let repo = '';
    if (url.startsWith('http')) {
        const parts = url.split('/');
        owner = parts[parts.length - 2] || '';
        repo = (parts[parts.length - 1] || '').replace('.git', '');
    }
    else if (url.startsWith('git@')) {
        const parts = url.split(':');
        const path = parts[1] || '';
        const pathParts = path.split('/');
        owner = pathParts[0] || '';
        repo = (pathParts[1] || '').replace('.git', '');
    }
    return { owner, repo };
}
//# sourceMappingURL=utils.js.map