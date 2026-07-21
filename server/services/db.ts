import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Application, CreateApplicationData, MarkSyncedData, EmailRef } from '../types';

// ── Storage ─────────────────────────────────────────────────────────────────
// Embedded SQLite (better-sqlite3, synchronous) — one file, no server process. The exported API keeps the
// same async signatures it had on Mongoose so no caller changes; the awaits just resolve immediately.
// `emails` is stored as a JSON column: an application and its email refs are a single aggregate (always
// read/written together, never queried independently), so splitting them into a child table buys nothing.

// Repo-root data/ is gitignored, so the database can never be committed. DB_PATH overrides for tests/tools.
const databaseFilePath = () => process.env.DB_PATH || path.resolve(__dirname, '../../data/job-tracker.db');

let database: Database.Database | null = null;

/** Open the database file (creating it and its directory if needed) — connection concerns only, no schema. */
function openDatabaseFile(filePath: string): Database.Database {
	if (filePath !== ':memory:') mkdirSync(path.dirname(filePath), { recursive: true });
	const connection = new Database(filePath);
	connection.pragma('journal_mode = WAL');
	// The documented WAL pairing: skip the per-commit fsync (FULL) — WAL stays corruption-proof and an app
	// crash loses nothing; only an OS/power failure can drop the last few commits. Matters because a sync's
	// merge phase issues hundreds of small sequential commits.
	connection.pragma('synchronous = NORMAL');
	return connection;
}

// ── Schema ──────────────────────────────────────────────────────────────────

/** An applications row as SQLite returns it: booleans as 0/1, the emails array as JSON text. */
interface ApplicationRow {
	id: number; company: string; role: string; status: string; interview_step: string | null;
	reached_interview: number; date_applied: string | null; last_activity: string | null;
	last_activity_ts: number; job_url: string | null; notes: string | null; notes_source: string;
	external_id: string | null; edited: number; detected_by: string | null; company_domain: string | null;
	awaiting_application: number; fast_apply: number; confirmed: number; source: string;
	gmail_thread_id: string | null; account: string | null; emails: string;
	created_at: string; updated_at: string;
}

// The single source of truth for the applications table: every column (id excepted) with its SQL type,
// compile-time-bound to ApplicationRow by the `satisfies` — add a field to the interface and tsc demands
// a line here (and vice versa). The CREATE TABLE, the INSERT, and the update whitelist all derive from
// this record, so they can never drift out of sync with each other or with the type.
const APPLICATION_COLUMN_TYPES = {
	company:              'TEXT NOT NULL',
	role:                 'TEXT NOT NULL',
	status:               "TEXT NOT NULL DEFAULT 'applied'",
	interview_step:       'TEXT',
	reached_interview:    'INTEGER NOT NULL DEFAULT 0',
	date_applied:         'TEXT',
	last_activity:        'TEXT',
	last_activity_ts:     'INTEGER NOT NULL DEFAULT 0',
	job_url:              'TEXT',
	notes:                'TEXT',
	notes_source:         "TEXT NOT NULL DEFAULT 'auto'",
	external_id:          'TEXT',
	edited:               'INTEGER NOT NULL DEFAULT 0',
	detected_by:          'TEXT',
	company_domain:       'TEXT',
	awaiting_application: 'INTEGER NOT NULL DEFAULT 0',
	fast_apply:           'INTEGER NOT NULL DEFAULT 0',
	confirmed:            'INTEGER NOT NULL DEFAULT 0',
	source:               "TEXT NOT NULL DEFAULT 'manual'",
	gmail_thread_id:      'TEXT',
	account:              'TEXT',
	emails:               "TEXT NOT NULL DEFAULT '[]'",
	created_at:           'TEXT NOT NULL',
	updated_at:           'TEXT NOT NULL',
} as const satisfies Record<Exclude<keyof ApplicationRow, 'id'>, string>;

type ApplicationColumn = keyof typeof APPLICATION_COLUMN_TYPES;
const APPLICATION_COLUMNS = Object.keys(APPLICATION_COLUMN_TYPES) as ApplicationColumn[];

// Timestamps are system-managed (updated_at is bumped by every write); everything else is writable
// via update()/updateWithEmail(). Callers whitelist at the route level too; this is the data layer's
// own guarantee that no unknown key can reach SQL as a column name.
const MUTABLE_COLUMNS = new Set<string>(APPLICATION_COLUMNS.filter(column => column !== 'created_at' && column !== 'updated_at'));

