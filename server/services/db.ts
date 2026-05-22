import mongoose, { Schema } from 'mongoose';
import type { Application, CreateApplicationData, MarkSyncedData } from '../types';

// ── Application ────────────────────────────────────────────────────────────

interface AppDoc {
	_id: mongoose.Types.ObjectId;
	company: string;
	role: string;
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
	thread_id:     { type: String, unique: true, required: true },
	message_id:    { type: String, required: true },
	classified_as: String,
	synced_at:     { type: Date, default: () => new Date() },
});

const SyncedEmailModel = mongoose.model('SyncedEmail', syncedEmailSchema);

// ── Helpers ────────────────────────────────────────────────────────────────

// Escape special regex characters in user-supplied strings to prevent ReDoS
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ── Connection ─────────────────────────────────────────────────────────────

export const connect = (): Promise<typeof mongoose> =>
	mongoose.connect(process.env.MONGODB_URI!);

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

export const getById = async (id: string): Promise<Application | undefined> => {
	try {
		const doc = await AppModel.findById(id).lean<AppDoc>();
		return doc ? toApp(doc) : undefined;
	} catch { return undefined; }
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

export const findByCompanyRole = async (company: string, role: string): Promise<Application | undefined> => {
	const doc = await AppModel.findOne({
		company: new RegExp(`^${escapeRegex(company)}$`, 'i'),
		role:    new RegExp(`^${escapeRegex(role)}$`, 'i'),
	}).lean<AppDoc>();
	return doc ? toApp(doc) : undefined;
};

export const isEmailSynced = async (threadId: string): Promise<boolean> => {
	return !!(await SyncedEmailModel.findOne({ thread_id: threadId }));
};

export const getSyncedThreadIds = async (threadIds: string[]): Promise<Set<string>> => {
	const docs = await SyncedEmailModel
		.find({ thread_id: { $in: threadIds } }, 'thread_id')
		.lean<{ thread_id: string }[]>();
	return new Set(docs.map(d => d.thread_id));
};

export const markEmailSynced = async (data: MarkSyncedData): Promise<void> => {
	await SyncedEmailModel.updateOne(
		{ thread_id: data.thread_id },
		{ $setOnInsert: { message_id: data.message_id, classified_as: data.classified_as } },
		{ upsert: true },
	);
};

