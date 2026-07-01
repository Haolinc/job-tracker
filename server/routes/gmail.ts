import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { listJobMessageIds, streamJobMessages, getAccountEmail } from '../services/gmail/messages';
import { classifyEmail } from '../services/classifier';
import { parseEmail } from '../services/parser/templates';
import { extractGeneralCompanyRole } from '../services/parser/companyRole';
import { extractJobNumber } from '../services/parser/reqId';
import { recoverRoleFromBody, tidyRole } from '../services/parser/roles';
import * as db from '../services/db';
import { isIgnorableEmail } from '../services/filters';
import {
	normalizeCompany,
	companyDomainFromSender,
	companiesSameEntity,
} from '../services/companyIdentity';
import { findExisting } from '../services/applicationMatcher';
import { errMsg, formatDuration, resolveStatus, isFastApplyNotice, looksLikeStatusUpdate, looksLikeConfirmation } from '../utils';
import type { EmailResult, Status } from '../types';

const router = Router();

/** The auto-detection note for an application, flagging when the role still needs manual entry. */
function gmailNote(subject: string, hasRole: boolean): string {
	const base = `Auto-detected from Gmail: ${subject}`;
	return hasRole ? base : `${base}\n⚠️ Role could not be extracted — please update manually.`;
}

// The result of classifying ONE email: either a skip marker, or a `merge` record carrying everything the
// (sequential) merge step needs. `classifierCode` rides along on both so the parsed-by counters tally the
// same set of emails as before. No raw body is retained — it's consumed during classification.
type ClassifyResult =
	| { kind: 'skip'; threadId: string; messageId: string; classifiedAs: 'ignored'; classifierCode?: string }
	| {
		kind: 'merge'; threadId: string; messageId: string; subject: string;
		category: Status; company: string; role: string | null;
		externalId: string | null; senderDomain: string | null;
		isConfirmation: boolean; isFastApply: boolean;
		detectedBy: 'parser' | 'llm'; classifierCode?: string;
		internalDate: number; lastMessageDate: string;
	};

/**
 * The order-INDEPENDENT half of processing one email: hard-filter, parser, LLM (full classify or role-only
 * fill), tidy/normalize, and the body-derived signals (req number, sender domain, confirmation kind). It
 * reads only this email's text — no DB, no shared state — so it is safe to run concurrently. NEVER throws,
 * so one bad email can't break the concurrency window; LLM failures return a skip marker instead.
 */
