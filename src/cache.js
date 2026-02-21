"use strict";
// Simple cache implementation with TTL support
Object.defineProperty(exports, "__esModule", { value: true });
exports.Cache = void 0;
class Cache {
    cache = new Map();
    defaultTTL;
    constructor(defaultTTLSeconds = 60) {
        this.defaultTTL = defaultTTLSeconds * 1000;
    }
    set(key, value, ttlSeconds) {
        const ttl = ttlSeconds ? ttlSeconds * 1000 : this.defaultTTL;
        this.cache.set(key, {
            value,
            timestamp: Date.now() + ttl
        });
    }
    get(key) {
        const entry = this.cache.get(key);
        if (!entry) {
            return undefined;
        }
        if (Date.now() > entry.timestamp) {
            this.cache.delete(key);
            return undefined;
        }
        return entry.value;
    }
    has(key) {
        const entry = this.cache.get(key);
        if (!entry) {
            return false;
        }
        if (Date.now() > entry.timestamp) {
            this.cache.delete(key);
            return false;
        }
        return true;
    }
    invalidate(key) {
        this.cache.delete(key);
    }
    clear() {
        this.cache.clear();
    }
    getOrSet(key, factory, ttlSeconds) {
        const cached = this.get(key);
        if (cached !== undefined) {
            return cached;
        }
        const value = factory();
        if (value instanceof Promise) {
            return value.then(resolved => {
                this.set(key, resolved, ttlSeconds);
                return resolved;
            });
        }
        else {
            this.set(key, value, ttlSeconds);
            return value;
        }
    }
}
exports.Cache = Cache;
//# sourceMappingURL=cache.js.map