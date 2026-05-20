import type { Request, Response, NextFunction } from 'express';

function requireAuth(req: Request, res: Response, next: NextFunction): void {
	if (!req.session?.tokens) {
		res.status(401).json({ error: 'Gmail not connected. Please authenticate first.' });
		return;
	}
	next();
}

export { requireAuth };
