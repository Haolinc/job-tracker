import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import applicationsRouter from './applications';
import * as db from '../services/db';

// Real in-memory database — the routes' db side effects (like marking imported emails synced) are the
// behavior under test, so nothing is mocked.
process.env.DB_PATH = ':memory:';
db.initializeDatabase();

let httpServer: Server;
let baseUrl: string;

beforeAll(async () => {
	const app = express();
	app.use(express.json());
	app.use('/api/applications', applicationsRouter);
	await new Promise<void>((resolve) => { httpServer = app.listen(0, '127.0.0.1', () => resolve()); });
	baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
	await new Promise((resolve) => httpServer.close(resolve));
});

beforeEach(async () => { await db.clearAll(); });

const postApplication = (body: Record<string, unknown>) =>
	fetch(`${baseUrl}/api/applications`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('POST /applications', () => {
	it('should mark imported email refs as synced so the next Gmail sync skips them', async () => {
		const response = await postApplication({
			company: 'Acme', role: 'SWE', source: 'csv',
			emails: [
				{ messageId: 'csv-msg-1', category: 'applied', date: '2026-06-01' },
				{ messageId: 'csv-msg-2', category: 'interview', date: '2026-06-05' },
			],
		});
		expect(response.status).toBe(201);
		const synced = await db.getSyncedMessageIds(['csv-msg-1', 'csv-msg-2']);
		expect(synced).toEqual(new Set(['csv-msg-1', 'csv-msg-2']));
	});

	it('should not touch the synced-email log when the row carries no emails', async () => {
		const response = await postApplication({ company: 'Acme', role: 'SWE' });
		expect(response.status).toBe(201);
		expect((await db.getSyncedMessageIds(['csv-msg-1'])).size).toBe(0);
	});
});

describe('PATCH /applications/:id', () => {
	it('should mark email refs written through an update as synced', async () => {
		const created = await (await postApplication({ company: 'Acme', role: 'SWE' })).json() as { id: string };
		const response = await fetch(`${baseUrl}/api/applications/${created.id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ emails: [{ messageId: 'patched-msg-1', category: 'applied', date: '2026-06-02' }] }),
		});
		expect(response.status).toBe(200);
		expect((await db.getSyncedMessageIds(['patched-msg-1'])).has('patched-msg-1')).toBe(true);
	});
});
