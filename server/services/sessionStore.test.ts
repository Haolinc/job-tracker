import { describe, it, expect, beforeEach } from 'vitest';
import session from 'express-session';
import * as db from './db';
import { SqliteSessionStore } from './sessionStore';

// Explicit lifecycle: point the database at memory, then initialize once for this test process.
process.env.DB_PATH = ':memory:';
db.initializeDatabase();

const store = new SqliteSessionStore();

// The store's contract is callback-based (express-session); promisify each method for the tests.
const getSession = (sessionId: string) =>
	new Promise<session.SessionData | null | undefined>((resolve, reject) =>
		store.get(sessionId, (error, sessionData) => (error ? reject(error) : resolve(sessionData))));
const setSession = (sessionId: string, sessionData: session.SessionData) =>
	new Promise<void>((resolve, reject) => store.set(sessionId, sessionData, (error) => (error ? reject(error) : resolve())));
const destroySession = (sessionId: string) =>
	new Promise<void>((resolve, reject) => store.destroy(sessionId, (error) => (error ? reject(error) : resolve())));
const touchSession = (sessionId: string, sessionData: session.SessionData) =>
	new Promise<void>((resolve, reject) => store.touch(sessionId, sessionData, (error) => (error ? reject(error) : resolve())));

/** A session payload shaped like the app's real one: a cookie plus the Gmail OAuth tokens. */
const sessionWithExpiry = (expires: Date | null): session.SessionData => ({
	cookie: { originalMaxAge: null, expires } as session.Cookie,
	tokens: { access_token: 'access-token-value', refresh_token: 'refresh-token-value' },
} as unknown as session.SessionData);

const oneHourOut = () => new Date(Date.now() + 60 * 60 * 1000);
const oneHourAgo = () => new Date(Date.now() - 60 * 60 * 1000);

beforeEach(() => {
	db.getDatabase().prepare('DELETE FROM sessions').run();
});

describe('SqliteSessionStore', () => {
	it('should round-trip a session with tokens intact (the restart-survival guarantee)', async () => {
		await setSession('session-1', sessionWithExpiry(oneHourOut()));
		const restored = await getSession('session-1');
		expect((restored as { tokens?: { access_token: string } }).tokens?.access_token).toBe('access-token-value');
	});

	it('should return null for an unknown session id', async () => {
		expect(await getSession('never-stored')).toBeNull();
	});

	it('should treat an expired session as missing on read', async () => {
		await setSession('expired-session', sessionWithExpiry(oneHourAgo()));
		expect(await getSession('expired-session')).toBeNull();
	});

	it('should overwrite an existing session on set (INSERT OR REPLACE)', async () => {
		await setSession('session-1', sessionWithExpiry(oneHourOut()));
		const replacement = sessionWithExpiry(oneHourOut());
		(replacement as unknown as { tokens: { access_token: string } }).tokens = { access_token: 'newer-token' };
		await setSession('session-1', replacement);
		const restored = await getSession('session-1');
		expect((restored as { tokens?: { access_token: string } }).tokens?.access_token).toBe('newer-token');
		expect(db.getDatabase().prepare('SELECT COUNT(*) AS total FROM sessions').get()).toEqual({ total: 1 });
	});

	it('should remove the session on destroy', async () => {
		await setSession('session-1', sessionWithExpiry(oneHourOut()));
		await destroySession('session-1');
		expect(await getSession('session-1')).toBeNull();
	});

	it('should extend the expiry on touch without rewriting the payload', async () => {
		await setSession('session-1', sessionWithExpiry(oneHourOut()));
		const before = db.getDatabase().prepare('SELECT expires_at FROM sessions WHERE sid = ?').get('session-1') as { expires_at: number };
		const farOut = new Date(Date.now() + 48 * 60 * 60 * 1000);
		await touchSession('session-1', sessionWithExpiry(farOut));
		const after = db.getDatabase().prepare('SELECT expires_at FROM sessions WHERE sid = ?').get('session-1') as { expires_at: number };
		expect(after.expires_at).toBeGreaterThan(before.expires_at);
		const restored = await getSession('session-1');
		expect((restored as { tokens?: { access_token: string } }).tokens?.access_token).toBe('access-token-value');
	});
});
