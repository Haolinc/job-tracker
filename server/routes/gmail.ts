import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { fetchJobEmails } from '../services/gmailService';
import { classifyEmail } from '../services/classifier';
import * as db from '../services/db';
import { errMsg } from '../utils';

const router = Router();

router.post('/sync', requireAuth, async (req: Request, res: Response) => {
	try {
		const emails = await fetchJobEmails(req.session.tokens!);
		const syncedIds = await db.getSyncedThreadIds(emails.map(e => e.threadId));
		let added = 0, updated = 0, skipped = 0;

		for (const email of emails) {
			if (syncedIds.has(email.threadId)) { skipped++; continue; }

			let classification;
			try {
				classification = await classifyEmail(email.subject, email.from, email.body);
			} catch {
				skipped++;
				continue;
			}

			const { category, company, role, confidence } = classification;

			// Ignore newsletters, cold outreach, and emails where we can't even identify
			// the company (confidence < 0.5 means even the category is uncertain).
			if (category === 'ignored' || confidence < 0.5 || !company) {
				await db.markEmailSynced({ thread_id: email.threadId, message_id: email.messageId, classified_as: 'ignored' });
				skipped++;
				continue;
			}

			const existing = role ? await db.findByCompanyRole(company, role) : undefined;

			if (existing) {
				await db.update(existing.id, {
					status: category === 'applied' ? existing.status : category,
					last_activity: email.lastMessageDate,
				});
				updated++;
			} else {
				const resolvedRole = role || 'Unknown Role';
				const notes = role
					? `Auto-detected from Gmail: ${email.subject}`
					: `Auto-detected from Gmail: ${email.subject}\n⚠️ Role could not be extracted — please update manually.`;
				await db.create({
					company,
					role: resolvedRole,
					status: category,
					interview_step: null,
					date_applied: email.lastMessageDate,
					last_activity: email.lastMessageDate,
					job_url: null,
					notes,
					source: 'gmail',
					gmail_thread_id: email.threadId,
				});
				added++;
			}

			await db.markEmailSynced({ thread_id: email.threadId, message_id: email.messageId, classified_as: category });
		}

		res.json({ added, updated, skipped });
	} catch (err) {
		console.error('Sync error:', err);
		res.status(500).json({ error: 'Sync failed: ' + errMsg(err, 'Unknown error') });
	}
});


export default router;