async function classifyOne(email: EmailResult): Promise<ClassifyResult> {
	const { threadId, messageId, subject, from, body } = email;

	// Hard-filter obvious non-job emails before calling the LLM.
	if (isIgnorableEmail(subject, from, body)) {
		console.log(`[sync] skip (auto-filtered) subject="${subject}"`);
		return { kind: 'skip', threadId, messageId, classifiedAs: 'ignored' };
	}

	// Try deterministic parser first — covers ~50-60% of emails (LinkedIn, Indeed, Workday)
	// with zero AI cost. Falls back to the LLM for everything else.
	let classification = parseEmail(subject, from, body);
	const detectedBy: 'parser' | 'llm' = classification ? 'parser' : 'llm';   // which path handled this email

	if (!classification) {
		try {
			classification = await classifyEmail(subject, from, body);
		} catch (err) {
			// Mark synced (by the caller) so a malformed LLM response isn't retried on every subsequent sync.
			console.error(`[classify] error for subject="${subject}":`, err);
			return { kind: 'skip', threadId, messageId, classifiedAs: 'ignored' };
		}

		// The LLM is the SOURCE OF TRUTH for company/role on this path. The deterministic regex only
		// FILLS GAPS — when the LLM returned null — and never overrides a value the LLM produced.
		// (Overriding used to corrupt correct answers, e.g. truncate "Sherpa 6" → "Sherpa".)
		if (classification.category !== 'ignored' && (!classification.company || !classification.role)) {
			const ext = extractGeneralCompanyRole(subject, body);
			if (!classification.company && ext) classification.company = ext.company;
			if (!classification.role) classification.role = ext?.role ?? recoverRoleFromBody(body, subject);
		}
	} else if (classification.category !== 'ignored' && !classification.role) {
		// The parser nailed company + category but couldn't pull a role from the templated text. Consult the
		// LLM for the ROLE ONLY — the parser's company/category stay authoritative. A failed or empty call
		// just leaves the role null → "Unknown Role", same as before.
		try {
			const ai = await classifyEmail(subject, from, body);
			if (ai.role) {
				classification = { ...classification, role: ai.role };
				console.log(`[sync] role filled by LLM: "${ai.role}" subject="${subject}"`);
			}
			// Also adopt a req number the AI found — the parser may have missed it even when it got the role.
			if (ai.req_id) classification.req_id = ai.req_id;
		} catch (err) {
			console.error(`[classify] role-fill error for subject="${subject}":`, err);
		}
	}

	// Tidy the final role (parser- or LLM-sourced) so an AI-included req/ID or location tail
	// ("Integration Services Developer (reference number: 771221)") doesn't reach the record.
	if (classification.role) classification.role = tidyRole(classification.role) || null;
	const { category, role } = classification;
	const classifierCode = classification.classifier_code;
	let { company } = classification;

	// Normalize legal suffixes for consistent dedup.
	if (company) company = normalizeCompany(company);

	// HackerRank's assessment product (hackerrankforwork.com) sends coding tests ON BEHALF OF an employer
	// and sometimes names itself as the company. Drop "HackerRank" as a company ONLY when the email is from
	// that product domain — a genuine application to HackerRank itself keeps its real name.
	if (company && /^hacker\s?rank\b/i.test(company) && /hackerrankforwork\.(?:com|io)/i.test(from)) {
		console.log(`[sync] drop assessment-platform name as company: "${company}" subject="${subject}"`);
		company = null;
	}

	if (category === 'ignored' || !company) {
		console.log(`[sync] skip (category=${category} company=${company}) subject="${subject}"`);
		return { kind: 'skip', threadId, messageId, classifiedAs: 'ignored', classifierCode };
	}

	// Deterministic extraction first (reliable, never hallucinates); fall back to the req number the AI
	// surfaced. Both keep the number in the SAME literal form, so a posting matches across parser/AI paths.
	const externalId = extractJobNumber(subject, body) ?? classification.req_id ?? null;
	// Real company domain (null for ATS/job-board senders) — a matching safeguard and a stored signal.
	const senderDomain = companyDomainFromSender(from);
	// A fresh confirmation vs a later status ping: an "applied" email is a confirmation when it carries
	// confirmation language, or when its subject doesn't read as an update.
	const isConfirmation = category === 'applied'
		&& (looksLikeConfirmation(subject, body) || !looksLikeStatusUpdate(subject));
	const isFastApply = isFastApplyNotice(classifierCode);

	return {
		kind: 'merge', threadId, messageId, subject,
		category, company, role, externalId, senderDomain,
		isConfirmation, isFastApply, detectedBy, classifierCode,
		internalDate: email.internalDate, lastMessageDate: email.lastMessageDate,
	};
}

/**
 * Map an async stream through `fn` with bounded concurrency, yielding results in COMPLETION order (whichever
 * `fn` call finishes first). Up to `depth` calls run at once; when the window is full we wait for ANY one to
 * finish (not the oldest), so a single slow item never stalls the window — the freed slot is refilled at once,
 * keeping the backend maximally fed. Order is not preserved: the sole consumer sorts results by date afterward,
 * so arrival order is irrelevant. Peak memory is the `depth` in-flight results, independent of stream length.
 */
export async function* mapAhead<T, R>(source: AsyncIterable<T>, depth: number, fn: (item: T) => Promise<R>): AsyncGenerator<R> {
	// Key each in-flight promise so the race winner — and only it — can be evicted before the next race.
	const inflight = new Map<number, Promise<[number, R]>>();
	let nextKey = 0;
	const settle = async (): Promise<R> => {
		const [finishedKey, value] = await Promise.race(inflight.values());   // first to FINISH, not the oldest to start
		inflight.delete(finishedKey);
		return value;
	};
	for await (const item of source) {
		const taskKey = nextKey++;
		inflight.set(taskKey, fn(item).then((value): [number, R] => [taskKey, value]));   // starts now → up to `depth` run at once
		if (inflight.size >= depth) yield await settle();
	}
	while (inflight.size) yield await settle();
}

