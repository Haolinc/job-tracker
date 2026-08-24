import { randomBytes } from 'node:crypto';
import session from 'express-session';
import { getDatabase } from './db';

// SQLite-backed session store (replaces connect-mongo). Sessions carry the Gmail OAuth tokens, so they
// must survive server restarts — the same guarantee the Mongo store gave. Lives in the same database file
// as the application data; the table is created on first use.
//
// express-session's Store contract is callback-based; better-sqlite3 is synchronous, so each method is a
// straight query followed by the callback. Expiry: rows past their expires_at are treated as missing on
// read and physically removed by a periodic sweep (and on boot).

const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export class SqliteSessionStore extends session.Store {
	constructor() {
		super();
		getDatabase().exec(`
			CREATE TABLE IF NOT EXISTS sessions (
				sid        TEXT PRIMARY KEY,
				sess       TEXT NOT NULL,
				expires_at INTEGER NOT NULL
			);
		`);
		this.sweep();
		// unref: the sweep timer must never keep the process alive on its own.
		setInterval(() => this.sweep(), SWEEP_INTERVAL_MS).unref();
	}

	private sweep(): void {
		getDatabase().prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
	}

	/** The absolute expiry for a session: its cookie's expiry, else one day out (matches common defaults). */
	private expiryOf(sessionData: session.SessionData): number {
		const expires = sessionData.cookie?.expires;
		return expires ? new Date(expires).getTime() : Date.now() + DAY_MS;
	}

	get = (sessionId: string, callback: (error: unknown, sessionData?: session.SessionData | null) => void): void => {
		try {
			const row = getDatabase().prepare('SELECT sess, expires_at FROM sessions WHERE sid = ?').get(sessionId) as
				| { sess: string; expires_at: number } | undefined;
			if (!row || row.expires_at < Date.now()) return callback(null, null);
			callback(null, JSON.parse(row.sess) as session.SessionData);
		} catch (error) {
			callback(error);
		}
	};

	set = (sessionId: string, sessionData: session.SessionData, callback?: (error?: unknown) => void): void => {
		try {
			getDatabase().prepare('INSERT OR REPLACE INTO sessions (sid, sess, expires_at) VALUES (?, ?, ?)')
				.run(sessionId, JSON.stringify(sessionData), this.expiryOf(sessionData));
			callback?.();
		} catch (error) {
			callback?.(error);
		}
	};

	destroy = (sessionId: string, callback?: (error?: unknown) => void): void => {
		try {
			getDatabase().prepare('DELETE FROM sessions WHERE sid = ?').run(sessionId);
			callback?.();
		} catch (error) {
			callback?.(error);
		}
	};

	/** Refresh the expiry on an active session without rewriting its data. */
	touch = (sessionId: string, sessionData: session.SessionData, callback?: (error?: unknown) => void): void => {
		try {
			getDatabase().prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?').run(this.expiryOf(sessionData), sessionId);
			callback?.();
		} catch (error) {
			callback?.(error);
		}
	};
}

// ── Session secret ───────────────────────────────────────────────────────────

const SESSION_SECRET_SETTING_KEY = 'session_secret';

/**
 * The key express-session signs cookies with, owned by the app rather than the user: minted on first boot
 * and read back on every boot after, so a restart never signs anyone out. The database is the only source
 * of truth — nothing in the environment can set or override it.
 *
 * INSERT OR IGNORE settles the race when a restart overlaps the outgoing server — the loser reads the
 * winner's secret instead of tripping the primary key.
 */
export function getOrCreateSessionSecret(): string {
	const connection = getDatabase();
	connection.exec(`
		CREATE TABLE IF NOT EXISTS app_settings (
			key   TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);
	`);
	connection.prepare('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)')
		.run(SESSION_SECRET_SETTING_KEY, randomBytes(32).toString('hex'));
	return (connection.prepare('SELECT value FROM app_settings WHERE key = ?')
		.get(SESSION_SECRET_SETTING_KEY) as { value: string }).value;
}
