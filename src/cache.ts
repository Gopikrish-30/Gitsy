// Simple cache implementation with TTL support

export class Cache<T> {
    private cache = new Map<string, { value: T; timestamp: number }>();
    private defaultTTL: number;

    constructor(defaultTTLSeconds: number = 60) {
        this.defaultTTL = defaultTTLSeconds * 1000;
    }

    public set(key: string, value: T, ttlSeconds?: number): void {
        const ttl = ttlSeconds ? ttlSeconds * 1000 : this.defaultTTL;
        this.cache.set(key, {
            value,
            timestamp: Date.now() + ttl
        });
    }

    public get(key: string): T | undefined {
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

    public has(key: string): boolean {
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

    public invalidate(key: string): void {
        this.cache.delete(key);
    }

    public clear(): void {
        this.cache.clear();
    }

    public getOrSet(key: string, factory: () => T | Promise<T>, ttlSeconds?: number): T | Promise<T> {
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
        } else {
            this.set(key, value, ttlSeconds);
            return value;
        }
    }
}
