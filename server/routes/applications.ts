import { Router } from 'express';
import type { Request, Response } from 'express';
import * as db from '../services/db';
import { isSyncRunning, setImportRunning } from '../services/syncState';
import { errMsg } from '../utils';
import type { Status, InterviewStep, Source, EmailRef, CreateApplicationData } from '../types';

const VALID_STATUSES    = new Set<string>(['applied', 'interview', 'offer', 'rejected']);
const VALID_STEPS       = new Set<string>(['phone_screen', 'technical', 'onsite', 'final']);
// User-creatable sources. 'gmail' is reserved for the sync pipeline and can't be set via this route.
const VALID_SOURCES     = new Set<string>(['manual', 'csv']);

const router = Router();

// Coerce user-supplied email refs (manual attach / CSV import) into well-formed EmailRefs: each needs a
// non-empty messageId and a valid stage; date defaults to ''. Drops anything malformed or a duplicate
// messageId (dupes would collide on the client's React key and make removal ambiguous).
function sanitizeEmails(raw: unknown): EmailRef[] {
	if (!Array.isArray(raw)) return [];
	const seen = new Set<string>();
	return raw.flatMap((e): EmailRef[] => {
		const messageId = typeof e?.messageId === 'string' ? e.messageId.trim() : '';
		const category  = e?.category;
		if (!messageId || seen.has(messageId) || !VALID_STATUSES.has(category)) return [];
		seen.add(messageId);
		return [{
			messageId,
			category: category as EmailRef['category'],
			date:    typeof e?.date === 'string' ? e.date : '',
			fast_apply: e?.fast_apply === true,
		}];
	});
}

router.get('/', async (req: Request, res: Response) => {
	try {
		// Coerce query params explicitly — Express parses repeated params as arrays,
		// and the cast to Record<string,string> does not coerce them at runtime.
		const { search, status } = req.query;
		const apps = await db.getAll({
			search: typeof search === 'string' ? search : undefined,
			status: typeof status === 'string' && VALID_STATUSES.has(status) ? status as Status : undefined,
		});
		res.json(apps);
	} catch (err) {
		res.status(500).json({ error: errMsg(err, 'Failed to fetch applications') });
	}
});

// Coerce a create body (POST, or one import-plan create) into CreateApplicationData + sanitized email
// refs. Returns an error string instead when the body can't make a valid application.
function buildCreateData(body: Record<string, unknown>): { data: CreateApplicationData; incomingEmailRefs: EmailRef[] } | { error: string } {
	const { company, role, status, interview_step, date_applied, last_activity, job_url, notes, reached_interview, source, company_domain, external_id, account, emails } = body as {
		company?: string;
		role?: string;
		status?: Status;
		interview_step?: InterviewStep;
		date_applied?: string;
		last_activity?: string;
		job_url?: string;
		notes?: string;
		reached_interview?: boolean;
		source?: string;
		company_domain?: string;
		external_id?: string;
		account?: string;
		emails?: unknown;
	};

	if (!company || !role) return { error: 'company and role are required' };

	// Reaching an interview is incompatible with an "applied" status — promote it (an interviewed
	// app is at least at the interview stage). Interview/offer already imply reached.
	const reached = reached_interview === true || status === 'interview' || status === 'offer';
	const finalStatus = (reached && (!status || status === 'applied')) ? 'interview' : (status || 'applied');
	const incomingEmailRefs = sanitizeEmails(emails);
	return {
		incomingEmailRefs,
		data: {
			company,
			role,
			status: finalStatus,
			interview_step: interview_step || null,
			reached_interview: reached,
			date_applied: date_applied || null,
			last_activity: last_activity || null,
			last_activity_ts: last_activity ? Date.parse(last_activity) || 0 : 0,
			job_url: job_url || null,
			notes: notes || null,
			notes_source: 'manual',
			// Dedup keys from a re-imported export (so the next sync re-merges instead of duplicating);
			// null for manual entry or a hand-made CSV.
			external_id: external_id || null,
			company_domain: company_domain || null,
			source: source && VALID_SOURCES.has(source) ? source as Source : 'manual',
			gmail_thread_id: null,
			account: account?.trim() || null,
			emails: incomingEmailRefs,
		},
	};
}

