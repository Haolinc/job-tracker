import { describe, it, expect } from 'vitest';
import type { Credentials } from 'google-auth-library';
import { applyRefreshedTokens, isReconnectRequiredError } from './messages';

// The session holds the Gmail credentials, so a refresh has to land back in the same object the route
// read them from. The rule worth guarding is the asymmetry: everything else overwrites, the refresh
// token only ever gets replaced by a real one.

const storedTokens = (): Credentials => ({
	access_token: 'old-access-token',
	refresh_token: 'the-only-refresh-token-we-will-ever-get',
	expiry_date: 1000,
});

describe('applyRefreshedTokens', () => {
	it('should take the new access token and expiry while keeping the stored refresh token', () => {
		// Google returns a refresh token only on the first exchange, omitting the key on later refreshes or
		// sending it as undefined. Blanking ours either way would strand the user at the next expiry with
		// nothing to refresh from, forcing a full reconnect.
		const tokens = storedTokens();

		applyRefreshedTokens(tokens, { access_token: 'new-access-token', expiry_date: 2000 });
		applyRefreshedTokens(tokens, { access_token: 'newer-access-token', refresh_token: undefined });

		expect(tokens.access_token).toBe('newer-access-token');
		expect(tokens.expiry_date).toBe(2000);
		expect(tokens.refresh_token).toBe('the-only-refresh-token-we-will-ever-get');
	});

	it('should adopt a rotated refresh token when Google does send one', () => {
		const tokens = storedTokens();

		applyRefreshedTokens(tokens, { access_token: 'new-access-token', refresh_token: 'rotated' });

		expect(tokens.refresh_token).toBe('rotated');
	});
});

// Only dead credentials should force a reconnect. Misreading an ordinary failure would sign the user out
// over a blip; missing a real one leaves them retrying a sync that can never succeed.
describe('isReconnectRequiredError', () => {
	it('should recognise a refresh Google rejected outright', () => {
		// The shape google-auth-library throws from the token endpoint. Its `message` is deliberately not
		// consulted: the library rewrites that field on the ReAuth path, while data.error survives both.
		expect(isReconnectRequiredError({ response: { data: { error: 'invalid_grant' } } })).toBe(true);
	});

	it('should recognise a 401 from Gmail itself', () => {
		// Revoking access while the access token is still inside its hour skips the refresh entirely: the
		// request goes out and Gmail rejects it. Same dead credentials, different shape.
		expect(isReconnectRequiredError({ code: 401, message: 'Invalid Credentials' })).toBe(true);
		expect(isReconnectRequiredError({ response: { status: 401, data: { error: { code: 401 } } } })).toBe(true);
	});

	it('should not mistake a transient failure for dead credentials', () => {
		expect(isReconnectRequiredError({ code: 429, message: 'Too Many Requests' })).toBe(false);
		expect(isReconnectRequiredError({ code: 403, errors: [{ reason: 'rateLimitExceeded' }] })).toBe(false);
		expect(isReconnectRequiredError({ response: { data: { error: 'invalid_request' } } })).toBe(false);
		expect(isReconnectRequiredError(new Error('socket hang up'))).toBe(false);
		expect(isReconnectRequiredError(undefined)).toBe(false);
	});
});
