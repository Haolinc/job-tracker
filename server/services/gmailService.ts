import { google } from 'googleapis';
import type { gmail_v1 } from 'googleapis';
import type { Credentials } from 'google-auth-library';
import type { EmailResult } from '../types';

const BODY_LIMIT = 800;
const BATCH_SIZE = 10;
// Minimum spacing between batch *starts* (not a flat post-batch sleep). messages.get costs 20
// quota units; at 10 per 450ms (~22/sec) we stay well within the per-user/minute ceiling, with
// the exponential backoff as a backstop for spikes. Measuring from the batch start means a slow
// batch consumes the interval itself, so we don't sleep on top of it — we run at the ceiling.
const MIN_BATCH_INTERVAL_MS = 450;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** True for Gmail rate-limit responses (403 rateLimitExceeded / 429) — which gaxios does NOT auto-retry. */
function isRateLimitError(err: unknown): boolean {
	const e = err as { code?: number; status?: number; errors?: { reason?: string }[]; response?: { status?: number; data?: { error?: { errors?: { reason?: string }[] } } } };
	const code = e?.code ?? e?.status ?? e?.response?.status;
	const reason = e?.errors?.[0]?.reason ?? e?.response?.data?.error?.errors?.[0]?.reason ?? '';
	return code === 429 || (code === 403 && /rate.?limit|userRateLimitExceeded/i.test(reason));
}

/** Retry a Gmail call with exponential backoff when rate-limited. */
async function withRateLimitRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
	let delay = 1000;
	for (let attempt = 0; ; attempt++) {
		try {
			return await fn();
		} catch (err) {
			if (!isRateLimitError(err) || attempt >= 6) throw err;
			console.warn(`[sync] rate limited on ${label}; backing off ${delay}ms (attempt ${attempt + 1})`);
			await sleep(delay);
			delay = Math.min(delay * 2, 30_000);
		}
	}
}

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

// Signals that mark the start of boilerplate footers.
// Everything from the first match onward is discarded.
const FOOTER_RE = /please do not reply to this (email|message)|this is an auto(?:matically)? generated email|this message was sent to \S+@\S+|if you (don.t|no longer) want to receive|references\s+visible links|copyright \(c\) \d{4}|\ball rights reserved\b|this email was intended for \S+@\S+|sorry, replies to this message can.t be delivered|connect with .{1,40} on linkedin|facebook \| twitter|instagram \| linkedin|\*{10,}/i;

/**
 * Strip noise from a decoded email body before sending it to the classifier.
 *
 * Steps (in order):
 *  1. Re-run stripHtml if the "plain" part contains raw HTML markup (malformed emails).
 *  2. Decode residual HTML entities (&nbsp; &amp; &rsquo; &zwnj; …).
 *  3. Remove Unicode invisible / zero-width characters used as email spacers.
 *  4. Remove known artifact prefixes ("RTF Template", leading "96 ").
 *  5. Remove [N] link-reference numbers left by plain-text renderers.
 *  6. Remove all URLs — never needed for company/role/category extraction.
 *  7. Truncate at the first footer signal (unsubscribe notices, copyright, social links).
 *  8. Collapse whitespace.
 */
