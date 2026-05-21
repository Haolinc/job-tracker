import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { fetchJobEmails } from '../services/gmailService';
import { classifyEmail } from '../services/classifier';
import * as db from '../services/db';

const router = Router();

router.post('/sync', requireAuth, async (req: Request, res: Response) => {
	try {
		const emails = await fetchJobEmails(req.session.tokens!);
		let added = 0, updated = 0, skipped = 0;

		for (const email of emails) {
			if (db.isEmailSynced(email.threadId)) { skipped++; continue; }

			let classification;
			try {
				classification = await classifyEmail(email.subject, email.snippet);
			} catch {
				skipped++;
				continue;
			}

			const { category, company, role, confidence } = classification;

			if (category === 'ignored' || confidence < 0.6 || !company) {
				db.markEmailSynced({ thread_id: email.threadId, message_id: email.messageId, classified_as: 'ignored' });
				skipped++;
				continue;
			}

			const existing = role ? db.findByCompanyRole(company, role) : undefined;

			if (existing) {
				db.update(existing.id, {
					status: category === 'applied' ? existing.status : category,
					last_activity: email.lastMessageDate,
				});
				updated++;
			} else {
				db.create({
					company,
					role: role || 'Unknown Role',
					status: category,
					interview_step: null,
					date_applied: email.lastMessageDate,
					last_activity: email.lastMessageDate,
					job_url: null,
					notes: `Auto-detected from Gmail: ${email.subject}`,
					source: 'gmail',
					gmail_thread_id: email.threadId,
				});
				added++;
			}

			db.markEmailSynced({ thread_id: email.threadId, message_id: email.messageId, classified_as: category });
		}

		db.addSyncRecord({ added, updated, skipped });
		res.json({ added, updated, skipped });
	} catch (err) {
		console.error('Sync error:', err);
		res.status(500).json({ error: 'Sync failed: ' + (err instanceof Error ? err.message : String(err)) });
	}
});

router.get('/sync/history', (_req: Request, res: Response) => {
	res.json(db.getSyncHistory());
});

export default router;
