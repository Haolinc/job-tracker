import mongoose, { Schema } from 'mongoose';
import type { Application, CreateApplicationData, MarkSyncedData } from '../types';
import { buildLookupKey } from '../utils';

// ── Application ────────────────────────────────────────────────────────────

interface AppDoc {
	_id: mongoose.Types.ObjectId;
	company: string;
	role: string;
	lookup_key: string | null;
	status: string;
	interview_step: string | null;
	date_applied: string | null;
	last_activity: string | null;
	job_url: string | null;
	notes: string | null;
	source: string;
	gmail_thread_id: string | null;
	created_at: Date;
	updated_at: Date;
}

const appSchema = new Schema<AppDoc>({
	company:         { type: String, required: true },
	role:            { type: String, required: true },
	// Pre-computed compound key: normalize(company)::normalize(role).
	// Indexed for O(1) lookup when matching emails to existing applications.
	lookup_key:      { type: String, index: true, default: null },
	status:          { type: String, default: 'applied' },
	interview_step:  { type: String, default: null },
	date_applied:    { type: String, default: null },
	last_activity:   { type: String, default: null },
	job_url:         { type: String, default: null },
	notes:           { type: String, default: null },
	source:          { type: String, default: 'manual' },
	gmail_thread_id: { type: String, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

const AppModel = mongoose.model<AppDoc>('Application', appSchema);

function toApp(doc: AppDoc): Application {
	return {
		id:              doc._id.toString(),
		company:         doc.company,
		role:            doc.role,
		lookup_key:      doc.lookup_key ?? null,
		status:          doc.status as Application['status'],
		interview_step:  (doc.interview_step ?? null) as Application['interview_step'],
		date_applied:    doc.date_applied,
		last_activity:   doc.last_activity,
		job_url:         doc.job_url,
		notes:           doc.notes,
		source:          doc.source as Application['source'],
		gmail_thread_id: doc.gmail_thread_id,
		created_at:      doc.created_at.toISOString(),
		updated_at:      doc.updated_at.toISOString(),
	};
}

// ── Synced Emails ──────────────────────────────────────────────────────────

const syncedEmailSchema = new Schema({
	thread_id:     { type: String, required: true },           // not unique — many messages share a thread
	message_id:    { type: String, unique: true, required: true }, // dedup key: one record per Gmail message
	classified_as: String,
	synced_at:     { type: Date, default: () => new Date() },
});

const SyncedEmailModel = mongoose.model('SyncedEmail', syncedEmailSchema);

// ── Helpers ────────────────────────────────────────────────────────────────

// Escape special regex characters in user-supplied strings to prevent ReDoS
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ── Connection ─────────────────────────────────────────────────────────────

export const connect = async (): Promise<typeof mongoose> => {
	const m = await mongoose.connect(process.env.MONGODB_URI!);

	// Migration 1: drop old thread_id unique index (replaced by message_id unique index).
	try {
		await SyncedEmailModel.collection.dropIndex('thread_id_1');
	} catch { /* already dropped or never existed */ }

	// Migration 2: backfill lookup_key for existing application entries that predate the field.
	const toBackfill = await AppModel
		.find({ lookup_key: { $exists: false } })
		.lean<AppDoc[]>();
	if (toBackfill.length > 0) {
		await Promise.all(toBackfill.map(e =>
			AppModel.updateOne(
				{ _id: e._id },
				{ $set: { lookup_key: buildLookupKey(e.company, e.role) } },
			),
		));
		console.log(`[db] backfilled lookup_key for ${toBackfill.length} application(s)`);
	}

	return m;
};

// ── DB Functions ───────────────────────────────────────────────────────────

interface GetAllFilters { search?: string; status?: string; }

export const getAll = async (filters: GetAllFilters = {}): Promise<Application[]> => {
	const query: Record<string, unknown> = {};
	if (filters.search) {
		const re = new RegExp(escapeRegex(filters.search), 'i');
		query.$or = [{ company: re }, { role: re }];
	}
	if (filters.status) query.status = filters.status;
	const docs = await AppModel.find(query).sort({ updated_at: -1 }).lean<AppDoc[]>();
	return docs.map(toApp);
};

export const create = async (data: CreateApplicationData): Promise<Application> => {
	const doc = await AppModel.create({
		...data,
		lookup_key: buildLookupKey(data.company, data.role),
	});
	const lean = doc.toObject() as AppDoc;
	return toApp(lean);
};

export const update = async (id: string, data: Record<string, unknown>): Promise<Application> => {
	const doc = await AppModel.findByIdAndUpdate(id, { $set: data }, { returnDocument: 'after' }).lean<AppDoc>();
	if (!doc) throw new Error('Not found');
	return toApp(doc);
};

export const remove = async (id: string): Promise<boolean> => {
	const doc = await AppModel.findByIdAndDelete(id).lean();
	return !!doc;
};

/** Fast O(1) lookup by pre-computed compound key (preferred path). */
export const findByLookupKey = async (key: string): Promise<Application | undefined> => {
	const doc = await AppModel.findOne({ lookup_key: key }).lean<AppDoc>();
	return doc ? toApp(doc) : undefined;
};

/** Regex fallback used when lookup_key is unavailable (manual entries, legacy data). */
export const findByCompanyRole = async (company: string, role: string): Promise<Application | undefined> => {
	const doc = await AppModel.findOne({
		company: new RegExp(`^${escapeRegex(company)}$`, 'i'),
		role:    new RegExp(`^${escapeRegex(role)}$`, 'i'),
	}).lean<AppDoc>();
	return doc ? toApp(doc) : undefined;
};

// Returns all applications for a company — used when role is unknown to avoid duplicates
export const findByCompany = async (company: string): Promise<Application[]> => {
	const docs = await AppModel.find({
		company: new RegExp(`^${escapeRegex(company)}$`, 'i'),
	}).lean<AppDoc[]>();
	return docs.map(toApp);
};

export const getSyncedMessageIds = async (messageIds: string[]): Promise<Set<string>> => {
	const docs = await SyncedEmailModel
		.find({ message_id: { $in: messageIds } }, 'message_id')
		.lean<{ message_id: string }[]>();
	return new Set(docs.map(d => d.message_id));
};

export const markEmailSynced = async (data: MarkSyncedData): Promise<void> => {
	await SyncedEmailModel.updateOne(
		{ message_id: data.message_id },
		{ $setOnInsert: { thread_id: data.thread_id, classified_as: data.classified_as } },
		{ upsert: true },
	);
};

