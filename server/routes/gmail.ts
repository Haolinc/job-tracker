import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { listJobMessageIds, streamJobMessages, getAccountEmail, isReconnectRequiredError } from '../services/gmail/messages';
import { classifyEmail, warmUpModel, pickCompanyRole } from '../services/classifier';
import { parseEmail } from '../services/parser/templates';
import { extractGeneralCompanyRole } from '../services/parser/companyRole';
import { extractJobNumber } from '../services/parser/reqId';
import { recoverRoleFromBody, tidyRole } from '../services/parser/roles';
import * as db from '../services/db';
import { isIgnorableEmail } from '../services/filters';
import {
	companyTradeName,
	companyDomainFromSender,
	companiesSameEntity,
} from '../services/companyIdentity';
import { findExisting } from '../services/applicationMatcher';
import { errMsg, formatDuration, resolveStatus, isFastApplyNotice, looksLikeStatusUpdate, looksLikeConfirmation } from '../utils';
import { isSyncRunning, setSyncRunning, isImportRunning, setLastSyncEvent, getLastSyncEvent, isSyncCancelRequested, requestSyncCancel, clearSyncCancel } from '../services/syncState';
import { debug, info, guiLine } from '../logger';
import type { Application, ClassifierCode, EmailResult, EmailRef, Status } from '../types';

const router = Router();

// Each sync progress event is mirrored to stdout as "@sync-progress@ {json}" so the desktop launcher can
// render a live sync line in its panel. Keep in sync with the same constant in desktop/src/serverManager.ts.
const SYNC_PROGRESS_MARKER = '@sync-progress@';

// Shown when Google rejects the stored credentials. Names the fix rather than the fault: the raw
// "invalid_grant" or 401 tells the user nothing, and reconnecting is the only thing that resolves it.
const GMAIL_RECONNECT_MESSAGE = 'Gmail access has expired or been revoked. Please reconnect your Google account.';

// The deterministic-parser templates worth tallying per sync, keyed by the classifier_code each one stamps.
// Drives both the counting and the summary line, so a new template needs one entry here and nothing else.
// An LLM-classified email carries no code and is counted by none of them.
const PARSED_BY_LABEL: Record<ClassifierCode, string> = {
	linkedin_applied:  'LinkedIn applied',
	linkedin_rejected: 'LinkedIn rejected',
	indeed_applied:    'Indeed applied',
	indeed_rejected:   'Indeed rejected',
	general_template:  'General template',
};

/** The auto-detection note for an application, flagging when the role still needs manual entry. */
function gmailNote(subject: string, hasRole: boolean): string {
	const base = `Auto-detected from Gmail: ${subject}`;
	return hasRole ? base : `${base}\n⚠️ Role could not be extracted — please update manually.`;
}

// The result of classifying ONE email: a skip marker (marked synced, never revisited), a `failed` marker
// (the classifier itself errored — NOT marked synced, so the email is retried on the next sync), or a
// `merge` record carrying everything the (sequential) merge step needs. `classifierCode` rides along so
// the parsed-by counters tally the same set of emails as before. No raw body is retained — it's consumed
// during classification.
type ClassifyResult =
	| { kind: 'skip'; threadId: string; messageId: string; classifiedAs: 'ignored'; classifierCode?: ClassifierCode }
	| { kind: 'failed'; threadId: string; messageId: string }
	| {
		kind: 'merge'; threadId: string; messageId: string; subject: string;
		category: Status; company: string; role: string | null;
		externalId: string | null; senderDomain: string | null;
		isConfirmation: boolean; isFastApply: boolean;
		detectedBy: 'parser' | 'llm'; classifierCode?: ClassifierCode;
		internalDate: number; lastMessageDate: string;
	};

/**
 * The order-INDEPENDENT half of processing one email: hard-filter, parser, LLM (full classify or role-only
 * fill), tidy/normalize, and the body-derived signals (req number, sender domain, confirmation kind). It
 * reads only this email's text — no DB, no shared state — so it is safe to run concurrently. NEVER throws,
 * so one bad email can't break the concurrency window; LLM failures return a skip marker instead.
 */
