import { describe, it, expect } from 'vitest';
import { serializeEmails, parseEmails, extractMessageId } from './emailRefs';
import type { EmailRef } from '../types';

const refs: EmailRef[] = [
	{ messageId: 'm-app', category: 'applied',   date: '2026-02-01' },
	{ messageId: 'm-rej', category: 'rejected',  date: '2026-04-02' },
];

describe('serializeEmails / parseEmails', () => {
	it('should round-trip a list of email refs through the CSV cell encoding', () => {
		expect(parseEmails(serializeEmails(refs))).toEqual(refs);
	});

	it('should serialize as category|messageId|date entries joined by " ; "', () => {
		expect(serializeEmails(refs)).toBe('applied|m-app|2026-02-01 ; rejected|m-rej|2026-04-02');
	});

	it('should ignore a trailing account field from a legacy 4-column export', () => {
		expect(parseEmails('applied|m1|2026-02-01|me@work.com')).toEqual([
			{ messageId: 'm1', category: 'applied', date: '2026-02-01' },
		]);
	});

	it('should round-trip the fast-apply flag via a 4th "fast" field', () => {
		const withFast: EmailRef[] = [
			{ messageId: 'm-fast', category: 'applied',  date: '2026-02-01', fast_apply: true },
			{ messageId: 'm-rej',  category: 'rejected', date: '2026-04-02' },
		];
		expect(serializeEmails(withFast)).toBe('applied|m-fast|2026-02-01|fast ; rejected|m-rej|2026-04-02');
		expect(parseEmails(serializeEmails(withFast))).toEqual(withFast);
	});

	it('should drop malformed entries (missing id or unknown stage) and an empty cell', () => {
		expect(parseEmails('')).toEqual([]);
		expect(parseEmails('applied||2026-01-01')).toEqual([]);        // no messageId
		expect(parseEmails('bogus|m1|2026-01-01')).toEqual([]);        // unknown category
		expect(parseEmails('applied|m1|2026-01-01 ; junk')).toEqual([  // keep the good one, drop junk
			{ messageId: 'm1', category: 'applied', date: '2026-01-01' },
		]);
	});
});

describe('extractMessageId', () => {
	it.each([
		['https://mail.google.com/mail/u/0/#all/18f2a9c0bd1e', '18f2a9c0bd1e'],
		['https://mail.google.com/mail/u/0/?authuser=me@x.com#inbox/ABC-123_x', 'ABC-123_x'],
		['https://mail.google.com/mail/u/0/#search/from%3Aacme/FMfcgxyz', 'FMfcgxyz'],
		['18f2a9c0bd1e', '18f2a9c0bd1e'],   // bare id
	])('should pull the message id from %j', (input, expected) => {
		expect(extractMessageId(input)).toBe(expected);
	});

	it.each(['', '   ', 'not a link with spaces', 'https://example.com/no-hash'])(
		'should return null when nothing id-like is present: %j', (input) => {
			expect(extractMessageId(input)).toBeNull();
		});
});
