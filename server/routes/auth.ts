import { Router } from 'express';
import type { Request, Response } from 'express';
import { getAuthUrl, exchangeCode, revokeTokens } from '../services/gmail/oauth';

const router = Router();

router.get('/google', (_req: Request, res: Response) => {
	res.redirect(getAuthUrl());
});

router.get('/google/callback', async (req: Request, res: Response) => {
	const { code } = req.query;
	if (!code || typeof code !== 'string') {
		// User cancelled the OAuth flow or the redirect is missing the code param
		res.redirect(`${process.env.CLIENT_URL}?gmail=error`);
		return;
	}
	try {
		const tokens = await exchangeCode(code);
		req.session.tokens = tokens;
		// Explicitly save before redirecting — MongoStore saves asynchronously, and the
		// browser may follow the redirect before the session is persisted, causing a
		// phantom "not connected" state on the very next request.
		req.session.save((err) => {
			if (err) {
				console.error('Session save error:', err);
				res.redirect(`${process.env.CLIENT_URL}?gmail=error`);
			} else {
				res.redirect(`${process.env.CLIENT_URL}?gmail=connected`);
			}
		});
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