/** Create the tables and indexes (idempotent DDL) — separate from opening so each step has one job. */
function createSchema(connection: Database.Database): void {
	connection.exec(`
		CREATE TABLE IF NOT EXISTS applications (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			${APPLICATION_COLUMNS.map(column => `${column} ${APPLICATION_COLUMN_TYPES[column]}`).join(',\n\t\t\t')}
		);
		CREATE INDEX IF NOT EXISTS idx_apps_company_domain ON applications(company_domain);
		CREATE INDEX IF NOT EXISTS idx_apps_external_id    ON applications(external_id);
		CREATE INDEX IF NOT EXISTS idx_apps_company        ON applications(company COLLATE NOCASE);
		CREATE TABLE IF NOT EXISTS synced_emails (
			message_id    TEXT PRIMARY KEY,
			thread_id     TEXT NOT NULL,
			classified_as TEXT,
			synced_at     TEXT NOT NULL
		);
	`);
}

/**
 * Open the database and ensure its schema exists. Call ONCE at process startup (index.ts, scripts, test
 * setup) before anything asks for the handle — the explicit call makes the boot order visible instead of
 * hiding creation behind whichever caller touches the database first. Throws on a second call.
 */
export function initializeDatabase(): Database.Database {
	if (database) throw new Error('Database already initialized — initializeDatabase() must be called exactly once');
	database = openDatabaseFile(databaseFilePath());
	createSchema(database);
	return database;
}

/** The initialized handle. Pure accessor — never creates; throws when initializeDatabase() hasn't run. */
export function getDatabase(): Database.Database {
	if (!database) throw new Error('Database not initialized — call initializeDatabase() at startup first');
	return database;
}

// ── Row mapping ─────────────────────────────────────────────────────────────

// SQLite has no boolean/array types: booleans ↔ 0/1, the emails array ↔ JSON text.
const toStored = (value: unknown): unknown => {
	if (typeof value === 'boolean') return value ? 1 : 0;
	if (Array.isArray(value)) return JSON.stringify(value);
	return value;
};

function toApplication(row: ApplicationRow): Application {
	return {
		id:              String(row.id),
		company:         row.company,
		role:            row.role,
		status:          row.status as Application['status'],
		interview_step:  row.interview_step as Application['interview_step'],
		reached_interview: !!row.reached_interview,
		date_applied:    row.date_applied,
		last_activity:   row.last_activity,
		last_activity_ts: row.last_activity_ts,
		job_url:         row.job_url,
		notes:           row.notes,
		notes_source:    row.notes_source as Application['notes_source'],
		external_id:     row.external_id,
		edited:          !!row.edited,
		detected_by:     row.detected_by as Application['detected_by'],
		company_domain:  row.company_domain,
		awaiting_application: !!row.awaiting_application,
		fast_apply:      !!row.fast_apply,
		confirmed:       !!row.confirmed,
		source:          row.source as Application['source'],
		gmail_thread_id: row.gmail_thread_id,
		account:         row.account,
		// Normalize fast_apply on read — the Mongo schema defaulted it per ref, so callers always saw it.
		emails:          (JSON.parse(row.emails) as EmailRef[]).map(emailRef => ({ ...emailRef, fast_apply: emailRef.fast_apply ?? false })),
		created_at:      row.created_at,
		updated_at:      row.updated_at,
	};
}

const getRow = (id: string): ApplicationRow | undefined =>
	getDatabase().prepare('SELECT * FROM applications WHERE id = ?').get(Number(id)) as ApplicationRow | undefined;

// ── DB Functions ───────────────────────────────────────────────────────────

interface GetAllFilters { search?: string; status?: string; }

// Escape LIKE wildcards in user-supplied search text; queries pair this with ESCAPE '\'.
const escapeLike = (text: string) => text.replace(/[\\%_]/g, '\\$&');

export const getAll = async (filters: GetAllFilters = {}): Promise<Application[]> => {
	const where: string[] = [];
	const params: unknown[] = [];
	if (filters.search) {
		where.push("(company LIKE ? ESCAPE '\\' OR role LIKE ? ESCAPE '\\')");
		const pattern = `%${escapeLike(filters.search)}%`;
		params.push(pattern, pattern);
	}
	if (filters.status) {
		where.push('status = ?');
		params.push(filters.status);
	}
	const sql = `SELECT * FROM applications ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC, id DESC`;
	return (getDatabase().prepare(sql).all(...params) as ApplicationRow[]).map(toApplication);
};

