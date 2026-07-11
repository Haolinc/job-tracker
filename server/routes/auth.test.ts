import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import authRouter from './auth';
import { setSyncRunning } from '../services/syncState';

// Real HTTP round-trips against the mounted router. No session middleware is installed, so
// req.session is undefined and the disconnect success path never reaches Google token revocation.
let httpServer: Server;
let baseUrl: string;

beforeAll(async () => {
	const app = express();
	app.use('/api/auth', authRouter);
	await new Promise<void>((resolve) => { httpServer = app.listen(0, '127.0.0.1', () => resolve()); });
	baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
	await new Promise((resolve) => httpServer.close(resolve));
});

beforeEach(() => {
	setSyncRunning(false);
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
