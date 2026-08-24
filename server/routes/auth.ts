import { Router } from 'express';
import type { Request, Response } from 'express';
import { getAuthUrl, exchangeCode, revokeTokens } from '../services/gmail/oauth';
import { getAccountEmail } from '../services/gmail/messages';
import { isSyncRunning } from '../services/syncState';

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
		// Drop any address cached for the PREVIOUS connection — this consent may well be a different
		// mailbox, and /status re-reads it from the new tokens on the next check.
		req.session.accountEmail = null;
		// Explicitly save before redirecting — express-session only auto-saves when the response
		// ends, so the browser may follow the redirect before the session is persisted, causing a
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

router.get('/status', async (req: Request, res: Response) => {
	const tokens = req.session?.tokens;
	if (!tokens) {
		res.json({ connected: false, email: null });
		return;
	}
	// The address comes from users.getProfile, which the read-only Gmail scope already covers — no extra
	// consent. Cached on the session because it never changes for a given connection: only the first status
	// check after connecting pays the round-trip. A failed lookup caches nothing, so the next check retries.
	if (!req.session.accountEmail) {
		req.session.accountEmail = await getAccountEmail(tokens);
	}
	res.json({ connected: true, email: req.session.accountEmail ?? null });
});

router.post('/disconnect', async (req: Request, res: Response) => {
	// Disconnecting revokes the very tokens a running sync is using. The web app disables its
	// Disconnect button while syncing, but that only covers the tab that started the sync — this
	// guards every other caller (a second tab, curl).
	if (isSyncRunning()) {
		res.status(409).json({ error: 'A sync is in progress — wait for it to finish before disconnecting.' });
		return;
	}
	try {
		if (req.session?.tokens) {
			await revokeTokens(req.session.tokens).catch(() => {});
			req.session.tokens = null;
			req.session.accountEmail = null;   // the cached address belongs to the connection we just dropped
		}
		res.json({ success: true });
	} catch {
		res.status(500).json({ error: 'Disconnect failed' });
	}
});

export default router;