// Columns, placeholders, and (in create below) parameters all read from APPLICATION_COLUMNS in the same
// order, so nothing can slip out of alignment. Column names come from the literal above, never from input.
const INSERT_APPLICATION_SQL = `
	INSERT INTO applications (${APPLICATION_COLUMNS.join(', ')})
	VALUES (${APPLICATION_COLUMNS.map(() => '?').join(', ')})
`;

// The full column→value record for a new row: CreateApplicationData's optionals get their defaults
// here. Typing it by ApplicationColumn makes tsc demand a value for every column — a new field can't
// be forgotten silently. Shared by create() and applyImportPlan()'s creates.
function buildCreateColumnValues(data: CreateApplicationData): Record<ApplicationColumn, unknown> {
	const now = new Date().toISOString();
	return {
		company:              data.company,
		role:                 data.role,
		status:               data.status,
		interview_step:       data.interview_step,
		reached_interview:    data.reached_interview ?? false,
		date_applied:         data.date_applied,
		last_activity:        data.last_activity,
		last_activity_ts:     data.last_activity_ts ?? 0,
		job_url:              data.job_url,
		notes:                data.notes,
		notes_source:         data.notes_source ?? 'auto',
		external_id:          data.external_id ?? null,
		edited:               data.edited ?? false,
		detected_by:          data.detected_by ?? null,
		company_domain:       data.company_domain ?? null,
		awaiting_application: data.awaiting_application ?? false,
		fast_apply:           data.fast_apply ?? false,
		confirmed:            data.confirmed ?? false,
		source:               data.source,
		gmail_thread_id:      data.gmail_thread_id,
		account:              data.account ?? null,
		emails:               data.emails ?? [],
		created_at:           now,
		updated_at:           now,
	};
}

export const create = async (data: CreateApplicationData): Promise<Application> => {
	const columnValues = buildCreateColumnValues(data);
	const result = getDatabase().prepare(INSERT_APPLICATION_SQL)
		.run(...APPLICATION_COLUMNS.map(column => toStored(columnValues[column])));
	return toApplication(getRow(String(result.lastInsertRowid))!);
};

/** SET clause + params for a whitelisted update, always bumping updated_at. Throws on an unknown column. */
function buildSet(data: Record<string, unknown>): { clause: string; params: unknown[] } {
	const columns = Object.keys(data);
	for (const column of columns) if (!MUTABLE_COLUMNS.has(column)) throw new Error(`Unknown column: ${column}`);
	return {
		clause: [...columns.map(column => `${column} = ?`), 'updated_at = ?'].join(', '),
		params: [...columns.map(column => toStored(data[column])), new Date().toISOString()],
	};
}

export const update = async (id: string, data: Record<string, unknown>): Promise<Application> => {
	const { clause, params } = buildSet(data);
	const result = getDatabase().prepare(`UPDATE applications SET ${clause} WHERE id = ?`).run(...params, Number(id));
	if (result.changes === 0) throw new Error('Not found');
	return toApplication(getRow(id)!);
};

export const remove = async (id: string): Promise<boolean> => {
	return getDatabase().prepare('DELETE FROM applications WHERE id = ?').run(Number(id)).changes > 0;
};

/**
 * Apply field updates to an application AND append a Gmail message reference in ONE transaction. The ref
 * is appended only when its messageId isn't already present, so re-processing the same email never
 * double-records it — while the field updates still apply either way.
 */
export const updateWithEmail = async (id: string, updates: Record<string, unknown>, emailRef: EmailRef): Promise<void> => {
	getDatabase().transaction(() => {
		const row = getRow(id);
		if (!row) return;   // matches the previous updateOne semantics: a missing id is a silent no-op
		const emails = JSON.parse(row.emails) as EmailRef[];
		const merged = emails.some(existingRef => existingRef.messageId === emailRef.messageId)
			? { ...updates }
			: { ...updates, emails: [...emails, emailRef] };
		const { clause, params } = buildSet(merged);
		getDatabase().prepare(`UPDATE applications SET ${clause} WHERE id = ?`).run(...params, row.id);
	})();
};

/**
 * Candidate name variants: applications whose company starts with `firstWord`, bounded so the next
 * character isn't alphanumeric — "Lila" matches "Lila" and "Lila Sciences" but not "Lilac"; the caller
 * then confirms with a full word-prefix check. The LIKE prefix does the indexed narrowing; the negative
 * lookahead runs in JS because SQLite has no regex. A lookahead is used instead of `\b` so a first word
 * ENDING in punctuation still matches — `\b` has no word boundary after the trailing "." of "U.S.",
 * which silently dropped every "U.S. Bank" candidate.
 */
