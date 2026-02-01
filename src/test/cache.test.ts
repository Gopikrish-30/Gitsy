import * as assert from 'assert';
import { Cache } from '../cache';

suite('Cache Test Suite', () => {
	test('Cache stores and retrieves values', () => {
		const cache = new Cache<string>(60);
		cache.set('key1', 'value1');
		assert.strictEqual(cache.get('key1'), 'value1');
	});

	test('Cache respects TTL', (done) => {
		const cache = new Cache<string>(1); // 1 second TTL
		cache.set('key1', 'value1');
		assert.strictEqual(cache.get('key1'), 'value1');
		
		setTimeout(() => {
			assert.strictEqual(cache.get('key1'), undefined);
			done();
		}, 1500);
	});

	test('Cache has() method works', () => {
		const cache = new Cache<string>(60);
		cache.set('key1', 'value1');
		assert.strictEqual(cache.has('key1'), true);
		assert.strictEqual(cache.has('key2'), false);
	});

	test('Cache clear() removes all entries', () => {
		const cache = new Cache<string>(60);
		cache.set('key1', 'value1');
		cache.set('key2', 'value2');
		cache.clear();
		assert.strictEqual(cache.has('key1'), false);
		assert.strictEqual(cache.has('key2'), false);
	});

	test('Cache getOrSet() works with sync factory', () => {
		const cache = new Cache<string>(60);
		const value = cache.getOrSet('key1', () => 'factory-value');
		assert.strictEqual(value, 'factory-value');
		assert.strictEqual(cache.get('key1'), 'factory-value');
	});

	test('Cache getOrSet() returns cached value', () => {
		const cache = new Cache<string>(60);
		cache.set('key1', 'cached-value');
		const value = cache.getOrSet('key1', () => 'factory-value');
		assert.strictEqual(value, 'cached-value');
	});
});
