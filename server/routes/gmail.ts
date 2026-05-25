import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { fetchJobEmails } from '../services/gmailService';
import { classifyEmail } from '../services/classifier';
import * as db from '../services/db';
import { errMsg } from '../utils';
import type { Application } from '../types';

const router = Router();
const AUTOMATED_SUBJECT = /(^automatic reply|^auto:|^out of office|interview confirmation|interview confirmed|your interview (is|has been) (confirmed|scheduled)|has been scheduled|calendar invite|meeting confirmed|jobs? alert|new jobs? for you|\d+ new jobs?)/i;
const AUTOMATED_FROM    = /calendly\./i;

router.post('/sync', requireAuth, async (req: Request, res: Response) => {
	try {
		const emails = await fetchJobEmails(req.session.tokens!);
		const syncedIds = await db.getSyncedThreadIds(emails.map(e => e.threadId));
		let added = 0, updated = 0, skipped = 0;

		for (const email of emails) {
			if (syncedIds.has(email.threadId)) { skipped++; continue; }

			// Hard-filter automated emails before hitting the classifier
			const autoFiltered = AUTOMATED_SUBJECT.test(email.subject) || AUTOMATED_FROM.test(email.from);
			console.log(`[filter] subject="${email.subject}" from="${email.from}" filtered=${autoFiltered}`);
			if (autoFiltered) {
				await db.markEmailSynced({ thread_id: email.threadId, message_id: email.messageId, classified_as: 'ignored' });
				skipped++;
				continue;
			}

			let classification;
			try {
				classification = await classifyEmail(email.subject, email.from, email.body);
			} catch {
				// Mark synced so this thread is not retried on every subsequent sync.
				// Malformed LLM output (JSON parse error) would otherwise cause infinite re-attempts.
				await db.markEmailSynced({ thread_id: email.threadId, message_id: email.messageId, classified_as: 'ignored' });
				skipped++;
				continue;
			}

			const { category, company, role } = classification;

			// Ignore non-application emails and anything where the company couldn't be identified.
			if (category === 'ignored' || !company) {
				await db.markEmailSynced({ thread_id: email.threadId, message_id: email.messageId, classified_as: 'ignored' });
				skipped++;
				continue;
			}

			// Dedup strategy:
			// 1. Role known → exact company+role match.
			// 2. Role unknown, one app for this company → must be the same one, update it.
			// 3. Role unknown, multiple apps → prefer an existing "Unknown Role" entry over
			//    creating another, since job board emails often omit the role.
			let existing: Application | undefined;
			if (role) {
				existing = await db.findByCompanyRole(company, role);
			} else {
				const matches = await db.findByCompany(company);
				if (matches.length === 1) {
					existing = matches[0];
				} else if (matches.length > 1) {
					existing = matches.find(m => m.role === 'Unknown Role');
				}
			}

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
