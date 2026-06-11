// ── Listing & fetching Gmail messages ───────────────────────────────────────
// The job-search query, rate-limited fetch, batched streaming (one batch in memory), and the account address.

import { google } from 'googleapis';
import type { gmail_v1 } from 'googleapis';
import type { Credentials } from 'google-auth-library';
import type { EmailResult } from '../../types';
import { getOAuthClient } from './oauth';
import { buildBody } from './body';

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

function getGmail(tokens: Credentials): gmail_v1.Gmail {
	const client = getOAuthClient();
	client.setCredentials(tokens);
	return google.gmail({ version: 'v1', auth: client });
}

/**
 * The Gmail address of the connected account. Stored on each tracked email so "open in Gmail" links can
 * target u/<address> — the right account regardless of its login-order index in the user's browser (a
 * non-primary mailbox is u/1+, so a hardcoded u/0 would open the wrong account). Null if the lookup fails.
 */
export async function getAccountEmail(tokens: Credentials): Promise<string | null> {
	try {
		const res = await getGmail(tokens).users.getProfile({ userId: 'me' });
		return res.data.emailAddress ?? null;
	} catch {
		return null;   // non-fatal: links fall back to u/0
	}
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
        '"regret to"',
		// Soft rejections (T-Mobile/Workday): negated "fit" — a promo says "find the right fit", never
		// "wasn't the right fit", so the negation keeps marketing out.
		'"wasn\'t the right fit"',
		'"isn\'t the best fit"',
		'"not the right fit"',        // non-contracted variant ("was not the right fit")
		'"not the best fit"',
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
        '-"Glassdoor Community"',
        '-"Account Verification"',
        '-from:noreply@newsletters.nyc.gov',
        '-"Action Required"',
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
        '-subject:"complete your"',
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
        '-subject:"you have started an application!"',   // Monster job board noise
        '-subject:"additional information needed"',
        keywordFilter,
	].join(' ');
}

/**
 * List the message IDs matching the job query, newest-first (Gmail's order). Cheap —
 * messages.list (5 units/page) returns only ID stubs, no bodies. The caller drops
 * already-synced IDs before fetching any content, so a routine sync downloads only what's new.
 */
export async function listJobMessageIds(tokens: Credentials, days: number): Promise<string[]> {
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
export async function* streamJobMessages(tokens: Credentials, ids: string[], failedIds: string[]): AsyncGenerator<EmailResult> {
	const gmail = getGmail(tokens);
	for (let i = 0; i < ids.length; i += BATCH_SIZE) {
		const batchStart = Date.now();
		const batch      = ids.slice(i, i + BATCH_SIZE);
		const results    = await Promise.all(batch.map(async id => {
			try {
				return await fetchMessage(gmail, id);
			} catch (err) {
				// Don't let one unfetchable message (e.g. 400 failedPrecondition) abort the whole sync.
				// Record it instead: it is NOT marked synced, so the next sync retries it, and the
				// caller surfaces the count so the user knows some emails still need reading.
				const e = err as { code?: number; status?: number; message?: string };
				console.warn(`[sync] failed to fetch message ${id}: ${e.code ?? e.status ?? ''} ${e.message ?? 'error'}`);
				failedIds.push(id);
				return null;
			}
		}));
		for (const r of results) if (r) yield r;
		if (i + BATCH_SIZE < ids.length) {
			await sleep(Math.max(0, MIN_BATCH_INTERVAL_MS - (Date.now() - batchStart)));
		}
	}
}
