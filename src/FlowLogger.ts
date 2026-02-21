import * as vscode from 'vscode';
import { Logger } from './logger';
import { FlowEntry } from './types';

const MAX_ENTRIES = 150;
const STORAGE_KEY = 'gitsy.flowLog';

export class FlowLogger {
    constructor(private context: vscode.ExtensionContext) { }

    /**
     * Log start of an operation. Returns entry id for later completion.
     */
    public startEntry(
        operation: string,
        details: string,
        branch: string,
        repoName: string,
        preflightStatus?: 'passed' | 'failed' | 'skipped'
    ): string {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const entry: FlowEntry = {
            id,
            operation,
            details,
            status: 'running',
            startTime: Date.now(),
            branch,
            repoName,
            preflightStatus
        };

        const entries = this.getEntries();
        entries.unshift(entry); // newest first
        this.saveEntries(this.prune(entries));
        Logger.debug('Flow entry started', { id, operation });
        return id;
    }

    /**
     * Update entry with final status once the operation completes.
     */
    public completeEntry(
        id: string,
        status: 'success' | 'failed' | 'cancelled',
        error?: string
    ): void {
        const entries = this.getEntries();
        const idx = entries.findIndex(e => e.id === id);
        if (idx === -1) { return; }

        const endTime = Date.now();
        entries[idx] = {
            ...entries[idx],
            status,
            endTime,
            durationMs: endTime - entries[idx].startTime,
            error
        };

        this.saveEntries(entries);
        Logger.debug('Flow entry completed', { id, status, durationMs: entries[idx].durationMs });
    }

    /**
     * Get all entries for this workspace (newest first).
     */
    public getEntries(): FlowEntry[] {
        try {
            const raw = this.context.workspaceState.get<FlowEntry[]>(STORAGE_KEY, []);
            return Array.isArray(raw) ? raw : [];
        } catch {
            return [];
        }
    }

    /**
     * Clear all entries for this workspace.
     */
    public clearEntries(): void {
        this.saveEntries([]);
    }

    private saveEntries(entries: FlowEntry[]): void {
        try {
            this.context.workspaceState.update(STORAGE_KEY, entries);
        } catch (e) {
            Logger.warn('Failed to save flow entries', { error: e });
        }
    }

    private prune(entries: FlowEntry[]): FlowEntry[] {
        return entries.slice(0, MAX_ENTRIES);
    }
}