export const findByCompanyFirstWord = async (firstWord: string): Promise<Application[]> => {
	const rows = getDatabase()
		.prepare("SELECT * FROM applications WHERE company LIKE ? ESCAPE '\\'")
		.all(`${escapeLike(firstWord)}%`) as ApplicationRow[];
	const escapedFirstWord = firstWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const boundedFirstWord = new RegExp(`^${escapedFirstWord}(?![a-z0-9])`, 'i');
	return rows.filter(row => boundedFirstWord.test(row.company)).map(toApplication);
};

/** All applications from the same real company domain — the strongest dedup key (one domain = one employer). */
export const findByCompanyDomain = async (domain: string): Promise<Application[]> => {
	const rows = getDatabase().prepare('SELECT * FROM applications WHERE company_domain = ?').all(domain) as ApplicationRow[];
	return rows.map(toApplication);
};

export const getSyncedMessageIds = async (messageIds: string[]): Promise<Set<string>> => {
	const synced = new Set<string>();
	// Chunked IN lists — SQLite caps bound parameters per statement.
	for (let offset = 0; offset < messageIds.length; offset += 500) {
		const chunk = messageIds.slice(offset, offset + 500);
		const rows = getDatabase()
			.prepare(`SELECT message_id FROM synced_emails WHERE message_id IN (${chunk.map(() => '?').join(',')})`)
			.all(...chunk) as { message_id: string }[];
		for (const row of rows) synced.add(row.message_id);
	}
	return synced;
};

export const markEmailSynced = async (data: MarkSyncedData): Promise<void> => {
	// OR IGNORE preserves the first record for a message (same as the previous $setOnInsert upsert).
	getDatabase().prepare('INSERT OR IGNORE INTO synced_emails (message_id, thread_id, classified_as, synced_at) VALUES (?, ?, ?, ?)')
		.run(data.message_id, data.thread_id, data.classified_as, new Date().toISOString());
};

/** Mark an application's imported/attached email refs as already synced, so the next Gmail sync skips
 *  them instead of re-fetching and re-classifying messages the board already tracks (a CSV import would
 *  otherwise cause a full re-sync). The refs carry no thread id, so the message id stands in — for a
 *  thread's first message the two are the same value — and OR IGNORE keeps any genuine sync record intact. */
export const markEmailRefsSynced = async (emailRefs: EmailRef[]): Promise<void> => {
	if (emailRefs.length === 0) return;
	const insertSyncedEmail = getDatabase().prepare('INSERT OR IGNORE INTO synced_emails (message_id, thread_id, classified_as, synced_at) VALUES (?, ?, ?, ?)');
	const syncedAt = new Date().toISOString();
	getDatabase().transaction(() => {
		for (const emailRef of emailRefs) insertSyncedEmail.run(emailRef.messageId, emailRef.messageId, emailRef.category, syncedAt);
	})();
};

// ── CSV import plan ─────────────────────────────────────────────────────────
// The client reconciles a parsed CSV against the board into a mutation plan (docs/csv-reimport-spec.md);
// this applies the whole plan in ONE transaction so a partial failure rolls everything back.

export interface ImportPlanPayload {
	// Brand-new applications; preservedId keeps the file's id when it's free so a re-import of the
	// same file matches by id instead of duplicating.
	creates: { preservedId: string | null; data: CreateApplicationData }[];
	// In-place edits; adoptId moves the application onto the file's (free) id for the same reason.
	updates: { id: string; changes: Record<string, unknown>; adoptId: string | null }[];
	// Email-uniqueness strips: remove these message ids from applications no CSV row matched.
	strips: { id: string; messageIds: string[] }[];
	// Applications whose every email was stripped away — merged into the row that claimed them.
	deletes: string[];
	// Every email ref present in the file — marked synced so the next Gmail sync skips them all.
	syncEmails: EmailRef[];
}

export interface ImportPlanResult {
	added: number;
	updated: number;
	deleted: number;
	// Plan entries whose target no longer matches the board (deleted or changed since the plan was
	// built) — skipped rather than failing the whole import.
	staleSkipped: number;
	createdIds: string[];
	updatedIds: string[];
}

// INSERT with an explicit id (a preserved file id). SQLite accepts explicit values for an
// AUTOINCREMENT column and later inserts still pick max(seq, max rowid)+1, so no collision follows.
const INSERT_APPLICATION_WITH_ID_SQL = `
	INSERT INTO applications (id, ${APPLICATION_COLUMNS.join(', ')})
	VALUES (?, ${APPLICATION_COLUMNS.map(() => '?').join(', ')})
`;

