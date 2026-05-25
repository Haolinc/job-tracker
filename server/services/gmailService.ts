import { google } from 'googleapis';
import type { gmail_v1 } from 'googleapis';
import type { Credentials } from 'google-auth-library';
import type { EmailResult } from '../types';

const BODY_LIMIT = 2000;

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

// Recursively extract plain-text body from a message part.
// Prefers text/plain; falls back to stripped text/html.
function extractBody(part: gmail_v1.Schema$MessagePart | undefined): string {
	if (!part) return '';

	if (part.mimeType === 'text/plain' && part.body?.data) {
		return Buffer.from(part.body.data, 'base64url').toString('utf-8');
	}

	if (part.parts) {
		// Prefer plain text first
		for (const p of part.parts) {
			if (p.mimeType === 'text/plain' && p.body?.data) {
				return Buffer.from(p.body.data, 'base64url').toString('utf-8');
			}
		}
		// Recurse into nested multipart
		for (const p of part.parts) {
			const text = extractBody(p);
			if (text) return text;
		}
	}

	// Last resort: strip HTML — remove style/script blocks first, then tags
	if (part.mimeType === 'text/html' && part.body?.data) {
		const html = Buffer.from(part.body.data, 'base64url').toString('utf-8');
		return html
			.replace(/<style[\s\S]*?<\/style>/gi, '')
			.replace(/<script[\s\S]*?<\/script>/gi, '')
			.replace(/<[^>]+>/g, ' ')
			.replace(/\s+/g, ' ')
			.trim();
	}

	return '';
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
				format: 'full',
			});
			const messages = thread.data.messages!;
			const msg     = messages[0];
			const lastMsg = messages[messages.length - 1];
			const headers = msg.payload?.headers || [];
			const subject = headers.find(h => h.name === 'Subject')?.value || '';
			const from    = headers.find(h => h.name === 'From')?.value    || '';
			const rawBody = extractBody(msg.payload ?? undefined);
			const body    = rawBody.slice(0, BODY_LIMIT);
			const lastMessageDate = lastMsg.internalDate
				? new Date(parseInt(lastMsg.internalDate)).toISOString().split('T')[0]
				: new Date().toISOString().split('T')[0];
			return { threadId: t.id!, messageId: msg.id!, subject, from, body, lastMessageDate };
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
