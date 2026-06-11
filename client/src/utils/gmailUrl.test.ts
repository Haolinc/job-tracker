import { describe, it, expect } from 'vitest';
import { gmailUrl } from './gmailUrl';

describe('gmailUrl', () => {
	it('should fall back to the u/0 mailbox when no account is given', () => {
		expect(gmailUrl('18f2a9c0bd1e')).toBe('https://mail.google.com/mail/u/0/#all/18f2a9c0bd1e');
		expect(gmailUrl('18f2a9c0bd1e', null)).toBe('https://mail.google.com/mail/u/0/#all/18f2a9c0bd1e');
	});

	it('should disambiguate the account via the authuser query param so a non-primary mailbox opens', () => {
		expect(gmailUrl('18f2a9c0bd1e', 'me@work.com'))
			.toBe('https://mail.google.com/mail/u/0/?authuser=me%40work.com#all/18f2a9c0bd1e');
	});

	it('should URL-encode both the account and ids that contain reserved characters', () => {
		expect(gmailUrl('a/b c#d')).toBe('https://mail.google.com/mail/u/0/#all/a%2Fb%20c%23d');
		expect(gmailUrl('a/b c#d', 'a+b@x.com'))
			.toBe('https://mail.google.com/mail/u/0/?authuser=a%2Bb%40x.com#all/a%2Fb%20c%23d');
	});
});