export const applyImportPlan = async (plan: ImportPlanPayload): Promise<ImportPlanResult> => {
	const database = getDatabase();
	return database.transaction((): ImportPlanResult => {
		let deleted = 0, staleSkipped = 0;
		const createdIds: string[] = [];
		const updatedIds: string[] = [];
		const idIsTaken = (id: number) => database.prepare('SELECT 1 FROM applications WHERE id = ?').get(id) !== undefined;

		// 1. Strips — email uniqueness: remove claimed emails from applications no row matched.
		//    (Matched applications shed theirs through their own row's email-list replacement.)
		for (const plannedStrip of plan.strips) {
			const row = getRow(plannedStrip.id);
			if (!row) { staleSkipped++; continue; }
			const strippedMessageIds = new Set(plannedStrip.messageIds);
			const remainingEmails = (JSON.parse(row.emails) as EmailRef[]).filter(emailRef => !strippedMessageIds.has(emailRef.messageId));
			const { clause, params } = buildSet({ emails: remainingEmails });
			database.prepare(`UPDATE applications SET ${clause} WHERE id = ?`).run(...params, row.id);
		}

		// 2. Deletes — re-verified: only an application that really ended up email-less goes (a stale
		//    plan, or one drifted since confirm, must never delete an application still holding data).
		for (const deleteId of plan.deletes) {
			const row = getRow(deleteId);
			if (!row) continue;   // already gone — the intended outcome
			if ((JSON.parse(row.emails) as EmailRef[]).length > 0) { staleSkipped++; continue; }
			database.prepare('DELETE FROM applications WHERE id = ?').run(row.id);
			deleted++;
		}

		// 3. Updates, each optionally adopting the file's id so the row converges to an id match.
		for (const plannedUpdate of plan.updates) {
			const row = getRow(plannedUpdate.id);
			if (!row) { staleSkipped++; continue; }
			if (Object.keys(plannedUpdate.changes).length > 0) {
				const { clause, params } = buildSet(plannedUpdate.changes);
				database.prepare(`UPDATE applications SET ${clause} WHERE id = ?`).run(...params, row.id);
			}
			let finalId = row.id;
			if (plannedUpdate.adoptId) {
				const adoptTargetId = Number(plannedUpdate.adoptId);
				// Re-checked inside the transaction — the id must still be free at apply time.
				if (!idIsTaken(adoptTargetId)) {
					database.prepare('UPDATE applications SET id = ? WHERE id = ?').run(adoptTargetId, row.id);
					finalId = adoptTargetId;
				}
			}
			updatedIds.push(String(finalId));
		}

		// 4. Creates, keeping the file's id when it's (still) free.
		for (const plannedCreate of plan.creates) {
			const columnValues = buildCreateColumnValues(plannedCreate.data);
			const columnParams = APPLICATION_COLUMNS.map(column => toStored(columnValues[column]));
			const preservedId = plannedCreate.preservedId !== null && !idIsTaken(Number(plannedCreate.preservedId))
				? Number(plannedCreate.preservedId) : null;
			const insertResult = preservedId !== null
				? database.prepare(INSERT_APPLICATION_WITH_ID_SQL).run(preservedId, ...columnParams)
				: database.prepare(INSERT_APPLICATION_SQL).run(...columnParams);
			createdIds.push(String(insertResult.lastInsertRowid));
		}

		// 5. Every email id in the file is now board-tracked → synced. OR IGNORE keeps genuine sync records.
		const insertSyncedEmail = database.prepare('INSERT OR IGNORE INTO synced_emails (message_id, thread_id, classified_as, synced_at) VALUES (?, ?, ?, ?)');
		const syncedAt = new Date().toISOString();
		for (const emailRef of plan.syncEmails) insertSyncedEmail.run(emailRef.messageId, emailRef.messageId, emailRef.category, syncedAt);

		return { added: createdIds.length, updated: updatedIds.length, deleted, staleSkipped, createdIds, updatedIds };
	})();
};

/** Wipe all applications AND the synced-email log so the next sync re-processes everything. One
 *  transaction: a crash between the two deletes would otherwise leave emails marked synced with no
 *  application records — a state the sync skips over and can never repair. */
export const clearAll = async (): Promise<{ applications: number; syncedEmails: number }> => {
	return getDatabase().transaction(() => {
		const deletedApplications = getDatabase().prepare('DELETE FROM applications').run().changes;
		const deletedSyncedEmails = getDatabase().prepare('DELETE FROM synced_emails').run().changes;
		return { applications: deletedApplications, syncedEmails: deletedSyncedEmails };
	})();
};
