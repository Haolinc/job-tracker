import { describe, it, expect } from 'vitest';
import type { Credentials } from 'google-auth-library';
import { applyRefreshedTokens } from './messages';

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