function cleanBody(raw: string): string {
	let text = raw;

	// 1. Re-strip if plain-text part contains raw HTML (e.g. Precision Neuroscience).
	if (/<[a-z][\s\S]*?>/i.test(text)) text = stripHtml(text);

	// 2. HTML entities.
	text = text
		.replace(/&nbsp;/gi,   ' ')
		.replace(/&amp;/gi,    '&')
		.replace(/&lt;/gi,     '<')
		.replace(/&gt;/gi,     '>')
		.replace(/&#39;/gi,    "'")
		.replace(/&rsquo;/gi,  "'")
		.replace(/&lsquo;/gi,  "'")
		.replace(/&rdquo;/gi,  '"')
		.replace(/&ldquo;/gi,  '"')
		.replace(/&hellip;/gi, '...')
		.replace(/&zwnj;/gi,   '')
		.replace(/&#\d+;/g,    ' ');

	// 3. Unicode invisible / zero-width characters (email tracking spacers).
	// Covers: ZWSP, ZWNJ, ZWJ, LRM, RLM, LSEP, PSEP, SHY, BOM, NBSP.
	text = text.replace(/[\u00A0\u00AD\u200B-\u200F\u2028\u2029\uFEFF]/g, '');

	// 4. Artifact prefixes.
	text = text.replace(/^\s*RTF Template\s*/i, '');  // Oracle/Workday HTML-to-text artifact
	text = text.replace(/^\s*96\s+/, '');              // HTML preheader number (Walmart, Amazon)

	// 5. [N] link-reference numbers from plain-text email renderers.
	text = text.replace(/\[\d+\]/g, '');

	// 6. URLs.
	text = text.replace(/https?:\/\/\S+/g, '');

	// 7. Footer truncation — discard everything from the first boilerplate signal.
	const footerIdx = text.search(FOOTER_RE);
	if (footerIdx > 0) text = text.slice(0, footerIdx);

	// 8. Collapse whitespace.
	return text.replace(/\s+/g, ' ').trim();
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
	const part = msg.payload ?? undefined;

	if (!from.includes('indeedapply@indeed.com')) {
		return cleanBody(extractBody(part)).slice(0, BODY_LIMIT);
	}

	// Indeed: company name lives in the HTML part, not plain text.
	// Prepend "Employer: [Company]" so the classifier sees it immediately.
	const richBody = cleanBody(extractHtmlBody(part) || extractBody(part));
	const sentTo   = richBody.match(/sent to ([^.]+)\./i);
	const prefix   = sentTo ? `Employer: ${sentTo[1].trim()}\n\n` : '';
	return prefix + richBody.slice(0, prefix ? 1000 : 3000);
}

function getGmail(tokens: Credentials): gmail_v1.Gmail {
	const client = getOAuthClient();
	client.setCredentials(tokens);
	return google.gmail({ version: 'v1', auth: client });
}

/** Build one EmailResult from a single message using its own headers (each email stands alone). */
function messageToEmailResult(msg: gmail_v1.Schema$Message): EmailResult {
	const headers      = msg.payload?.headers ?? [];
	const subject      = headers.find(h => h.name === 'Subject')?.value ?? '';
	const from         = headers.find(h => h.name === 'From')?.value    ?? '';
	const internalDate = msg.internalDate ? parseInt(msg.internalDate) : Date.now();
	return {
		threadId:        msg.threadId ?? '',
		messageId:       msg.id!,
		subject,
		from,
		body:            buildBody(msg, from),
		internalDate,
		lastMessageDate: new Date(internalDate).toISOString().split('T')[0],
	};
}

async function fetchMessage(gmail: gmail_v1.Gmail, id: string): Promise<EmailResult | null> {
	const res = await withRateLimitRetry(
		() => gmail.users.messages.get({ userId: 'me', id, format: 'full' }),
		`message ${id}`,
	);
	return res.data ? messageToEmailResult(res.data) : null;
}

/** The Gmail search query — positive job-phrase OR group plus noise exclusions, over the last `days`. */
function buildJobQuery(days: number): string {
	// Positive OR group: a thread must contain at least one job-related phrase, otherwise
	// unrelated mail bloats the result set.
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
        '"thank you for your interest"',
		'"interview for"',
		'"schedule your interview"',
	].join(' ')}}`;

	return [
		`newer_than:${days}d`,
		'-category:promotions',
		'-category:social',
		// Exclude your own sent mail — replies / follow-ups ("Re: Interview Request …") are not
		// employer status updates. Without this, per-message processing classifies them and the
		// recruiter's quoted subject leaks through (e.g. company "SS&C Incer"). Employer emails
		// are never from:me, so nothing legitimate is lost.
		'-from:me',
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
        '-subject:"incomplete"',
        '-subject:"your application was viewed"',
        '-subject:"draft"',
        // ATS "still reviewing" status pings — no new information, just noise.
        // Aquent | Skill sends these as "Quick Update!" emails while reviewing candidates.
        '-subject:"Quick Update!"',  //TODO: need to verify later
        '-subject:"Demographic Survey"',
		// Pre-filter the AUTOMATED_SUBJECT patterns that DO match the OR group (so they'd
		// otherwise be fetched and dropped at runtime). Saves the thread fetch. The runtime
		// AUTOMATED_SUBJECT check stays as the precise backstop — these Gmail terms are fuzzy
		// (word-tokenized, no anchors/lookahead), and patterns like "jacobs ...(?!,)" or
		// "\d+ new jobs" can't be expressed here at all.
		'-subject:reminder',                          // re-announcements, never a new state (interview reminders match "interview for")
		'-subject:"career opportunities at"',         // recruitment marketing ("Your career opportunities at Travelers!")
		'-subject:"interview confirmation"',
		'-subject:"interview confirmed"',
		'-subject:"has been scheduled"',              // "Your interview has been scheduled" — calendar noise, matches OR "your interview"
		'-subject:"calendar invite"',
		'-subject:"meeting confirmed"',
        keywordFilter,
	].join(' ');
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * List the message IDs matching the job query, newest-first (Gmail's order). Cheap —
 * messages.list (5 units/page) returns only ID stubs, no bodies. The caller drops
 * already-synced IDs before fetching any content, so a routine sync downloads only what's new.
 */
async function listJobMessageIds(tokens: Credentials, days: number): Promise<string[]> {
	const gmail = getGmail(tokens);
	const query = buildJobQuery(days);
	console.log(`[sync] searching Gmail with query: ${query}`);

	const ids: string[] = [];
	let pageToken: string | undefined;
	do {
		const res = await withRateLimitRetry(
			() => gmail.users.messages.list({ userId: 'me', q: query, maxResults: 500, pageToken }),
			'messages.list',
		);
		for (const m of res.data.messages ?? []) ids.push(m.id!);
		pageToken = res.data.nextPageToken ?? undefined;
	} while (pageToken);

	console.log(`[sync] listed ${ids.length} message ids across ${Math.ceil(ids.length / 500) || 1} page(s)`);
	return ids;
}

/**
 * Stream full message content one batch at a time, yielding a single EmailResult per message.
 * The caller processes and discards each, so peak memory is one batch — not the whole mailbox.
 * Uses messages.get (20 units, half of threads.get) and paces batches under the rate ceiling.
 */
async function* streamJobMessages(tokens: Credentials, ids: string[]): AsyncGenerator<EmailResult> {
	const gmail = getGmail(tokens);
	for (let i = 0; i < ids.length; i += BATCH_SIZE) {
		const batchStart = Date.now();
		const batch      = ids.slice(i, i + BATCH_SIZE);
		const results    = await Promise.all(batch.map(id => fetchMessage(gmail, id)));
		for (const r of results) if (r) yield r;
		if (i + BATCH_SIZE < ids.length) {
			await sleep(Math.max(0, MIN_BATCH_INTERVAL_MS - (Date.now() - batchStart)));
		}
	}
}

async function revokeTokens(tokens: Credentials): Promise<void> {
	const client = getOAuthClient();
	client.setCredentials(tokens);
	if (tokens.access_token) {
		await client.revokeToken(tokens.access_token);
	}
}

export { getAuthUrl, exchangeCode, listJobMessageIds, streamJobMessages, revokeTokens };
