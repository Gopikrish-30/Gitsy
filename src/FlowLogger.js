"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FlowLogger = void 0;
const logger_1 = require("./logger");
const MAX_ENTRIES = 150;
const STORAGE_KEY = 'gitsy.flowLog';
class FlowLogger {
    context;
    constructor(context) {
        this.context = context;
    }
    /**
     * Log start of an operation. Returns entry id for later completion.
     */
    startEntry(operation, details, branch, repoName, preflightStatus) {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const entry = {
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
        logger_1.Logger.debug('Flow entry started', { id, operation });
        return id;
    }
    /**
     * Update entry with final status once the operation completes.
     */
    completeEntry(id, status, error) {
        const entries = this.getEntries();
        const idx = entries.findIndex(e => e.id === id);
        if (idx === -1) {
            return;
        }
        const endTime = Date.now();
        entries[idx] = {
            ...entries[idx],
            status,
            endTime,
            durationMs: endTime - entries[idx].startTime,
            error
        };
        this.saveEntries(entries);
        logger_1.Logger.debug('Flow entry completed', { id, status, durationMs: entries[idx].durationMs });
    }
    /**
     * Get all entries for this workspace (newest first).
     */
    getEntries() {
        try {
            const raw = this.context.workspaceState.get(STORAGE_KEY, []);
            return Array.isArray(raw) ? raw : [];
        }
        catch {
            return [];
        }
    }
    /**
     * Clear all entries for this workspace.
     */
    clearEntries() {
        this.saveEntries([]);
    }
    saveEntries(entries) {
        try {
            this.context.workspaceState.update(STORAGE_KEY, entries);
        }
        catch (e) {
            logger_1.Logger.warn('Failed to save flow entries', { error: e });
        }
    }
    prune(entries) {
        return entries.slice(0, MAX_ENTRIES);
    }
}
exports.FlowLogger = FlowLogger;
//# sourceMappingURL=FlowLogger.js.map