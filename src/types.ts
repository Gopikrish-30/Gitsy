// Shared types for Gitsy extension

export interface UserProfile {
    login: string;
    name: string;
    email: string;
    avatar: string;
    repos: number;
    contributions: number;
}

export interface RepoStats {
    branch: string;
    remote: string;
    status: string;
    repoName: string;
    repoPath: string;
    lastCommit: string;
    user: UserProfile | null;
    rebaseStatus: string | null;
    mergeStatus: string | null;
    stashList: string[];
    conflicts: string[];
    pullRequests: PullRequest[];
    commitStatus: string | null;
}

export interface PullRequest {
    title: string;
    url: string;
    number: number;
    author: { login: string };
    createdAt: string;
    isDraft: boolean;
    mergeable: string;
    headRefName: string;
    headRepository: { owner: { login: string }; url: string };
}

export interface FileStatus {
    status: string;          // Status code (M, A, D, R, C, U, ??, !!)
    path: string;            // File path
    staged?: boolean;        // Whether change is staged
    conflicted?: boolean;    // Whether file has merge conflicts
    renamed?: {              // Rename information if applicable
        from: string;
        to: string;
    };
}

export interface FastPushPayload {
    repoType: 'existing' | 'new';
    repoUrl: string;
    newRepoName?: string;
    newRepoDesc?: string;
    newRepoPrivate?: boolean;
    branch: string;
    message: string;
}

export interface WebviewMessage {
    type: string;
    value?: any;
    action?: string;
    payload?: any;
}

export interface GitHubRepo {
    name: string;
    full_name: string;
    html_url: string;
    ssh_url: string;
    clone_url: string;
    private: boolean;
}

export interface Settings {
    pat?: string;
}
