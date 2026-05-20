import { Router } from 'express';
import type { Request, Response } from 'express';
import { getAuthUrl, exchangeCode, revokeTokens } from '../services/gmailService';

const router = Router();

router.get('/google', (_req: Request, res: Response) => {
	res.redirect(getAuthUrl());
});

router.get('/google/callback', async (req: Request, res: Response) => {
	try {
		const tokens = await exchangeCode(req.query.code as string);
		req.session.tokens = tokens;
		res.redirect(`${process.env.CLIENT_URL}?gmail=connected`);
	} catch (err) {
		console.error('OAuth callback error:', err);
		res.redirect(`${process.env.CLIENT_URL}?gmail=error`);
	}
});

router.get('/status', (req: Request, res: Response) => {
	res.json({ connected: !!req.session?.tokens });
});

router.post('/disconnect', async (req: Request, res: Response) => {
	try {
		if (req.session?.tokens) {
			await revokeTokens(req.session.tokens).catch(() => {});
			req.session.tokens = null;
		}
		res.json({ success: true });
	} catch {
		res.status(500).json({ error: 'Disconnect failed' });
	}
});

export default router;
