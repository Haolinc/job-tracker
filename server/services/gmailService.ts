import { google } from 'googleapis';
import type { gmail_v1 } from 'googleapis';
import type { Credentials } from 'google-auth-library';
import type { EmailResult } from '../types';

const BODY_LIMIT = 800;
const BATCH_SIZE = 10;

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

// ── Body extraction helpers ───────────────────────────────────────────────────

/** Recursively find the first part matching a given MIME type. */
function findPart(
	part: gmail_v1.Schema$MessagePart | undefined,
	mimeType: string,
): gmail_v1.Schema$MessagePart | null {
	if (!part) return null;
	if (part.mimeType === mimeType && part.body?.data) return part;
	for (const child of part.parts ?? []) {
		const found = findPart(child, mimeType);
		if (found) return found;
	}
	return null;
}

function decodePart(part: gmail_v1.Schema$MessagePart): string {
	return Buffer.from(part.body!.data!, 'base64url').toString('utf-8');
}

function stripHtml(html: string): string {
	return html
		.replace(/<style[\s\S]*?<\/style>/gi, '')
		.replace(/<script[\s\S]*?<\/script>/gi, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/** Prefers text/plain; falls back to stripped text/html. */
function extractBody(part: gmail_v1.Schema$MessagePart | undefined): string {
	const plain = findPart(part, 'text/plain');
	if (plain) return decodePart(plain);
	const html = findPart(part, 'text/html');
	return html ? stripHtml(decodePart(html)) : '';
}

/**
 * Extracts and strips the HTML part only, ignoring text/plain.
 * Used for Indeed confirmation emails where the company is only in the HTML.
 */
function extractHtmlBody(part: gmail_v1.Schema$MessagePart | undefined): string {
	const html = findPart(part, 'text/html');
	return html ? stripHtml(decodePart(html)) : '';
}

// ── Thread processing ─────────────────────────────────────────────────────────

/**
 * Build the body string passed to the classifier.
 *
 * Indeed forwarding emails have no company info in their plain-text part
 * ("Your application has been submitted. Good luck!"). The HTML part contains
 * "The following items were sent to [Company]. Good luck!" — extract that phrase
 * and prepend it so the classifier immediately sees the employer name.
 */
function buildBody(msg: gmail_v1.Schema$Message, from: string): string {
	const part    = msg.payload ?? undefined;
	const rawBody = extractBody(part);

	if (!from.includes('indeedapply@indeed.com')) {
		return rawBody.slice(0, BODY_LIMIT);
	}

	const richBody = extractHtmlBody(part) || rawBody;
	const sentTo   = richBody.match(/sent to ([^.]+)\./i);
	const prefix   = sentTo ? `Employer: ${sentTo[1].trim()}\n\n` : '';
	return prefix + richBody.slice(0, prefix ? 1000 : 3000);
}

/**
 * Returns one EmailResult per message in the thread so that multiple
 * application confirmations stacked into the same Gmail thread (e.g. two
 * City-of-New-York roles) are each classified independently.
 *
 * Subject and From are taken from the first message (thread-level metadata);
 * body and date come from each individual message.
 */
async function fetchThread(
	gmail: gmail_v1.Gmail,
	threadId: string,
): Promise<EmailResult[]> {
	const thread   = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' });
	const messages = thread.data.messages;
	if (!messages?.length) return [];

	// Subject / From are thread-level — use first message's headers.
	const firstMsg = messages[0];
	const headers  = firstMsg.payload?.headers ?? [];
	const subject  = headers.find(h => h.name === 'Subject')?.value ?? '';
	const from     = headers.find(h => h.name === 'From')?.value    ?? '';

	return messages.map(msg => ({
		threadId,
		messageId:       msg.id!,
		subject,
		from,
		body:            buildBody(msg, from),
		lastMessageDate: msg.internalDate
			? new Date(parseInt(msg.internalDate)).toISOString().split('T')[0]
			: new Date().toISOString().split('T')[0],
	}));
}

// ── Public API ────────────────────────────────────────────────────────────────

async function fetchJobEmails(tokens: Credentials): Promise<EmailResult[]> {
	const client = getOAuthClient();
	client.setCredentials(tokens);

	const gmail = google.gmail({ version: 'v1', auth: client });
	const days  = parseInt(process.env.GMAIL_SCAN_DAYS ?? '30', 10);

	// Positive OR group: restrict results to threads that contain at least one
	// job-related phrase. Without this, unrelated mail fills the quota and pushes
	// real application emails past the maxResults cutoff.
	const keywordFilter = `{${[
		'"your application"',
		'"recent application"',       // iCIMS ATS: "your recent application" — "your application" alone won't match
		'"thank you for applying"',
		'"thanks for applying"',
		'"application received"',
		'"application submitted"',
		'"application update"',
		'"application status"',       // e.g. "Follow your application status"
		'"job application"',          // e.g. "Your recent job application for..."
		'"indeed application"',
		'"career opportunities"',     // Workday applied: "interest in career opportunities at"
		'"your candidacy"',           // rejection language
		'"hiring process"',
		'"hiring team"',
		'"your interview"',
		'"interview request"',
		'"interview invitation"',
		// NOTE: "recruiter", "next steps", "unfortunately", "no longer", "compensation"
		// intentionally omitted — too broad, attract newsletters/digests/financial emails.
		// Legitimate emails using those words also contain tighter phrases above.
		'"moving forward with other"',// rejection phrase variant
		'"not be moving forward"',
		'"start date"',
		'"welcome aboard"',
		'"job offer"',
		'"offer letter"',
	].join(' ')}}`;

	const query = [
		`newer_than:${days}d`,
		'-category:promotions',
		'-category:social',
		// LinkedIn recommendation emails — cause false-positive "applied" entries.
		'-subject:"you may be a fit for"',
		'-subject:"new jobs similar to"',
		'-"jobs you\'re a good match for"',
		// Glassdoor post-application feedback surveys — match OR via "your application"
		// but are never application confirmations. Runtime backstop in AUTOMATED_SUBJECT too.
		'-subject:"quick question about your application at"',
		'-subject:"we\'d love to hear about your application experience"',
		// LinkedIn social post / reaction notifications — user-generated post content can contain
		// any job keyword, making OR filtering impossible. Gmail routes these to "Updates", not
		// "Social", so -category:social doesn't catch them.
		'-from:updates-noreply@linkedin.com',
		// Glassdoor "Apply Now / Apply Soon / is still available" job alert emails.
		// 16 hits confirmed in 60-day audit.
		'-subject:"Apply Now"',
		'-"Apply Soon"',
		'-subject:"is still available"',
		// EAP / HR benefit discount emails — match OR via "application received".
		'-"EAP Discount Rate"',
		// iCIMS "draft started" trigger — fires when applicant BEGINS but does NOT submit.
		// "You've started your job application!" is iCIMS-specific; never a real confirmation.
		'-subject:"you\'ve started your job application"',
		// Draft application reminder emails — ATS prompts to complete an unfinished application.
		// "Continue to apply for the job..." is always about a draft, never a submitted app.
		'-subject:"continue to apply"',
		keywordFilter,
	].join(' ');

	const listRes = await gmail.users.threads.list({ userId: 'me', q: query, maxResults: 1000 });
	const threads = listRes.data.threads ?? [];
	const results: EmailResult[] = [];

	for (let i = 0; i < threads.length; i += BATCH_SIZE) {
		const batch        = threads.slice(i, i + BATCH_SIZE);
		const batchResults = await Promise.all(batch.map(t => fetchThread(gmail, t.id!)));
		results.push(...batchResults.flat());
	}

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
