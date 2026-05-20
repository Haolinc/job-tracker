import Database from 'better-sqlite3';
import path from 'path';
import type { Application, CreateApplicationData, MarkSyncedData, SyncRecord } from '../types';

const DB_PATH = path.join(__dirname, '../../data/tracker.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
	CREATE TABLE IF NOT EXISTS applications (
		id              INTEGER PRIMARY KEY AUTOINCREMENT,
		company         TEXT NOT NULL,
		role            TEXT NOT NULL,
		status          TEXT DEFAULT 'wishlist',
		priority        TEXT DEFAULT 'medium',
		date_applied    TEXT,
		job_url         TEXT,
		notes           TEXT,
		source          TEXT DEFAULT 'manual',
		gmail_thread_id TEXT,
		created_at      TEXT DEFAULT (datetime('now')),
		updated_at      TEXT DEFAULT (datetime('now'))
	);

	CREATE TABLE IF NOT EXISTS synced_emails (
		id            INTEGER PRIMARY KEY AUTOINCREMENT,
		thread_id     TEXT UNIQUE NOT NULL,
		message_id    TEXT NOT NULL,
		classified_as TEXT,
		synced_at     TEXT DEFAULT (datetime('now'))
	);

	CREATE TABLE IF NOT EXISTS sync_history (
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		added      INTEGER DEFAULT 0,
		updated    INTEGER DEFAULT 0,
		skipped    INTEGER DEFAULT 0,
		synced_at  TEXT DEFAULT (datetime('now'))
	);
`);

interface GetAllFilters {
	search?: string;
	priority?: string;
	status?: string;
}

const getAll = (filters: GetAllFilters = {}): Application[] => {
	let query = 'SELECT * FROM applications WHERE 1=1';
	const params: string[] = [];

	if (filters.search) {
		query += ' AND (company LIKE ? OR role LIKE ?)';
		params.push(`%${filters.search}%`, `%${filters.search}%`);
	}
	if (filters.priority) {
		query += ' AND priority = ?';
		params.push(filters.priority);
	}
	if (filters.status) {
		query += ' AND status = ?';
		params.push(filters.status);
	}

	query += ' ORDER BY updated_at DESC';
	return db.prepare(query).all(...params) as Application[];
};

const getById = (id: number | string): Application | undefined =>
	db.prepare('SELECT * FROM applications WHERE id = ?').get(id) as Application | undefined;

const create = (data: CreateApplicationData): Application => {
	const stmt = db.prepare(`
		INSERT INTO applications (company, role, status, priority, date_applied, job_url, notes, source, gmail_thread_id)
		VALUES (@company, @role, @status, @priority, @date_applied, @job_url, @notes, @source, @gmail_thread_id)
	`);
	const result = stmt.run(data as unknown as Record<string, unknown>);
	return getById(Number(result.lastInsertRowid))!;
};

const update = (id: number | string, data: Record<string, unknown>): Application => {
	const fields = Object.keys(data).map(k => `${k} = @${k}`).join(', ');
	db.prepare(`UPDATE applications SET ${fields}, updated_at = datetime('now') WHERE id = @id`)
		.run({ ...data, id });
	return getById(id)!;
};

const remove = (id: number | string): void => {
	db.prepare('DELETE FROM applications WHERE id = ?').run(id);
};

const findByCompanyRole = (company: string, role: string): Application | undefined =>
	db.prepare('SELECT * FROM applications WHERE lower(company) = lower(?) AND lower(role) = lower(?)')
		.get(company, role) as Application | undefined;

const isEmailSynced = (threadId: string): boolean =>
	!!db.prepare('SELECT id FROM synced_emails WHERE thread_id = ?').get(threadId);

const markEmailSynced = (data: MarkSyncedData): void => {
	db.prepare('INSERT OR IGNORE INTO synced_emails (thread_id, message_id, classified_as) VALUES (@thread_id, @message_id, @classified_as)')
		.run(data as unknown as Record<string, unknown>);
};

const addSyncRecord = (data: { added: number; updated: number; skipped: number }): void => {
	db.prepare('INSERT INTO sync_history (added, updated, skipped) VALUES (@added, @updated, @skipped)')
		.run(data);
};

const getSyncHistory = (): SyncRecord[] =>
	db.prepare('SELECT * FROM sync_history ORDER BY synced_at DESC LIMIT 20').all() as SyncRecord[];

export {
	getAll, getById, create, update, remove, findByCompanyRole,
	isEmailSynced, markEmailSynced, addSyncRecord, getSyncHistory,
};
