import { describe, it, expect } from 'vitest';
import { errMsg, formatDuration, resolveStatus } from './utils';

describe('formatDuration', () => {
	it.each([
		[0, '0s'],
		[8000, '8s'],
		[60000, '1m'],
		[341050, '5m 41s'],     // a real sync time
		[3661000, '1h 1m 1s'],
		[5400000, '1h 30m'],    // exact half-hour drops the 0s
		[500, '1s'],            // rounds to nearest second (0.5s → 1s)
	])('%d ms -> %s', (ms, expected) => {
		expect(formatDuration(ms)).toBe(expected);
	});
});

describe('resolveStatus — forward-only, terminal-sticky', () => {
	it('advances forward', () => {
		expect(resolveStatus('applied', 'interview')).toBe('interview');
		expect(resolveStatus('applied', 'rejected')).toBe('rejected');
		expect(resolveStatus('interview', 'offer')).toBe('offer');
		expect(resolveStatus('interview', 'rejected')).toBe('rejected');
	});

	it('never rolls back (a lower-stage email keeps the current stage)', () => {
		expect(resolveStatus('interview', 'applied')).toBe('interview');   // stray "received your application"
		expect(resolveStatus('applied', 'applied')).toBe('applied');
	});

	it('terminal states are final', () => {
		expect(resolveStatus('rejected', 'interview')).toBe('rejected');   // reached_interview tracked separately
		expect(resolveStatus('rejected', 'applied')).toBe('rejected');
		expect(resolveStatus('offer', 'rejected')).toBe('offer');          // an offer never becomes a rejection
	});
});

describe('errMsg', () => {
	it('returns an Error message', () => {
		expect(errMsg(new Error('boom'), 'fallback')).toBe('boom');
	});
	it('returns a string error as-is', () => {
		expect(errMsg('a string error', 'fallback')).toBe('a string error');
	});
	it('falls back for unknown shapes', () => {
		expect(errMsg({ weird: true }, 'fallback')).toBe('fallback');
		expect(errMsg(null, 'fallback')).toBe('fallback');
	});
});