export async function classifyOne(email: EmailResult): Promise<ClassifyResult> {
	const { threadId, messageId, subject, from, body } = email;
    debug(`[sync] body subject="${subject}" from="${from}" cleaned=${JSON.stringify(body)}`);

	// Hard-filter obvious non-job emails before calling the LLM.
	if (isIgnorableEmail(subject, from, body)) {
		debug(`[sync] skip (auto-filtered) subject="${subject}"`);
		return { kind: 'skip', threadId, messageId, classifiedAs: 'ignored' };
	}

	// Try deterministic parser first — covers ~50-60% of emails (LinkedIn, Indeed, Workday)
	// with zero AI cost. Falls back to the LLM for everything else.
	let classification = parseEmail(subject, from, body);
	let detectedBy: 'parser' | 'llm' = classification ? 'parser' : 'llm';   // which path handled this email
	// The parser's own company was judged NOT an employer, so the fallback below must not re-insert it.
	let parserCompanyRejected = false;
	// A role the picker found before declining to name a company — used only if the LLM returns none.
	let pickerSalvagedRole: string | null = null;

	// The general template can capture a noun phrase without knowing what it IS ("your interest in X" fits
	// both "…in Axoni" and "…in Software Engineer"), so it emits the candidates untyped. Resolve them:
	//   • < 2 candidates → there is nothing to choose between, and a lone span is as likely a role as a company
	//     (the Leidos "Mid-Level Software Engineer" trap). Hand it to the full classifier to read the whole email.
	//   • ≥ 2 candidates → the cheap picker TYPES them (which is the company, which the role) without re-reading
	//     the body. If it is not confident any span is a legitimate company, it returns null → slide to full.
	if (classification?.ambiguous_spans && classification.category !== 'ignored') {
		const spans = classification.ambiguous_spans;
		// Log the candidate list + the parser's own first-match guess, so a wrong company stays traceable to
		// which candidates were (and weren't) on offer.
		debug(`[sync] ambiguous candidates=${JSON.stringify(spans)} parserGuess="${classification.company}" subject="${subject}"`);
		if (spans.length < 2) {
			debug(`[sync] <2 candidates; deferring to full classify subject="${subject}"`);
			parserCompanyRejected = true;   // a lone untyped span is not a company we can trust
			classification = null;
			detectedBy = 'llm';
		} else {
			const picked = await pickCompanyRole(spans, subject, body);
			if (picked?.company) {
				debug(`[sync] picked: company="${picked.company}" role="${picked.role ?? ''}" subject="${subject}"`);
				classification = { ...classification, company: picked.company, role: picked.role ?? classification.role };
			} else if (picked) {
				// No span is a legitimate employer. Slide to the full classifier, keeping the role it DID find.
				debug(`[sync] picker named no employer; deferring to full classify subject="${subject}"`);
				parserCompanyRejected = true;
				pickerSalvagedRole = picked.role;
				classification = null;
				detectedBy = 'llm';
			}
			// picked === null (Ollama down / bad response) → keep the parser's guess, exactly as before.
		}
	}

	if (!classification) {
		// The LLM reads the whole email unaided. Parser candidates used to ride along as reference hints; on the
		// hand-corrected audit they bought nothing (company 88.6% hinted vs 90.9% unhinted, role tied at 73.5%)
		// and anchored the model to a trimmed span ("Ametek" for "Ametek, Inc.").
		try {
			classification = await classifyEmail(subject, from, body);
		} catch (err) {
			// NOT marked synced: a classifier failure (Ollama down, malformed response) must not consume
			// the email forever — it stays unsynced, counts into the sync's `failed` tally, and is retried
			// on the next sync.
			console.error(`[classify] error for subject="${subject}":`, err);
			return { kind: 'failed', threadId, messageId };
		}

		// Safety net for a field the LLM left null. Never OVERRIDE a value it produced (overriding used to
		// truncate correct answers, "Sherpa 6" → "Sherpa"), and never re-insert a rejected company — it is a role.
		if (classification.category !== 'ignored' && (!classification.company || !classification.role)) {
			const parserCandidates = extractGeneralCompanyRole(subject, body);
			if (!classification.company && parserCandidates && !parserCompanyRejected) classification.company = parserCandidates.company;
			if (!classification.role) classification.role = (pickerSalvagedRole ?? parserCandidates?.role) ?? recoverRoleFromBody(body, subject);
		}
	} else if (classification.category !== 'ignored' && !classification.role) {
		// The parser nailed company + category but couldn't pull a role from the templated text. Consult the
		// LLM for the ROLE ONLY — the parser's company/category stay authoritative. A failed or empty call
		// just leaves the role null → "Unknown Role", same as before.
		try {
			const roleFill = await classifyEmail(subject, from, body);
			if (roleFill.role) {
				classification = { ...classification, role: roleFill.role };
				debug(`[sync] role filled by LLM: "${roleFill.role}" subject="${subject}"`);
			}
			// Also adopt a req number the AI found — the parser may have missed it even when it got the role.
			if (roleFill.req_id) classification.req_id = roleFill.req_id;
		} catch (err) {
			console.error(`[classify] role-fill error for subject="${subject}":`, err);
		}
	}

	const { category } = classification;
	const classifierCode = classification.classifier_code;
	let { company, role } = classification;

	// Deterministic mechanical net (the symbolic half of the pipeline). The picker and full classifier JUDGE the
	// semantics — which span is the company, which the role, when to abstain — and are told to keep the WHOLE
	// title (levels, departments, specializations) rather than mechanically trim, because that is where the LLM
	// over-reaches (dropping a real "- Stores & Supply Chain", or nulling a title because a req-id is glued on).
	// tidyRole is the precise, list-based pass that strips ONLY mechanical noise the model leaves — a trailing
	// requisition id, a city/state, a work-mode word — and never touches a real title part, so it cleans an
	// un-stripped id without re-introducing the over-trim. Skipped for fast-apply, which stores the board's
	// posted title verbatim.
	if (role && !isFastApplyNotice(classifierCode)) role = tidyRole(role);

	// Resolve the name the employer goes by — the trade name behind a "dba", minus a LinkedIn page qualifier.
	// It no longer truncates legal suffixes: the stored company must be the email's own wording, and
	// companiesSameEntity already treats "Inc"/"LLC"/"Company" as descriptors when matching two spellings.
	if (company) company = companyTradeName(company);

	// HackerRank's assessment product (hackerrankforwork.com) sends coding tests ON BEHALF OF an employer
	// and sometimes names itself as the company. Drop "HackerRank" as a company ONLY when the email is from
	// that product domain — a genuine application to HackerRank itself keeps its real name.
	if (company && /^hacker\s?rank\b/i.test(company) && /hackerrankforwork\.(?:com|io)/i.test(from)) {
		debug(`[sync] drop assessment-platform name as company: "${company}" subject="${subject}"`);
		company = null;
	}

	if (category === 'ignored' || !company) {
		debug(`[sync] skip (category=${category} company=${company}) subject="${subject}"`);
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

type MergeCandidate = Extract<ClassifyResult, { kind: 'merge' }>;

/**
 * The field updates one classified email contributes to the application it merges into — every rule that
 * decides what an incoming email may and may not overwrite, in one place. PURE: it reads `existing` and the
 * classified result and returns the update record; the caller writes it (together with the email ref) in a
 * single transaction. An empty-ish record is fine — each rule contributes nothing when it doesn't apply.
 */
function buildMergeUpdates(existing: Application, classified: MergeCandidate, accountEmail: string | null): Record<string, unknown> {
	const { subject, category, role, externalId, senderDomain, isConfirmation, isFastApply, detectedBy, internalDate, lastMessageDate } = classified;

	// Activity fields (last_activity, auto note, detected_by) track the NEWEST email by precise internalDate,
	// and date_applied the EARLIEST. ts 0 means "no recorded activity yet", so any email counts as newer.
	const isNewer   = internalDate >= existing.last_activity_ts;
	const isEarlier = !existing.date_applied || lastMessageDate < existing.date_applied;
	// Upgrade "Unknown Role" when this email provides a specific role
	// (e.g. a BAE Systems status update naming the role after a generic confirmation).
	const upgradedRole = existing.role === 'Unknown Role' && role ? role : null;
	const effectiveRole = upgradedRole ?? existing.role;
	// Status moves FORWARD only (resolveStatus) — a later email never rolls it back.
	const resolvedStatus = resolveStatus(existing.status, category);

	return {
		...(resolvedStatus !== existing.status ? { status: resolvedStatus } : {}),
		// The newest email owns last_activity and the auto note (a 'manual' note is never overwritten).
		...(isNewer
			? {
				last_activity: lastMessageDate,
				last_activity_ts: internalDate,
				detected_by: detectedBy,   // record how the newest (status-driving) email was classified
				...(existing.notes_source !== 'manual' ? { notes: gmailNote(subject, effectiveRole !== 'Unknown Role') } : {}),
			}
			: {}),
		...(isEarlier ? { date_applied: lastMessageDate } : {}),
		...(upgradedRole ? { role: upgradedRole } : {}),
		// Sticky: any interview/offer email marks the app as having reached interview — even if a later
		// rejection becomes the current status. Only ever set true.
		...((category === 'interview' || category === 'offer') && !existing.reached_interview ? { reached_interview: true } : {}),
		// Backfill the req/job number if this email has one and the record doesn't yet.
		...(externalId && !existing.external_id ? { external_id: externalId } : {}),
		// Backfill the company domain once a real company email arrives for a record first created from an
		// ATS/job-board sender (so later syncs can match by domain).
		...(senderDomain && !existing.company_domain ? { company_domain: senderDomain } : {}),
		// A confirmation arriving for an "awaiting" record (one created by an earlier update) supplies the
		// original application and closes the wait — clear the flag so nothing else claims it.
		...(isConfirmation && existing.awaiting_application ? { awaiting_application: false } : {}),
		// A LinkedIn/Indeed fast-apply that merges in MARKS the record fast_apply — it's only the job board's
		// "application sent" notice, not the company's own confirmation. The mark lets the REAL company
		// confirmation (a regular email) still pair with this record by title later, instead of being split
		// off as a separate record.
		...(isFastApply && !existing.fast_apply ? { fast_apply: true } : {}),
		// Fill the CONFIRMATION slot when a company (non-fast) confirmation merges in; once set, a second
		// confirmation can't pair into this record.
		...(isConfirmation && !isFastApply && !existing.confirmed ? { confirmed: true } : {}),
		// Backfill the application's Gmail account if it doesn't have one yet (e.g. a record created before
		// this account was known) — one account per application drives all its email links.
		...(accountEmail && !existing.account ? { account: accountEmail } : {}),
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
	// One sync at a time: two runs would race each other's dedup checks, and the running-sync flag
	// (which /auth/disconnect consults before revoking tokens) assumes a single owner.
	if (isSyncRunning()) {
		res.status(409).json({ error: 'A sync is already running — wait for it to finish.' });
		return;
	}
	// A CSV import plan mid-apply and a sync are mutually exclusive (see /applications/import).
	if (isImportRunning()) {
		res.status(409).json({ error: 'A CSV import is being applied — try again in a moment.' });
		return;
	}
	setSyncRunning(true);
	// Drop any snapshot from the previous run so a reconnecting browser can't briefly read a stale 'done'
	// as if it belonged to this sync (see /sync/status below).
	setLastSyncEvent(null);
	// Clear any cancel left set from a prior run so this sync starts fresh (also cleared in finally).
	clearSyncCancel();
	// Progress streams to the client as newline-delimited JSON: a 'start' event (with the total), a
	// 'progress' event per email, and a final 'done' event. Once streaming begins the HTTP status is
	// already 200, so a later error is reported as an 'error' event instead of a 500.
	let streaming = false;
	// Every event goes to THREE places: the HTTP progress stream (the tab that started the sync), the GUI
	// channel as a marker line the desktop launcher turns into its live sync line (stdout only, never the log
	// files), and the shared snapshot a reconnecting browser reads via /sync/status. The HTTP write is the
	// only one that can fail — if the browser closed mid-sync — so it's guarded: the sync must run to
	// completion regardless (its DB writes are the real work), and a reopened tab resumes from the snapshot.
	const send = (event: Record<string, unknown>) => {
		setLastSyncEvent(event);
		guiLine(`${SYNC_PROGRESS_MARKER} ${JSON.stringify(event)}`);
		if (res.writableEnded || res.destroyed) return;   // client gone — keep syncing; snapshot + launcher still update
		try { res.write(JSON.stringify(event) + '\n'); } catch { /* socket died between the check and the write */ }
	};
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
		info(`[sync] scan window: ${days} days`);

		const allIds   = await listJobMessageIds(req.session.tokens!, days);
		// The mailbox being synced — stamped on each tracked email so its "open in Gmail" link targets the
		// correct account (u/<address>) even when it isn't the browser's primary (u/0) account.
		const accountEmail = await getAccountEmail(req.session.tokens!);
		const syncedIds = await db.getSyncedMessageIds(allIds);
		const newIds   = allIds.filter(messageId => !syncedIds.has(messageId));
		const failedIds: string[] = [];   // messages that errored on fetch — not synced, retried next run
		const classifyFailedIds: string[] = [];   // messages the classifier errored on — not synced, retried next run
		let added = 0, updated = 0, skipped = allIds.length - newIds.length;
		const parsedCountByClassifierCode = new Map<string, number>();
		info(`[sync] ${newIds.length} new of ${allIds.length} (skipped ${skipped} already-synced before fetch)`);

		res.setHeader('Content-Type', 'application/x-ndjson');
		res.setHeader('Cache-Control', 'no-cache');
		res.setHeader('X-Accel-Buffering', 'no');   // don't let a proxy buffer the progress stream
		streaming = true;
		send({ phase: 'start', days, processed: 0, total: newIds.length, added: 0, updated: 0, skipped });

		// Load the model BEFORE the concurrent classification starts, so the first emails don't all stall on a
		// cold load (and the launcher log / debug log don't interleave warmup with classify). No-op when it's
		// already warm from server boot; otherwise the client shows a "preparing model" step while it loads.
		if (newIds.length > 0) {
			send({ phase: 'warming', processed: 0, total: newIds.length, added: 0, updated: 0, skipped });
			await warmUpModel();
		}

		let processed = 0;
		// Emit progress reflecting the counts AFTER the current email is handled — called at each exit point
		// so added/updated/skipped are always current rather than lagging one email behind.
		const emitProgress = () => send({ phase: 'progress', processed, total: newIds.length, added, updated, skipped });
		// PHASE 1 — classify with bounded concurrency (SYNC_CONCURRENCY, default 3): the slow LLM step overlaps
		// across emails (needs OLLAMA_NUM_PARALLEL for an actual speedup). Skips are finalized as they arrive;
		// merge-eligible results are COLLECTED. Completion order is irrelevant here — phase 2 re-sorts by date.
		const concurrency = Number(process.env.SYNC_CONCURRENCY) || 3;
		const pending: MergeCandidate[] = [];
		for await (const classified of mapAhead(streamJobMessages(req.session.tokens!, newIds, failedIds), concurrency, classifyOne)) {
			// Cancel checkpoint: stop consuming new results the moment the user cancels. Whatever was already
			// classified into `pending` is simply dropped (never applied, so not marked synced) — the next sync
			// re-fetches it. In-flight classify calls do no DB writes, so abandoning them is safe.
			if (isSyncCancelRequested()) break;
			processed++;
			if (classified.kind === 'failed') {
				classifyFailedIds.push(classified.messageId);
				emitProgress();
				continue;
			}
			// Parsed-by tally: counted for every email a tracked parser template classified.
			const { classifierCode } = classified;
			if (classifierCode && classifierCode in PARSED_BY_LABEL) {
				parsedCountByClassifierCode.set(classifierCode, (parsedCountByClassifierCode.get(classifierCode) ?? 0) + 1);
			}

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
		pending.sort((first, second) =>
			first.internalDate - second.internalDate
			|| (first.messageId < second.messageId ? -1 : first.messageId > second.messageId ? 1 : 0));

		// PHASE 2 — sequential, order-sensitive merge, in date order. Each email either merges into a match
		// (buildMergeUpdates decides which fields a match may touch) or it starts its own application.
		for (const classified of pending) {
			// Cancel checkpoint between merges: each email is committed atomically, so stopping here keeps every
			// application already written and leaves the remaining ones for the next sync.
			if (isSyncCancelRequested()) break;
			const { threadId, messageId, subject, category, company, role, externalId, senderDomain, isConfirmation, isFastApply, detectedBy, internalDate, lastMessageDate } = classified;

			const existing = await findExisting(company, role, externalId, senderDomain, isConfirmation, isFastApply, lastMessageDate);

			// The Gmail message that drove this email's stage — recorded so the user can open the actual
			// email later. `category` is already narrowed to the four non-'ignored' stages by the guard above.
			// The inbox it lives in is tracked once at the application level (accountEmail), not per ref.
			// origin 'synced': this ref is being created BY the sync. updateWithEmail leaves an already-held
			// messageId completely alone, so a ref the user tagged 'manual' is never relabelled by a re-sync.
			const emailRef: EmailRef = { messageId, category, date: lastMessageDate, fast_apply: isFastApply, origin: 'synced' };

			// Surface merges where only the DOMAIN matched while the NAMES differ — these are the ones to
			// audit (a shared host wrongly merging two employers vs. correctly bridging a name variant).
			if (existing && senderDomain && existing.company_domain === senderDomain && !companiesSameEntity(existing.company, company)) {
				debug(`[sync] domain-bridged merge: "${company}" → existing "${existing.company}" (domain ${senderDomain})`);
			}

			if (existing) {
				// One round-trip: apply the field updates and append the email ref (deduped by messageId).
				await db.updateWithEmail(existing.id, buildMergeUpdates(existing, classified, accountEmail), emailRef);
				updated++;
			} else {
				await db.create({
					company,
					role:            role ?? 'Unknown Role',
					status:          category,
					interview_step:  null,
					reached_interview: category === 'interview' || category === 'offer',
					date_applied:    lastMessageDate,
					last_activity:   lastMessageDate,
					last_activity_ts: internalDate,
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
		const failed = failedIds.length + classifyFailedIds.length;
		if (failedIds.length) console.warn(`[sync] ${failedIds.length} message(s) could not be fetched — NOT marked synced, will be retried next sync: ${failedIds.join(', ')}`);
		if (classifyFailedIds.length) console.warn(`[sync] ${classifyFailedIds.length} message(s) could not be classified — NOT marked synced, will be retried next sync: ${classifyFailedIds.join(', ')}`);
		const parsedByBreakdown = Object.entries(PARSED_BY_LABEL)
			.map(([classifierCode, label]) => `${label} parsed: ${parsedCountByClassifierCode.get(classifierCode) ?? 0}`)
			.join(', ');
		info(`[sync] completed: ${added} added, ${updated} updated, ${skipped} skipped${failed ? `, ${failed} failed` : ''} (${parsedByBreakdown})`);
		info(`[sync] duration: ${formatDuration(durationMs)} (${(durationMs / 1000).toFixed(2)}s)`);

		// A user cancel ends the run as 'cancelled' (partial counts, not an error) — everything processed so far
		// is saved; the rest is left for the next sync.
		send({ phase: isSyncCancelRequested() ? 'cancelled' : 'done', added, updated, skipped, failed, durationMs });
		if (!res.writableEnded && !res.destroyed) res.end();   // no-op when the browser already disconnected
	} catch (err) {
		console.error('Sync error:', err);
		// Google rejected the credentials themselves, so they can never work again. Drop them so the app
		// offers "connect" instead of a Sync button that could only fail the same way.
		const needsReconnect = isReconnectRequiredError(err);
		if (needsReconnect) { req.session.tokens = null; req.session.accountEmail = null; }
		const failureMessage = needsReconnect ? GMAIL_RECONNECT_MESSAGE : errMsg(err, 'Unknown error');
		if (streaming) { send({ phase: 'error', error: failureMessage }); if (!res.writableEnded && !res.destroyed) res.end(); }
		else res.status(500).json({ error: 'Sync failed: ' + failureMessage });
	} finally {
		setSyncRunning(false);
		clearSyncCancel();   // never let this run's cancel bleed into the next sync
	}
});

// Ask the running sync to stop. Cooperative: the sync loop checks the flag between emails and ends as
// 'cancelled', keeping everything it already saved. 409 when nothing is running, so the button can't set a
// flag that a later, unrelated sync would then honour.
router.post('/sync/cancel', requireAuth, (_req: Request, res: Response) => {
	if (!isSyncRunning()) {
		res.status(409).json({ error: 'No sync is running.' });
		return;
	}
	requestSyncCancel();
	res.json({ cancelling: true });
});

// Lets a browser that reconnects mid-sync (a tab closed and reopened) restore its progress bar: the /sync
// progress stream belongs to the one request that started the sync, so a fresh page load polls this instead.
// `running` says whether a sync is live right now; `event` is the latest snapshot (start/warming/progress/
// done/error). The client only resumes its bar when running is true, so a stale 'done' from an earlier sync
// is ignored on a cold open.
router.get('/sync/status', requireAuth, (_req: Request, res: Response) => {
	res.json({ running: isSyncRunning(), event: getLastSyncEvent() });
});

export default router;
