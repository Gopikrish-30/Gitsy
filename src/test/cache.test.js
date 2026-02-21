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
const assert = __importStar(require("assert"));
const cache_1 = require("../cache");
suite('Cache Test Suite', () => {
    test('Cache stores and retrieves values', () => {
        const cache = new cache_1.Cache(60);
        cache.set('key1', 'value1');
        assert.strictEqual(cache.get('key1'), 'value1');
    });
    test('Cache respects TTL', (done) => {
        const cache = new cache_1.Cache(1); // 1 second TTL
        cache.set('key1', 'value1');
        assert.strictEqual(cache.get('key1'), 'value1');
        setTimeout(() => {
            assert.strictEqual(cache.get('key1'), undefined);
            done();
        }, 1500);
    });
    test('Cache has() method works', () => {
        const cache = new cache_1.Cache(60);
        cache.set('key1', 'value1');
        assert.strictEqual(cache.has('key1'), true);
        assert.strictEqual(cache.has('key2'), false);
    });
    test('Cache clear() removes all entries', () => {
        const cache = new cache_1.Cache(60);
        cache.set('key1', 'value1');
        cache.set('key2', 'value2');
        cache.clear();
        assert.strictEqual(cache.has('key1'), false);
        assert.strictEqual(cache.has('key2'), false);
    });
    test('Cache getOrSet() works with sync factory', () => {
        const cache = new cache_1.Cache(60);
        const value = cache.getOrSet('key1', () => 'factory-value');
        assert.strictEqual(value, 'factory-value');
        assert.strictEqual(cache.get('key1'), 'factory-value');
    });
    test('Cache getOrSet() returns cached value', () => {
        const cache = new cache_1.Cache(60);
        cache.set('key1', 'cached-value');
        const value = cache.getOrSet('key1', () => 'factory-value');
        assert.strictEqual(value, 'cached-value');
    });
});
//# sourceMappingURL=cache.test.js.map