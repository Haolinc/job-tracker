import { Router } from 'express';
import type { Request, Response } from 'express';
import * as db from '../services/db';
import type { Status, Priority } from '../types';

const router = Router();

router.get('/', (req: Request, res: Response) => {
	const apps = db.getAll(req.query as Record<string, string>);
	res.json(apps);
});

router.post('/', (req: Request, res: Response) => {
	const { company, role, status, priority, date_applied, job_url, notes } = req.body as {
		company: string;
		role: string;
		status?: Status;
		priority?: Priority;
		date_applied?: string;
		job_url?: string;
		notes?: string;
	};

	if (!company || !role) {
		res.status(400).json({ error: 'company and role are required' });
		return;
	}

	const app = db.create({
		company,
		role,
		status: status || 'wishlist',
		priority: priority || 'medium',
		date_applied: date_applied || null,
		job_url: job_url || null,
		notes: notes || null,
		source: 'manual',
		gmail_thread_id: null,
	});
	res.status(201).json(app);
});

router.patch('/:id', (req: Request<{ id: string }>, res: Response) => {
	const { id } = req.params;
	const existing = db.getById(id);
	if (!existing) {
		res.status(404).json({ error: 'Not found' });
		return;
	}

	const allowed = ['company', 'role', 'status', 'priority', 'date_applied', 'job_url', 'notes'] as const;
	const updates: Record<string, unknown> = {};
	for (const key of allowed) {
		if ((req.body as Record<string, unknown>)[key] !== undefined) {
			updates[key] = (req.body as Record<string, unknown>)[key];
		}
	}

	const updated = db.update(id, updates);
	res.json(updated);
});

router.delete('/:id', (req: Request<{ id: string }>, res: Response) => {
	const { id } = req.params;
	const existing = db.getById(id);
	if (!existing) {
		res.status(404).json({ error: 'Not found' });
		return;
	}
	db.remove(id);
	res.status(204).send();
});

export default router;
