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

	it('should mark imported email refs as synced so the next sync skips them', async () => {
		await db.markEmailRefsSynced([
			{ messageId: 'imported-1', category: 'applied', date: '2026-06-01' },
			{ messageId: 'imported-2', category: 'interview', date: '2026-06-05', fast_apply: true },
		]);
		const synced = await db.getSyncedMessageIds(['imported-1', 'imported-2', 'never-seen']);
		expect(synced).toEqual(new Set(['imported-1', 'imported-2']));
	});

	it('should be a no-op for an empty ref list and leave a genuine sync record intact', async () => {
		await db.markEmailRefsSynced([]);
		await db.markEmailSynced({ thread_id: 'real-thread', message_id: 'm-real', classified_as: 'applied' });
		// Re-marking via refs must not clobber the genuine record (OR IGNORE keeps the first write).
		await db.markEmailRefsSynced([{ messageId: 'm-real', category: 'rejected', date: '2026-06-09' }]);
		expect((await db.getSyncedMessageIds(['m-real'])).has('m-real')).toBe(true);
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

describe('applyImportPlan', () => {
	const emptyPlan: db.ImportPlanPayload = { creates: [], updates: [], strips: [], deletes: [], syncEmails: [] };
	const ref = (messageId: string): { messageId: string; category: 'applied'; date: string } =>
		({ messageId, category: 'applied', date: '2026-06-01' });
	const getById = async (id: string) => (await db.getAll()).find(application => application.id === id);

	it('should create with a preserved file id, and later inserts autoincrement past it', async () => {
		const result = await db.applyImportPlan({ ...emptyPlan, creates: [{ preservedId: '4210', data: baseData }] });
		expect(result.added).toBe(1);
		expect(result.createdIds).toEqual(['4210']);
		expect(await getById('4210')).toBeTruthy();
		// AUTOINCREMENT picks max(sequence, max rowid)+1 — the next ordinary create can't collide.
		const next = await db.create({ ...baseData, company: 'After' });
		expect(Number(next.id)).toBeGreaterThan(4210);
	});

	it('should fall back to an autoincrement id when the preserved id is already taken', async () => {
		const occupant = await db.create({ ...baseData, company: 'Occupant' });
		const result = await db.applyImportPlan({ ...emptyPlan, creates: [{ preservedId: occupant.id, data: { ...baseData, company: 'Newcomer' } }] });
		expect(result.createdIds[0]).not.toBe(occupant.id);
		expect((await getById(occupant.id))?.company).toBe('Occupant');   // never clobbered
	});

	it('should update fields and adopt a free file id in the same pass', async () => {
		const holder = await db.create(baseData);
		const result = await db.applyImportPlan({ ...emptyPlan, updates: [{ id: holder.id, changes: { company: 'Acme Corp' }, adoptId: '9000' }] });
		expect(result.updated).toBe(1);
		expect(result.updatedIds).toEqual(['9000']);
		expect(await getById(holder.id)).toBeUndefined();       // moved off its old id
		expect((await getById('9000'))?.company).toBe('Acme Corp');
	});

	it('should keep its own id when the adoption target id is taken', async () => {
		const holder = await db.create(baseData);
		const occupant = await db.create({ ...baseData, company: 'Occupant' });
		const result = await db.applyImportPlan({ ...emptyPlan, updates: [{ id: holder.id, changes: {}, adoptId: occupant.id }] });
		expect(result.updatedIds).toEqual([holder.id]);
		expect((await getById(occupant.id))?.company).toBe('Occupant');
	});

	it('should strip only the listed message ids from a holder', async () => {
		const holder = await db.create({ ...baseData, emails: [ref('m-goes'), ref('m-stays')] });
		await db.applyImportPlan({ ...emptyPlan, strips: [{ id: holder.id, messageIds: ['m-goes'] }] });
		expect((await getById(holder.id))?.emails.map(email => email.messageId)).toEqual(['m-stays']);
	});

	it('should delete a planned application only when it really ended up email-less', async () => {
		const emptied = await db.create({ ...baseData, company: 'Emptied', emails: [ref('m-a')] });
		const stillHolding = await db.create({ ...baseData, company: 'Still Holding', emails: [ref('m-b'), ref('m-c')] });
		const result = await db.applyImportPlan({
			...emptyPlan,
			strips: [{ id: emptied.id, messageIds: ['m-a'] }, { id: stillHolding.id, messageIds: ['m-b'] }],
			// The plan (staleley) wants both gone — only the truly emptied one may go.
			deletes: [emptied.id, stillHolding.id],
		});
		expect(result.deleted).toBe(1);
		expect(result.staleSkipped).toBe(1);
		expect(await getById(emptied.id)).toBeUndefined();
		expect((await getById(stillHolding.id))?.emails.map(email => email.messageId)).toEqual(['m-c']);
	});

	it('should skip a stale update target (deleted since planning) and still apply the rest', async () => {
		const survivor = await db.create(baseData);
		const result = await db.applyImportPlan({
			...emptyPlan,
			updates: [
				{ id: '99999', changes: { company: 'Ghost' }, adoptId: null },
				{ id: survivor.id, changes: { company: 'Updated' }, adoptId: null },
			],
		});
		expect(result.staleSkipped).toBe(1);
		expect(result.updated).toBe(1);
		expect((await getById(survivor.id))?.company).toBe('Updated');
	});

	it('should mark every syncEmails ref synced', async () => {
		await db.applyImportPlan({ ...emptyPlan, syncEmails: [ref('m-1'), ref('m-2')] });
		expect(await db.getSyncedMessageIds(['m-1', 'm-2', 'm-3'])).toEqual(new Set(['m-1', 'm-2']));
	});

	it('should roll the WHOLE plan back when any piece fails (one transaction)', async () => {
		const target = await db.create(baseData);
		await expect(db.applyImportPlan({
			...emptyPlan,
			updates: [
				{ id: target.id, changes: { company: 'Halfway Applied' }, adoptId: null },
				{ id: target.id, changes: { evil_column: 1 }, adoptId: null },   // buildSet throws on unknown columns
			],
		})).rejects.toThrow('Unknown column');
		// The first update DID run inside the transaction — the failure must undo it.
		expect((await getById(target.id))?.company).toBe(baseData.company);
	});
});
