import { describe, it, expect } from 'vitest';
import { formatDuration } from './formatDuration';

describe('formatDuration', () => {
	it.each([
		[0, '0s'],
		[8000, '8s'],
		[60000, '1m'],
		[341050, '5m 41s'],
		[3661000, '1h 1m 1s'],
		[5400000, '1h 30m'],
		[500, '1s'],
	])('%d ms -> %s', (ms, expected) => {
		expect(formatDuration(ms)).toBe(expected);
	});
});
