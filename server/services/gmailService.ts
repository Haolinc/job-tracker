import { google } from 'googleapis';
import type { Credentials } from 'google-auth-library';
import type { EmailResult } from '../types';

function getOAuthClient() {
	return new google.auth.OAuth2(
		process.env.GOOGLE_CLIENT_ID,
		process.env.GOOGLE_CLIENT_SECRET,
		process.env.GOOGLE_REDIRECT_URI,
	);
}

function getAuthUrl(): string {
	const client = getOAuthClient();
	return client.generateAuthUrl({
		access_type: 'offline',
		prompt: 'consent',
		scope: ['https://www.googleapis.com/auth/gmail.readonly'],
	});
}

async function exchangeCode(code: string): Promise<Credentials> {
	const client = getOAuthClient();
	const { tokens } = await client.getToken(code);
	return tokens;
}

async function fetchJobEmails(tokens: Credentials): Promise<EmailResult[]> {
	const client = getOAuthClient();
	client.setCredentials(tokens);

	const gmail = google.gmail({ version: 'v1', auth: client });
	const days = process.env.GMAIL_SCAN_DAYS || 30;

	const query = [
		'(subject:application OR subject:interview OR subject:offer OR subject:position OR subject:opportunity)',
		`newer_than:${days}d`,
		'-category:promotions',
		'-category:social',
	].join(' ');

	const listRes = await gmail.users.threads.list({ userId: 'me', q: query, maxResults: 100 });
	const threads = listRes.data.threads || [];

	const results = await Promise.all(
		threads.map(async (t) => {
			const thread = await gmail.users.threads.get({
				userId: 'me',
				id: t.id!,
				format: 'metadata',
				metadataHeaders: ['Subject', 'From'],
			});
			const messages = thread.data.messages!;
			const msg = messages[0];
			const headers = msg.payload?.headers || [];
			const subject = headers.find(h => h.name === 'Subject')?.value || '';
			const snippet = messages[messages.length - 1].snippet || '';
			return { threadId: t.id!, messageId: msg.id!, subject, snippet };
		})
	);

	return results;
}

async function revokeTokens(tokens: Credentials): Promise<void> {
	const client = getOAuthClient();
	client.setCredentials(tokens);
	if (tokens.access_token) {
		await client.revokeToken(tokens.access_token);
	}
}

export { getAuthUrl, exchangeCode, fetchJobEmails, revokeTokens };
