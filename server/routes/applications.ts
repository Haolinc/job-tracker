import { Router } from 'express';
import type { Request, Response } from 'express';
import * as db from '../services/db';
import { errMsg } from '../utils';
import type { Status, InterviewStep } from '../types';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
	try {
		// Coerce query params explicitly — Express parses repeated params as arrays,
		// and the cast to Record<string,string> does not coerce them at runtime.
		const { search, status } = req.query;
		const apps = await db.getAll({
			search: typeof search === 'string' ? search : undefined,
			status: typeof status === 'string' ? status : undefined,
		});
		res.json(apps);
	} catch (err) {
		res.status(500).json({ error: errMsg(err, 'Failed to fetch applications') });
	}
});

router.post('/', async (req: Request, res: Response) => {
	try {
		const { company, role, status, interview_step, date_applied, last_activity, job_url, notes } = req.body as {
			company: string;
			role: string;
			status?: Status;
			interview_step?: InterviewStep;
			date_applied?: string;
			last_activity?: string;
			job_url?: string;
			notes?: string;
		};

		if (!company || !role) {
			res.status(400).json({ error: 'company and role are required' });
			return;
		}

		const app = await db.create({
			company,
			role,
			status: status || 'applied',
			interview_step: interview_step || null,
			date_applied: date_applied || null,
			last_activity: last_activity || null,
			job_url: job_url || null,
			notes: notes || null,
			source: 'manual',
			gmail_thread_id: null,
		});
		res.status(201).json(app);
	} catch (err) {
		res.status(500).json({ error: errMsg(err, 'Failed to create application') });
	}
});

router.patch('/:id', async (req: Request<{ id: string }>, res: Response) => {
	try {
		const { id } = req.params;
		const allowed = ['company', 'role', 'status', 'interview_step', 'date_applied', 'last_activity', 'job_url', 'notes'] as const;
		const updates: Record<string, unknown> = {};
		for (const key of allowed) {
			if ((req.body as Record<string, unknown>)[key] !== undefined) {
				updates[key] = (req.body as Record<string, unknown>)[key];
			}
		}
		const updated = await db.update(id, updates);
		res.json(updated);
	} catch (err) {
		const msg = errMsg(err, 'Failed to update application');
		res.status(msg === 'Not found' ? 404 : 500).json({ error: msg });
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