router.post('/', async (req: Request, res: Response) => {
	try {
		const builtCreate = buildCreateData(req.body as Record<string, unknown>);
		if ('error' in builtCreate) {
			res.status(400).json({ error: builtCreate.error });
			return;
		}
		const app = await db.create(builtCreate.data);
		// Emails the board now tracks need no re-processing — mark them synced so the next Gmail sync
		// skips them up front instead of re-downloading and re-classifying (a CSV import re-creating a
		// board would otherwise trigger a full sync).
		await db.markEmailRefsSynced(builtCreate.incomingEmailRefs);
		res.status(201).json(app);
	} catch (err) {
		res.status(500).json({ error: errMsg(err, 'Failed to create application') });
	}
});

// Coerce an update body (PATCH, or one import-plan update) into whitelisted column updates + sanitized
// email refs. Returns an error string instead when a value fails validation.
function buildUpdatePayload(body: Record<string, unknown>): { updates: Record<string, unknown>; incomingEmailRefs: EmailRef[] | null } | { error: string } {
	const allowed = ['company', 'role', 'status', 'interview_step', 'reached_interview', 'date_applied', 'last_activity', 'job_url', 'external_id', 'notes', 'account'] as const;
	const updates: Record<string, unknown> = {};
	for (const key of allowed) {
		if (body[key] !== undefined) updates[key] = body[key];
	}
	// `account` is a free-text email — normalize "" to null so clearing it stores null, not an empty string.
	if ('account' in updates) updates.account = (updates.account as string)?.trim() || null;
	// `emails` is a user-editable array — sanitize each ref rather than trusting the raw body.
	// Kept aside so a successful update can mark the refs synced (same reasoning as in POST).
	let incomingEmailRefs: EmailRef[] | null = null;
	if (body.emails !== undefined) {
		incomingEmailRefs = sanitizeEmails(body.emails);
		updates.emails = incomingEmailRefs;
	}
	if ('status' in updates && !VALID_STATUSES.has(updates.status as string)) return { error: 'Invalid status value' };
	if ('interview_step' in updates && updates.interview_step !== null && !VALID_STEPS.has(updates.interview_step as string)) return { error: 'Invalid interview_step value' };
	// A user-edited note is authoritative — flag it so future syncs never overwrite it.
	if ('notes' in updates) updates.notes_source = 'manual';
	// The user reviewed/edited the details (the edit form sends company/role) → drop the
	// "auto-detected" tag. A bare status-only change (e.g. a board drag) is not a detail edit.
	if ('company' in updates || 'role' in updates) updates.edited = true;
	// Interview/offer status implies the app has interviewed — enforce the sticky flag.
	if (updates.status === 'interview' || updates.status === 'offer') updates.reached_interview = true;
	// Keep the precise ordering key in sync with a manually-edited last_activity date.
	if ('last_activity' in updates) updates.last_activity_ts = updates.last_activity ? Date.parse(updates.last_activity as string) || 0 : 0;
	return { updates, incomingEmailRefs };
}

router.patch('/:id', async (req: Request<{ id: string }>, res: Response) => {
	try {
		const builtUpdate = buildUpdatePayload(req.body as Record<string, unknown>);
		if ('error' in builtUpdate) {
			res.status(400).json({ error: builtUpdate.error });
			return;
		}
		const updated = await db.update(req.params.id, builtUpdate.updates);
		// Mark AFTER the update succeeds — a failed write must not leave its emails flagged as synced.
		if (builtUpdate.incomingEmailRefs) await db.markEmailRefsSynced(builtUpdate.incomingEmailRefs);
		res.json(updated);
	} catch (err) {
		const msg = errMsg(err, 'Failed to update application');
		res.status(msg === 'Not found' ? 404 : 500).json({ error: msg });
	}
});

// A well-formed SQLite application id: positive integer, no leading zero (docs/csv-reimport-spec.md).
const APPLICATION_ID_RE = /^[1-9]\d*$/;

