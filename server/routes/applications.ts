import { Router } from 'express';
import type { Request, Response } from 'express';
import * as db from '../services/db';
import { errMsg } from '../utils';
import type { Status, InterviewStep, Source, EmailRef } from '../types';

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

router.post('/', async (req: Request, res: Response) => {
	try {
		const { company, role, status, interview_step, date_applied, last_activity, job_url, notes, reached_interview, source, company_domain, external_id, account, emails } = req.body as {
			company: string;
			role: string;
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

		if (!company || !role) {
			res.status(400).json({ error: 'company and role are required' });
			return;
		}

		// Reaching an interview is incompatible with an "applied" status — promote it (an interviewed
		// app is at least at the interview stage). Interview/offer already imply reached, below.
		const reached = reached_interview === true || status === 'interview' || status === 'offer';
		const finalStatus = (reached && (!status || status === 'applied')) ? 'interview' : (status || 'applied');
		const app = await db.create({
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
			emails: sanitizeEmails(emails),
		});
		res.status(201).json(app);
	} catch (err) {
		res.status(500).json({ error: errMsg(err, 'Failed to create application') });
	}
});

router.patch('/:id', async (req: Request<{ id: string }>, res: Response) => {
	try {
		const { id } = req.params;
		const allowed = ['company', 'role', 'status', 'interview_step', 'reached_interview', 'date_applied', 'last_activity', 'job_url', 'external_id', 'notes', 'account'] as const;
		const updates: Record<string, unknown> = {};
		for (const key of allowed) {
			if ((req.body as Record<string, unknown>)[key] !== undefined) {
				updates[key] = (req.body as Record<string, unknown>)[key];
			}
		}
		// `account` is a free-text email — normalize "" to null so clearing it stores null, not an empty string.
		if ('account' in updates) updates.account = (updates.account as string)?.trim() || null;
		// `emails` is a user-editable array — sanitize each ref rather than trusting the raw body.
		if ((req.body as Record<string, unknown>).emails !== undefined) updates.emails = sanitizeEmails((req.body as Record<string, unknown>).emails);
		if ('status' in updates && !VALID_STATUSES.has(updates.status as string)) {
			res.status(400).json({ error: 'Invalid status value' });
			return;
		}
		if ('interview_step' in updates && updates.interview_step !== null && !VALID_STEPS.has(updates.interview_step as string)) {
			res.status(400).json({ error: 'Invalid interview_step value' });
			return;
		}
		// A user-edited note is authoritative — flag it so future syncs never overwrite it.
		if ('notes' in updates) updates.notes_source = 'manual';
		// The user reviewed/edited the details (the edit form sends company/role) → drop the
		// "auto-detected" tag. A bare status-only change (e.g. a board drag) is not a detail edit.
		if ('company' in updates || 'role' in updates) updates.edited = true;
		// Interview/offer status implies the app has interviewed — enforce the sticky flag.
		if (updates.status === 'interview' || updates.status === 'offer') updates.reached_interview = true;
		// Keep the precise ordering key in sync with a manually-edited last_activity date.
		if ('last_activity' in updates) updates.last_activity_ts = updates.last_activity ? Date.parse(updates.last_activity as string) || 0 : 0;
		const updated = await db.update(id, updates);
		res.json(updated);
	} catch (err) {
		const msg = errMsg(err, 'Failed to update application');
		res.status(msg === 'Not found' ? 404 : 500).json({ error: msg });
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
