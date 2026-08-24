import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import authRouter from './auth';
import { setSyncRunning } from '../services/syncState';
import { getAccountEmail } from '../services/gmail/messages';

// The address lookup is a real Gmail call — stub it so /status can be exercised without a mailbox.
vi.mock('../services/gmail/messages', () => ({ getAccountEmail: vi.fn() }));
const getAccountEmailMock = vi.mocked(getAccountEmail);

// Real HTTP round-trips against the mounted router. No session middleware is installed, so
// req.session is undefined and the disconnect success path never reaches Google token revocation.
let httpServer: Server;
let baseUrl: string;

// A second app whose fake session middleware carries tokens, so /status takes its connected path. The
// session object is module-level: the tests read it back to assert the address was cached onto it.
let sessionServer: Server;
let sessionBaseUrl: string;
let fakeSession: { tokens: unknown; accountEmail: string | null };

beforeAll(async () => {
	const app = express();
	app.use('/api/auth', authRouter);
	await new Promise<void>((resolve) => { httpServer = app.listen(0, '127.0.0.1', () => resolve()); });
	baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

	const sessionApp = express();
	sessionApp.use((req, _res, next) => { (req as unknown as { session: unknown }).session = fakeSession; next(); });
	sessionApp.use('/api/auth', authRouter);
	await new Promise<void>((resolve) => { sessionServer = sessionApp.listen(0, '127.0.0.1', () => resolve()); });
	sessionBaseUrl = `http://127.0.0.1:${(sessionServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
	await new Promise((resolve) => httpServer.close(resolve));
	await new Promise((resolve) => sessionServer.close(resolve));
});

beforeEach(() => {
	setSyncRunning(false);
	getAccountEmailMock.mockReset();
	fakeSession = { tokens: { access_token: 'token' }, accountEmail: null };
});

describe('GET /api/auth/status', () => {
	it('should report a disconnected session with no address', async () => {
		const response = await fetch(`${baseUrl}/api/auth/status`);   // no session middleware at all
		expect(await response.json()).toEqual({ connected: false, email: null });
	});

	it('should report the connected address and cache it on the session', async () => {
		getAccountEmailMock.mockResolvedValue('jane@gmail.com');
		const response = await fetch(`${sessionBaseUrl}/api/auth/status`);
		expect(await response.json()).toEqual({ connected: true, email: 'jane@gmail.com' });
		expect(fakeSession.accountEmail).toBe('jane@gmail.com');
	});

	it('should serve a cached address without asking Gmail again', async () => {
		fakeSession.accountEmail = 'cached@gmail.com';
		const response = await fetch(`${sessionBaseUrl}/api/auth/status`);
		expect(await response.json()).toEqual({ connected: true, email: 'cached@gmail.com' });
		expect(getAccountEmailMock).not.toHaveBeenCalled();
	});

	it('should still report the connection when the address lookup fails', async () => {
		// getAccountEmail swallows Gmail errors and returns null — a nameless badge beats a broken one.
		getAccountEmailMock.mockResolvedValue(null);
		const response = await fetch(`${sessionBaseUrl}/api/auth/status`);
		expect(await response.json()).toEqual({ connected: true, email: null });
	});
});

describe('POST /api/auth/disconnect', () => {
	it('should refuse with 409 while a sync is running', async () => {
		// Disconnecting would revoke the tokens the running sync is using mid-flight.
		setSyncRunning(true);
		const response = await fetch(`${baseUrl}/api/auth/disconnect`, { method: 'POST' });
		expect(response.status).toBe(409);
		const body = await response.json() as { error: string };
		expect(body.error).toContain('sync is in progress');
	});

	it('should disconnect normally when no sync is running', async () => {
		const response = await fetch(`${baseUrl}/api/auth/disconnect`, { method: 'POST' });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ success: true });
	});

	it('should disconnect again once the sync has finished', async () => {
		setSyncRunning(true);
		setSyncRunning(false);   // the sync route's finally block clears the flag the same way
		const response = await fetch(`${baseUrl}/api/auth/disconnect`, { method: 'POST' });
		expect(response.status).toBe(200);
	});
});