router.post('/sync', requireAuth, async (req: Request, res: Response) => {
	// Progress streams to the client as newline-delimited JSON: a 'start' event (with the total), a
	// 'progress' event per email, and a final 'done' event. Once streaming begins the HTTP status is
	// already 200, so a later error is reported as an 'error' event instead of a 500.
	let streaming = false;
	const send = (event: Record<string, unknown>) => res.write(JSON.stringify(event) + '\n');
	try {
        const start = Date.now();
		// 1. List matching message IDs (cheap — stubs only). 2. Drop already-synced ones BEFORE
		// fetching any bodies, so a routine sync downloads only what's new. 3. Stream bodies one batch
		// at a time and discard each after use — peak memory is one batch. Processing order is
		// irrelevant: the merge keys on each email's precise internalDate (status/note = latest,
		// date_applied = earliest), so newest- or oldest-first yields the same result.
		// Scan window chosen per request (the 30/60/90/180 picker), defaulting to 30. Widening it is
		// safe — skip-synced backfills only the newly in-range emails. Values outside the allow-list
		// are ignored to bound fetch cost.
		const ALLOWED_DAYS = [30, 60, 90, 180];
		const requested    = Number(req.body?.days ?? req.query?.days);
		const days         = ALLOWED_DAYS.includes(requested) ? requested : 30;
		console.log(`[sync] scan window: ${days} days`);

		const allIds   = await listJobMessageIds(req.session.tokens!, days);
		// The mailbox being synced — stamped on each tracked email so its "open in Gmail" link targets the
		// correct account (u/<address>) even when it isn't the browser's primary (u/0) account.
		const accountEmail = await getAccountEmail(req.session.tokens!);
		const syncedIds = await db.getSyncedMessageIds(allIds);
		const newIds   = allIds.filter(id => !syncedIds.has(id));
		const failedIds: string[] = [];   // messages that errored on fetch — not synced, retried next run
		let added = 0, updated = 0, skipped = allIds.length - newIds.length, linkedinApplyParsed = 0, linkedinRejectParsed = 0, indeedParsed = 0, generalParsed = 0;
		console.log(`[sync] ${newIds.length} new of ${allIds.length} (skipped ${skipped} already-synced before fetch)`);

		res.setHeader('Content-Type', 'application/x-ndjson');
		res.setHeader('Cache-Control', 'no-cache');
		res.setHeader('X-Accel-Buffering', 'no');   // don't let a proxy buffer the progress stream
		streaming = true;
		send({ phase: 'start', processed: 0, total: newIds.length, added: 0, updated: 0, skipped });

		let processed = 0;
		// Emit progress reflecting the counts AFTER the current email is handled — called at each exit point
		// so added/updated/skipped are always current rather than lagging one email behind.
		const emitProgress = () => send({ phase: 'progress', processed, total: newIds.length, added, updated, skipped });
		// PHASE 1 — classify with bounded concurrency (SYNC_CONCURRENCY, default 3): the slow LLM step overlaps
		// across emails (needs OLLAMA_NUM_PARALLEL for an actual speedup). Skips are finalized as they arrive;
		// merge-eligible results are COLLECTED. Completion order is irrelevant here — phase 2 re-sorts by date.
		const concurrency = Number(process.env.SYNC_CONCURRENCY) || 3;
		const pending: Extract<ClassifyResult, { kind: 'merge' }>[] = [];
		for await (const classified of mapAhead(streamJobMessages(req.session.tokens!, newIds, failedIds), concurrency, classifyOne)) {
			processed++;
			// Parsed-by counters: tallied for every email the parser classified (classifier_code present).
			if (classified.classifierCode === 'linkedin_applied') linkedinApplyParsed++;
			if (classified.classifierCode === 'linkedin_rejected') linkedinRejectParsed++;
			if (classified.classifierCode === 'indeed_applied') indeedParsed++;
			if (classified.classifierCode === 'general_template') generalParsed++;

			if (classified.kind === 'skip') {
				await db.markEmailSynced({ thread_id: classified.threadId, message_id: classified.messageId, classified_as: classified.classifiedAs });
				skipped++;
				emitProgress();
				continue;
			}
			pending.push(classified);
			emitProgress();
		}

		// PHASE 1.5 — sort into a DETERMINISTIC merge order: oldest first (the matcher's "predates"/"nearest"
		// rules are causal, so oldest→newest is their best case), ties broken by messageId so grouping is
		// reproducible across resyncs regardless of the order Gmail/concurrency produced results in.
		pending.sort((a, b) => a.internalDate - b.internalDate || (a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0));

		// PHASE 2 — sequential, order-sensitive merge, in date order. Re-bind the classified result's fields
		// under the names the logic below uses; `email` is a thin stand-in for the two date fields it reads.
		for (const classified of pending) {
			const { threadId, messageId, subject, category, company, role, externalId, senderDomain, isConfirmation, isFastApply, detectedBy } = classified;
			const email = { internalDate: classified.internalDate, lastMessageDate: classified.lastMessageDate };

			const existing = await findExisting(company, role, externalId, senderDomain, isConfirmation, isFastApply, email.lastMessageDate);

			// The Gmail message that drove this email's stage — recorded so the user can open the actual
			// email later. `category` is already narrowed to the four non-'ignored' stages by the guard above.
			// The inbox it lives in is tracked once at the application level (accountEmail), not per ref.
			const emailRef = { messageId, category, date: email.lastMessageDate, fast_apply: isFastApply };

			// Surface merges where only the DOMAIN matched while the NAMES differ — these are the ones to
			// audit (a shared host wrongly merging two employers vs. correctly bridging a name variant).
			if (existing && senderDomain && existing.company_domain === senderDomain && !companiesSameEntity(existing.company, company)) {
				console.log(`[sync] domain-bridged merge: "${company}" → existing "${existing.company}" (domain ${senderDomain})`);
			}

			if (existing) {
				// Status moves FORWARD only (resolveStatus) — a later email never rolls it back. Activity fields
				// (last_activity, auto note, detected_by) track the NEWEST email by precise internalDate, and
				// date_applied the EARLIEST. ts 0 means "no recorded activity yet", so any email counts as newer.
				const isNewer   = email.internalDate >= existing.last_activity_ts;
				const isEarlier = !existing.date_applied || email.lastMessageDate < existing.date_applied;
				// Upgrade "Unknown Role" when this email provides a specific role
				// (e.g. a BAE Systems status update naming the role after a generic confirmation).
				const upgradedRole = existing.role === 'Unknown Role' && role ? role : null;
				const roleUpgrade = upgradedRole ? { role: upgradedRole } : {};
				const effectiveRole = upgradedRole ?? existing.role;
				const resolved = resolveStatus(existing.status, category);
				const statusUpdate = resolved !== existing.status ? { status: resolved } : {};
				// The newest email owns last_activity and the auto note (a 'manual' note is never overwritten).
				const activityUpdate = isNewer
					? {
						last_activity: email.lastMessageDate,
						last_activity_ts: email.internalDate,
						detected_by: detectedBy,   // record how the newest (status-driving) email was classified
						...(existing.notes_source !== 'manual'
							? { notes: gmailNote(subject, effectiveRole !== 'Unknown Role') }
							: {}),
					}
					: {};
				// Sticky: any interview/offer email marks the app as having reached interview — even if
				// a later rejection becomes the current status. Only ever set true.
				const reachedUpdate = (category === 'interview' || category === 'offer') && !existing.reached_interview
					? { reached_interview: true }
					: {};
				// Backfill the req/job number if this email has one and the record doesn't yet.
				const externalIdUpdate = externalId && !existing.external_id ? { external_id: externalId } : {};
				// Backfill the company domain once a real company email arrives for a record first created
				// from an ATS/job-board sender (so later syncs can match by domain).
				const domainUpdate = senderDomain && !existing.company_domain ? { company_domain: senderDomain } : {};
				// A confirmation arriving for an "awaiting" record (one created by an earlier update) supplies
				// the original application and closes the wait — clear the flag so nothing else claims it.
				const awaitingClear = isConfirmation && existing.awaiting_application ? { awaiting_application: false } : {};
				// A LinkedIn/Indeed fast-apply that merges in MARKS the record fast_apply — it's only the job
				// board's "application sent" notice, not the company's own confirmation. The mark lets the REAL
				// company confirmation (a regular email) still pair with this record by title later, instead of
				// being split off as a separate record.
				const fastApplyMark = isFastApply && !existing.fast_apply ? { fast_apply: true } : {};
				// Fill the CONFIRMATION slot when a company (non-fast) confirmation merges in; once set, a
				// second confirmation can't pair into this record.
				const confirmedMark = isConfirmation && !isFastApply && !existing.confirmed ? { confirmed: true } : {};
				// Backfill the application's Gmail account if it doesn't have one yet (e.g. a record created
				// before this account was known) — one account per application drives all its email links.
				const accountBackfill = accountEmail && !existing.account ? { account: accountEmail } : {};
				const merged = {
					...statusUpdate,
					...activityUpdate,
					...(isEarlier ? { date_applied: email.lastMessageDate } : {}),
					...roleUpgrade,
					...reachedUpdate,
					...externalIdUpdate,
					...domainUpdate,
					...awaitingClear,
					...fastApplyMark,
					...confirmedMark,
					...accountBackfill,
				};
				// One round-trip: apply the field updates and append the email ref (deduped by messageId).
				await db.updateWithEmail(existing.id, merged, emailRef);
				updated++;
			} else {
				await db.create({
					company,
					role:            role ?? 'Unknown Role',
					status:          category,
					interview_step:  null,
					reached_interview: category === 'interview' || category === 'offer',
					date_applied:    email.lastMessageDate,
					last_activity:   email.lastMessageDate,
					last_activity_ts: email.internalDate,
					job_url:         null,
					notes:           gmailNote(subject, !!role),
					external_id:     externalId,
					detected_by:     detectedBy,
					company_domain:  senderDomain,
					// A status update creating its own record means its confirmation isn't here yet (older
					// than the scan window, or simply not synced) — mark it so a later confirmation backfills it.
					awaiting_application: !isConfirmation,
					fast_apply:      isFastApply,
					// Confirmation slot: a company (non-fast) confirmation fills it; a fast notice fills
					// fast_apply instead; a status email fills neither (stays awaiting).
					confirmed:       isConfirmation && !isFastApply,
					source:          'gmail',
					gmail_thread_id: threadId,
					account:         accountEmail,   // the inbox these emails live in (one per application)
					emails:          [emailRef],
				});
				added++;
			}

			await db.markEmailSynced({ thread_id: threadId, message_id: messageId, classified_as: category });
			emitProgress();
		}
        const durationMs = Date.now() - start;
        const failed = failedIds.length;
        if (failed) console.warn(`[sync] ${failed} message(s) could not be fetched — NOT marked synced, will be retried next sync: ${failedIds.join(', ')}`);
        console.log(`[sync] completed: ${added} added, ${updated} updated, ${skipped} skipped${failed ? `, ${failed} failed` : ''} (LinkedIn applied parsed: ${linkedinApplyParsed}, LinkedIn rejected parsed: ${linkedinRejectParsed}, Indeed parsed: ${indeedParsed}, General template parsed: ${generalParsed})`);
        console.log(`[sync] duration: ${formatDuration(durationMs)} (${(durationMs / 1000).toFixed(2)}s)`);

		send({ phase: 'done', added, updated, skipped, failed, durationMs });
		res.end();
	} catch (err) {
		console.error('Sync error:', err);
		if (streaming) { send({ phase: 'error', error: errMsg(err, 'Unknown error') }); res.end(); }
		else res.status(500).json({ error: 'Sync failed: ' + errMsg(err, 'Unknown error') });
	}
});

export default router;
