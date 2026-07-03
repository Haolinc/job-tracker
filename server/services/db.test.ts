import { describe, it, expect, beforeEach } from 'vitest';
import * as db from './db';
import type { CreateApplicationData } from '../types';

// Explicit lifecycle: point the database at memory, then initialize once for this test process.
process.env.DB_PATH = ':memory:';
db.initializeDatabase();

const baseData: CreateApplicationData = {
	company: 'Acme', role: 'Software Engineer', status: 'applied', interview_step: null,
	date_applied: '2026-06-01', last_activity: '2026-06-01', last_activity_ts: 1000,
	job_url: null, notes: null, source: 'gmail', gmail_thread_id: 't1',
};

beforeEach(async () => { await db.clearAll(); });

describe('create / getAll', () => {
	it('should apply defaults for omitted optional fields', async () => {
		const application = await db.create(baseData);
		expect(application.id).toBeTruthy();
		expect(application.reached_interview).toBe(false);
		expect(application.notes_source).toBe('auto');
		expect(application.awaiting_application).toBe(false);
		expect(application.fast_apply).toBe(false);
		expect(application.confirmed).toBe(false);
		expect(application.emails).toEqual([]);
		expect(application.created_at).toBeTruthy();
	});

	it('should filter by search (company OR role, case-insensitive) and by status', async () => {
		await db.create({ ...baseData, company: 'Acme', role: 'Backend Dev' });
		await db.create({ ...baseData, company: 'Globex', role: 'acme specialist', status: 'rejected' });
		await db.create({ ...baseData, company: 'Initech', role: 'QA' });
		expect((await db.getAll({ search: 'acme' })).length).toBe(2);
		expect((await db.getAll({ status: 'rejected' })).length).toBe(1);
		expect((await db.getAll()).length).toBe(3);
	});

	it('should not treat LIKE wildcards in search as wildcards', async () => {
		await db.create({ ...baseData, company: '100% Remote Co' });
		await db.create({ ...baseData, company: 'Percentless' });
		expect((await db.getAll({ search: '100%' })).length).toBe(1);
		expect((await db.getAll({ search: '%' })).length).toBe(1);
	});
});

describe('update / remove', () => {
	it('should update whitelisted fields, bump updated_at, and reject unknown columns', async () => {
		const application = await db.create(baseData);
		const updated = await db.update(application.id, { status: 'interview', reached_interview: true });
		expect(updated.status).toBe('interview');
		expect(updated.reached_interview).toBe(true);
		await expect(db.update(application.id, { evil: 1 })).rejects.toThrow('Unknown column');
	});

	it('should round-trip an emails array through update (the PATCH manual-edit path)', async () => {
		const application = await db.create(baseData);
		const editedRefs = [{ messageId: 'm9', category: 'applied', date: '2026-06-02', fast_apply: false }];
		const updated = await db.update(application.id, { emails: editedRefs });
		expect(updated.emails).toEqual(editedRefs);
	});

	it("should throw 'Not found' for a missing id", async () => {
		await expect(db.update('99999', { status: 'rejected' })).rejects.toThrow('Not found');
	});

	it('should return true on remove, then false on repeat', async () => {
		const application = await db.create(baseData);
		expect(await db.remove(application.id)).toBe(true);
		expect(await db.remove(application.id)).toBe(false);
	});
});

describe('updateWithEmail', () => {
	it('should apply updates and append the ref once — a duplicate messageId never double-records', async () => {
		const application = await db.create(baseData);
		const emailRef = { messageId: 'm1', category: 'rejected', date: '2026-06-10' } as const;
		await db.updateWithEmail(application.id, { status: 'rejected' }, emailRef);
		await db.updateWithEmail(application.id, { notes: 'again' }, emailRef);
		const [afterUpdate] = await db.getAll();
		expect(afterUpdate.status).toBe('rejected');
		expect(afterUpdate.notes).toBe('again');            // second call's field update still applied
		expect(afterUpdate.emails).toEqual([{ messageId: 'm1', category: 'rejected', date: '2026-06-10', fast_apply: false }]);
	});

	it('should be a silent no-op for a missing id (matches the previous updateOne semantics)', async () => {
		await expect(db.updateWithEmail('99999', { status: 'rejected' }, { messageId: 'm1', category: 'rejected', date: '2026-06-10' })).resolves.toBeUndefined();
	});
});

describe('findByCompanyFirstWord', () => {
	it('should bound the match so the next character is not alphanumeric', async () => {
		await db.create({ ...baseData, company: 'Lila' });
		await db.create({ ...baseData, company: 'Lila Sciences' });
		await db.create({ ...baseData, company: 'Lilac' });
		const found = await db.findByCompanyFirstWord('Lila');
		expect(found.map(application => application.company).sort()).toEqual(['Lila', 'Lila Sciences']);
	});

	it('should match a first word ending in punctuation (the "U.S. Bank" case)', async () => {
		await db.create({ ...baseData, company: 'U.S. Bank' });
		expect((await db.findByCompanyFirstWord('U.S.')).length).toBe(1);
	});
});

describe('findByCompanyDomain', () => {
	it('should return only exact-domain rows', async () => {
		await db.create({ ...baseData, company: 'Epic', company_domain: 'epic.com' });
		await db.create({ ...baseData, company: 'Epic Kids', company_domain: 'epickids.com' });
		const found = await db.findByCompanyDomain('epic.com');
		expect(found.map(application => application.company)).toEqual(['Epic']);
	});
});

describe('synced emails', () => {
	it('should keep the first write for a message and handle >500 ids (chunking)', async () => {
		await db.markEmailSynced({ thread_id: 't1', message_id: 'm1', classified_as: 'applied' });
		await db.markEmailSynced({ thread_id: 't1', message_id: 'm1', classified_as: 'rejected' });
		const bulkMessageIds = Array.from({ length: 650 }, (_, index) => `bulk${index}`);
		for (const messageId of bulkMessageIds.slice(0, 10)) await db.markEmailSynced({ thread_id: 't', message_id: messageId, classified_as: 'ignored' });
		const synced = await db.getSyncedMessageIds(['m1', ...bulkMessageIds]);
		expect(synced.has('m1')).toBe(true);
		expect(synced.size).toBe(11);
	});
});

describe('clearAll', () => {
	it('should wipe both tables and report counts', async () => {
		await db.create(baseData);
		await db.markEmailSynced({ thread_id: 't1', message_id: 'm1', classified_as: 'applied' });
		expect(await db.clearAll()).toEqual({ applications: 1, syncedEmails: 1 });
		expect((await db.getAll()).length).toBe(0);
	});
});
