import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import applicationsRouter from './applications';
import * as db from '../services/db';
import { setSyncRunning } from '../services/syncState';

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

const postImport = (body: Record<string, unknown>) =>
	fetch(`${baseUrl}/api/applications/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// A saved application with sensible defaults — override only what a test cares about.
const seed = (overrides: Partial<Parameters<typeof db.create>[0]> = {}) =>
	db.create({
		company: 'Acme', role: 'SWE', status: 'applied', interview_step: null,
		date_applied: '2026-06-01', last_activity: null, job_url: null, notes: null,
		source: 'csv', gmail_thread_id: null, ...overrides,
	});

describe('POST /applications/import', () => {
	it('should apply a whole plan — create, update, strip, delete, and sync-marking — in one call', async () => {
		const target = await seed();
		const absorbed = await seed({ company: 'Acme Dup', source: 'gmail', emails: [{ messageId: 'm-moved', category: 'rejected', date: '2026-06-10' }] });
		const response = await postImport({
			creates: [{ preservedId: '4210', data: { company: 'NewCo', role: 'DS', source: 'csv', emails: [{ messageId: 'm-new', category: 'applied', date: '2026-06-15' }] } }],
			updates: [{ id: target.id, changes: { status: 'rejected', emails: [{ messageId: 'm-moved', category: 'rejected', date: '2026-06-10' }] }, adoptId: null }],
			strips: [{ id: absorbed.id, messageIds: ['m-moved'] }],
			deletes: [absorbed.id],
			syncEmails: [{ messageId: 'm-moved', category: 'rejected', date: '2026-06-10' }, { messageId: 'm-new', category: 'applied', date: '2026-06-15' }],
		});
		expect(response.status).toBe(200);
		const result = await response.json() as { added: number; updated: number; deleted: number; createdIds: string[] };
		expect(result).toMatchObject({ added: 1, updated: 1, deleted: 1 });
		expect(result.createdIds).toEqual(['4210']);

		const board = await db.getAll();
		expect(board.find(application => application.id === absorbed.id)).toBeUndefined();
		expect(board.find(application => application.id === target.id)?.emails.map(email => email.messageId)).toEqual(['m-moved']);
		expect(await db.getSyncedMessageIds(['m-moved', 'm-new'])).toEqual(new Set(['m-moved', 'm-new']));
	});

	it('should refuse to run while a Gmail sync is running (mutual exclusion)', async () => {
		setSyncRunning(true);
		try {
			const response = await postImport({ creates: [], updates: [], strips: [], deletes: [], syncEmails: [] });
			expect(response.status).toBe(409);
		} finally {
			setSyncRunning(false);
		}
	});

	it('should reject the whole plan (400, nothing written) when a create is invalid', async () => {
		const response = await postImport({
			creates: [
				{ preservedId: null, data: { company: 'Valid Co', role: 'SWE' } },
				{ preservedId: null, data: { role: 'missing company' } },
			],
			updates: [], strips: [], deletes: [], syncEmails: [],
		});
		expect(response.status).toBe(400);
		expect((await db.getAll()).length).toBe(0);   // all-or-nothing: the valid create must not slip through
	});

	it('should treat a malformed preservedId as no id instead of failing', async () => {
		const response = await postImport({
			creates: [{ preservedId: 'DROP TABLE', data: { company: 'Safe Co', role: 'SWE' } }],
			updates: [], strips: [], deletes: [], syncEmails: [],
		});
		expect(response.status).toBe(200);
		const [created] = await db.getAll();
		expect(created.company).toBe('Safe Co');
		expect(/^[1-9]\d*$/.test(created.id)).toBe(true);   // ordinary autoincrement id
	});

	it('should reject an update whose changes fail validation, leaving the board untouched', async () => {
		const target = await seed({ date_applied: null });
		const response = await postImport({
			creates: [], strips: [], deletes: [], syncEmails: [],
			updates: [{ id: target.id, changes: { status: 'not-a-status' }, adoptId: null }],
		});
		expect(response.status).toBe(400);
		expect((await db.getAll())[0].status).toBe('applied');
	});
});
