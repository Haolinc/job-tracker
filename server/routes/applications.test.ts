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
				{ messageId: 'imported-1', category: 'applied', date: '2026-06-01' },
				{ messageId: 'imported-2', category: 'interview', date: '2026-06-05' },
			],
		});
		expect(response.status).toBe(201);
		const synced = await db.getSyncedMessageIds(['imported-1', 'imported-2']);
		expect(synced).toEqual(new Set(['imported-1', 'imported-2']));
	});

	it('should not touch the synced-email log when the row carries no emails', async () => {
		const response = await postApplication({ company: 'Acme', role: 'SWE' });
		expect(response.status).toBe(201);
		expect((await db.getSyncedMessageIds(['imported-1'])).size).toBe(0);
	});

	// Every UI save and every import crosses this boundary, so an origin dropped here would be lost for good.
	it('should carry each email origin through to storage', async () => {
		const response = await postApplication({
			company: 'Acme', role: 'SWE',
			emails: [
				{ messageId: 'imported-1', category: 'applied',   date: '2026-06-01', origin: 'synced' },
				{ messageId: 'imported-2', category: 'interview', date: '2026-06-05', origin: 'imported' },
				{ messageId: 'patched-1', category: 'offer',     date: '2026-06-09', origin: 'manual' },
			],
		});
		expect(response.status).toBe(201);
		const [stored] = await db.getAll();
		expect(stored.emails.map(emailRef => [emailRef.messageId, emailRef.origin])).toEqual([
			['imported-1', 'synced'],
			['imported-2', 'imported'],
			['patched-1', 'manual'],
		]);
	});

	it('should drop an unrecognized origin instead of storing a tag the UI cannot render', async () => {
		const response = await postApplication({
			company: 'Acme', role: 'SWE',
			emails: [
				{ messageId: 'imported-1', category: 'applied', date: '2026-06-01', origin: 'definitely-not-an-origin' },
				{ messageId: 'imported-2', category: 'applied', date: '2026-06-01', origin: 42 },
			],
		});
		expect(response.status).toBe(201);
		const [stored] = await db.getAll();
		// Left absent rather than coerced — an untagged ref reads as "origin unknown", which is the truth.
		expect(stored.emails.map(emailRef => emailRef.origin)).toEqual([undefined, undefined]);
	});
});

describe('PATCH /applications/:id', () => {
	it('should mark email refs written through an update as synced', async () => {
		const created = await (await postApplication({ company: 'Acme', role: 'SWE' })).json() as { id: string };
		const response = await fetch(`${baseUrl}/api/applications/${created.id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ emails: [{ messageId: 'patched-1', category: 'applied', date: '2026-06-02' }] }),
		});
		expect(response.status).toBe(200);
		expect((await db.getSyncedMessageIds(['patched-1'])).has('patched-1')).toBe(true);
	});

	// Editing a status, a note, a date — anything that is not the email list — must leave every ref exactly
	// as it was. An update that silently re-stamped origins would erase provenance during ordinary editing.
	it('should leave email refs and their origins untouched when only other fields change', async () => {
		const created = await (await postApplication({
			company: 'Acme', role: 'SWE',
			emails: [
				{ messageId: 'imported-1', category: 'applied',   date: '2026-06-01', origin: 'synced' },
				{ messageId: 'imported-2', category: 'interview', date: '2026-06-05', origin: 'manual' },
			],
		})).json() as { id: string };
		const before = (await db.getAll()).find(application => application.id === created.id)!.emails;

		const response = await fetch(`${baseUrl}/api/applications/${created.id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'rejected', notes: 'called back', interview_step: 'onsite' }),
		});
		expect(response.status).toBe(200);

		const after = (await db.getAll()).find(application => application.id === created.id)!;
		expect(after.status).toBe('rejected');      // the edit landed…
		expect(after.notes).toBe('called back');
		expect(after.emails).toEqual(before);       // …and the refs are byte-for-byte what they were
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
		const absorbed = await seed({ company: 'Acme Dup', source: 'gmail', emails: [{ messageId: 'm-absorbed', category: 'rejected', date: '2026-06-10' }] });
		const response = await postImport({
			creates: [{ preservedId: '4210', data: { company: 'NewCo', role: 'DS', source: 'csv', emails: [{ messageId: 'm-created', category: 'applied', date: '2026-06-15' }] } }],
			updates: [{ id: target.id, changes: { status: 'rejected', emails: [{ messageId: 'm-absorbed', category: 'rejected', date: '2026-06-10' }] }, adoptId: null }],
			strips: [{ id: absorbed.id, messageIds: ['m-absorbed'] }],
			deletes: [absorbed.id],
			syncEmails: [{ messageId: 'm-absorbed', category: 'rejected', date: '2026-06-10' }, { messageId: 'm-created', category: 'applied', date: '2026-06-15' }],
		});
		expect(response.status).toBe(200);
		const result = await response.json() as { added: number; updated: number; deleted: number; createdIds: string[] };
		expect(result).toMatchObject({ added: 1, updated: 1, deleted: 1 });
		expect(result.createdIds).toEqual(['4210']);

		const board = await db.getAll();
		expect(board.find(application => application.id === absorbed.id)).toBeUndefined();
		expect(board.find(application => application.id === target.id)?.emails.map(email => email.messageId)).toEqual(['m-absorbed']);
		expect(await db.getSyncedMessageIds(['m-absorbed', 'm-created'])).toEqual(new Set(['m-absorbed', 'm-created']));
	});

	// The client resolves each origin against the board before sending (see buildImportPlan); the server's
	// job is to write those origins through unaltered, on BOTH halves of the plan.
	it('should apply the origins the plan carries to created and updated applications alike', async () => {
		const target = await seed({ emails: [{ messageId: 'm-absorbed', category: 'applied', date: '2026-06-01', origin: 'manual' }] });
		const response = await postImport({
			creates: [{ preservedId: null, data: { company: 'NewCo', role: 'DS', source: 'csv', emails: [{ messageId: 'm-created', category: 'applied', date: '2026-06-15', origin: 'imported' }] } }],
			// The plan re-states the manual ref with its origin intact and adds a newly imported one.
			updates: [{ id: target.id, changes: { emails: [
				{ messageId: 'm-absorbed', category: 'applied', date: '2026-06-01', origin: 'manual' },
				{ messageId: 'm-new', category: 'interview', date: '2026-06-20', origin: 'imported' },
			] }, adoptId: null }],
			strips: [], deletes: [], syncEmails: [],
		});
		expect(response.status).toBe(200);

		const board = await db.getAll();
		expect(board.find(application => application.company === 'NewCo')?.emails.map(email => email.origin)).toEqual(['imported']);
		expect(board.find(application => application.id === target.id)?.emails.map(email => [email.messageId, email.origin])).toEqual([
			['m-absorbed', 'manual'],     // survived the import untouched
			['m-new', 'imported'],
		]);
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
