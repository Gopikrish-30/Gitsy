import * as assert from 'assert';
import { Logger } from '../logger';

suite('Logger Test Suite', () => {
	test('Logger initializes without errors', () => {
		assert.doesNotThrow(() => {
			Logger.initialize();
		});
	});

	test('Logger methods do not throw', () => {
		Logger.initialize();
		assert.doesNotThrow(() => {
			Logger.info('Test info message');
			Logger.warn('Test warn message');
			Logger.error('Test error message', new Error('Test error'));
			Logger.debug('Test debug message');
		});
	});
});
