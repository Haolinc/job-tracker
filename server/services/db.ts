import mongoose, { Schema } from 'mongoose';
import type { Application, CreateApplicationData, MarkSyncedData } from '../types';

// ── Application ────────────────────────────────────────────────────────────

interface AppDoc {
	_id: mongoose.Types.ObjectId;
	company: string;
	role: string;
	status: string;
	interview_step: string | null;
	reached_interview: boolean;
	date_applied: string | null;
	last_activity: string | null;
	last_activity_ts: number;
	job_url: string | null;
	notes: string | null;
	notes_source: string;
	external_id: string | null;
	edited: boolean;
	detected_by: string | null;
	company_domain: string | null;
	awaiting_application: boolean;
	source: string;
	gmail_thread_id: string | null;
	created_at: Date;
	updated_at: Date;
}

const appSchema = new Schema<AppDoc>({
	company:         { type: String, required: true },
	role:            { type: String, required: true },
	status:          { type: String, default: 'applied' },
	interview_step:  { type: String, default: null },
	reached_interview: { type: Boolean, default: false },
	date_applied:    { type: String, default: null },
	last_activity:   { type: String, default: null },
	last_activity_ts: { type: Number, default: 0 },
	job_url:         { type: String, default: null },
	notes:           { type: String, default: null },
	notes_source:    { type: String, default: 'auto' },
	external_id:     { type: String, index: true, default: null },
	edited:          { type: Boolean, default: false },
	detected_by:     { type: String, default: null },
	company_domain:  { type: String, index: true, default: null },
	awaiting_application: { type: Boolean, default: false },
	source:          { type: String, default: 'manual' },
	gmail_thread_id: { type: String, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

const AppModel = mongoose.model<AppDoc>('Application', appSchema);

function toApp(doc: AppDoc): Application {
	return {
		id:              doc._id.toString(),
		company:         doc.company,
		role:            doc.role,
		status:          doc.status as Application['status'],
		interview_step:  (doc.interview_step ?? null) as Application['interview_step'],
		reached_interview: doc.reached_interview ?? false,
		date_applied:    doc.date_applied,
		last_activity:   doc.last_activity,
		last_activity_ts: doc.last_activity_ts ?? 0,
		job_url:         doc.job_url,
		notes:           doc.notes,
		notes_source:    (doc.notes_source ?? 'auto') as Application['notes_source'],
		external_id:     doc.external_id ?? null,
		edited:          doc.edited ?? false,
		detected_by:     (doc.detected_by ?? null) as Application['detected_by'],
		company_domain:  doc.company_domain ?? null,
		awaiting_application: doc.awaiting_application ?? false,
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

	// Migration 2: drop the retired lookup_key index — matching now gathers candidates by company
	// domain/name and resolves the role in memory, so the pre-computed key is no longer used.
	try {
		await AppModel.collection.dropIndex('lookup_key_1');
	} catch { /* already dropped or never existed */ }

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
	const doc = await AppModel.create(data);
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

/**
 * Candidate name variants: applications whose company starts with `firstWord`, bounded so the next
 * character isn't alphanumeric. `^Lila(?![a-z0-9])` matches "Lila" and "Lila Sciences" but not
 * "Lilac"; the caller then confirms with a full word-prefix check. A negative lookahead is used
 * instead of `\b` so a first word ENDING in punctuation still matches — `\b` has no word boundary
 * after the trailing "." of "U.S.", which silently dropped every "U.S. Bank" candidate.
 */
export const findByCompanyFirstWord = async (firstWord: string): Promise<Application[]> => {
	const docs = await AppModel.find({
		company: new RegExp(`^${escapeRegex(firstWord)}(?![a-z0-9])`, 'i'),
	}).lean<AppDoc[]>();
	return docs.map(toApp);
};

/** All applications from the same real company domain — the strongest dedup key (one domain = one employer). */
export const findByCompanyDomain = async (domain: string): Promise<Application[]> => {
	const docs = await AppModel.find({ company_domain: domain }).lean<AppDoc[]>();
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

/** Wipe all applications AND the synced-email log so the next sync re-processes everything. */
export const clearAll = async (): Promise<{ applications: number; syncedEmails: number }> => {
	const [apps, emails] = await Promise.all([
		AppModel.deleteMany({}),
		SyncedEmailModel.deleteMany({}),
	]);
	return { applications: apps.deletedCount, syncedEmails: emails.deletedCount };
};