// Apply a reconciled CSV import plan in ONE transaction (docs/csv-reimport-spec.md). The client builds
// the plan from the parsed file and the board; this endpoint re-sanitizes every piece with the same
// rules as POST/PATCH and hands the whole thing to db.applyImportPlan. All-or-nothing: any invalid
// piece rejects the request before a single write happens.
router.post('/import', async (req: Request, res: Response) => {
	// Sync and import are mutually exclusive — applying a plan mid-sync would act on state the sync is
	// still changing (and would invalidate the plan the user just confirmed).
	if (isSyncRunning()) {
		res.status(409).json({ error: 'A Gmail sync is running — wait for it to finish, then import again.' });
		return;
	}
	setImportRunning(true);
	try {
		const body = req.body as { creates?: unknown; updates?: unknown; strips?: unknown; deletes?: unknown; syncEmails?: unknown };
		const rawCreates = (Array.isArray(body.creates) ? body.creates : []) as { preservedId?: unknown; data?: unknown }[];
		const rawUpdates = (Array.isArray(body.updates) ? body.updates : []) as { id?: unknown; changes?: unknown; adoptId?: unknown }[];
		const rawStrips = (Array.isArray(body.strips) ? body.strips : []) as { id?: unknown; messageIds?: unknown }[];
		const rawDeletes = Array.isArray(body.deletes) ? body.deletes : [];

		const plan: db.ImportPlanPayload = { creates: [], updates: [], strips: [], deletes: [], syncEmails: sanitizeEmails(body.syncEmails) };
		for (const rawCreate of rawCreates) {
			const builtCreate = buildCreateData((rawCreate.data ?? {}) as Record<string, unknown>);
			if ('error' in builtCreate) { res.status(400).json({ error: builtCreate.error }); return; }
			const preservedId = typeof rawCreate.preservedId === 'string' && APPLICATION_ID_RE.test(rawCreate.preservedId) ? rawCreate.preservedId : null;
			plan.creates.push({ preservedId, data: builtCreate.data });
		}
		for (const rawUpdate of rawUpdates) {
			if (typeof rawUpdate.id !== 'string' || !APPLICATION_ID_RE.test(rawUpdate.id)) {
				res.status(400).json({ error: 'Each update needs a valid application id' });
				return;
			}
			const builtUpdate = buildUpdatePayload((rawUpdate.changes ?? {}) as Record<string, unknown>);
			if ('error' in builtUpdate) { res.status(400).json({ error: builtUpdate.error }); return; }
			const adoptId = typeof rawUpdate.adoptId === 'string' && APPLICATION_ID_RE.test(rawUpdate.adoptId) ? rawUpdate.adoptId : null;
			plan.updates.push({ id: rawUpdate.id, changes: builtUpdate.updates, adoptId });
		}
		for (const rawStrip of rawStrips) {
			if (typeof rawStrip.id !== 'string' || !APPLICATION_ID_RE.test(rawStrip.id)) continue;
			const messageIds = (Array.isArray(rawStrip.messageIds) ? rawStrip.messageIds : [])
				.filter((messageId): messageId is string => typeof messageId === 'string' && messageId.length > 0);
			if (messageIds.length > 0) plan.strips.push({ id: rawStrip.id, messageIds });
		}
		plan.deletes = rawDeletes.filter((deleteId): deleteId is string => typeof deleteId === 'string' && APPLICATION_ID_RE.test(deleteId));

		res.json(await db.applyImportPlan(plan));
	} catch (err) {
		res.status(500).json({ error: errMsg(err, 'Failed to apply the import') });
	} finally {
		setImportRunning(false);
	}
});

// Wipe the entire database (applications + synced-email log).
// Placed before /:id so Express doesn't interpret "all" as an id.
router.delete('/all', async (_req: Request, res: Response) => {
	try {
		const counts = await db.clearAll();
		res.json({ success: true, ...counts });
	} catch (err) {
		res.status(500).json({ error: errMsg(err, 'Failed to reset database') });
	}
});

router.delete('/:id', async (req: Request<{ id: string }>, res: Response) => {
	try {
		const deleted = await db.remove(req.params.id);
		if (!deleted) { res.status(404).json({ error: 'Not found' }); return; }
		res.status(204).send();
	} catch (err) {
		res.status(500).json({ error: errMsg(err, 'Failed to delete application') });
	}
});

export default router;
