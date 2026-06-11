// ── Google OAuth2 ───────────────────────────────────────────────────────────
// Client factory (also used by the message layer), consent URL, code exchange, token revocation.

import { google } from 'googleapis';
import type { Credentials } from 'google-auth-library';

export function getOAuthClient() {
	return new google.auth.OAuth2(
		process.env.GOOGLE_CLIENT_ID,
		process.env.GOOGLE_CLIENT_SECRET,
		process.env.GOOGLE_REDIRECT_URI,
	);
}

export function getAuthUrl(): string {
	const client = getOAuthClient();
	return client.generateAuthUrl({
		access_type: 'offline',
		prompt: 'consent',
		scope: ['https://www.googleapis.com/auth/gmail.readonly'],
	});
}

export async function exchangeCode(code: string): Promise<Credentials> {
	const client = getOAuthClient();
	const { tokens } = await client.getToken(code);
	return tokens;
}

export async function revokeTokens(tokens: Credentials): Promise<void> {
	const client = getOAuthClient();
	client.setCredentials(tokens);
	if (tokens.access_token) {
		await client.revokeToken(tokens.access_token);
	}
}
