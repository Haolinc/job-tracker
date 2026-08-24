import dotenv from 'dotenv';
// ENV_FILE lets the launcher point a packaged server at a writable .env outside the read-only app folder;
// unset (dev) falls back to dotenv's default of ./.env.
dotenv.config(process.env.ENV_FILE ? { path: process.env.ENV_FILE } : undefined);

import { enable, setDebugLogging } from './logger';
// DEBUG_LOG is the launcher's "Debug logging" checkbox. Off (the default) keeps the per-email trace out of the
// file, leaving the sync milestones and any warning/error — enough to see what ran without megabytes of email.
setDebugLogging(process.env.DEBUG_LOG === 'true');
// LOG_DIR likewise redirects the logs/ folder to a writable location when packaged; unset → next to the module.
if (process.env.LOG_TO_FILE !== 'false') enable(process.env.LOG_DIR ? { directory: process.env.LOG_DIR } : undefined);

// Watchdog: when the desktop launcher spawns us it passes its own PID as LAUNCHER_PID. The launcher stops us
// cleanly on a normal quit, but if it is force-killed or crashes, its exit handlers never run and we would
// orphan (holding the port). So poll the launcher and self-exit once it is gone. `kill(pid, 0)` sends no
// signal — it only asks "does this process still exist?", throwing if not. unref() keeps this timer from
// holding the server alive on its own. Absent LAUNCHER_PID (plain dev run) there is no parent to watch.
const launcherPid = Number(process.env.LAUNCHER_PID);
if (launcherPid) {
	setInterval(() => {
		try {
			process.kill(launcherPid, 0);
		} catch {
			console.log('Launcher process is gone — shutting the server down.');
			process.exit(0);
		}
	}, 3000).unref();
}

const required = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'];
for (const key of required) {
	if (!process.env[key]) {
		// Every required key is also editable in the launcher's Config panel (see desktop/src/config.ts),
		// which is where a desktop user sets these — the .env file is the dev-facing path to the same values.
		console.error(`ERROR: ${key} is not set. Add it via the launcher's Config panel, or to your .env file.`);
		process.exit(1);
	}
}

import { existsSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import session from 'express-session';
import { initializeDatabase } from './services/db';
import { SqliteSessionStore, getOrCreateSessionSecret } from './services/sessionStore';
import applicationsRouter from './routes/applications';
import authRouter from './routes/auth';
import gmailRouter from './routes/gmail';
import { warmUpModel } from './services/classifier';
import './types';

// The database must exist before anything asks for it — the session store below reads it in its constructor.
try {
	initializeDatabase();
	console.log('Connected to SQLite');
} catch (error) {
	console.error('Failed to open the SQLite database:', error);
	process.exit(1);
}

const app = express();

app.use(cors({
	origin: process.env.CLIENT_URL || 'http://localhost:5173',
	credentials: true,
}));

// 10mb: a CSV import ships its whole mutation plan in ONE request (hundreds of applications with
// notes and email refs) — the express default of 100kb 413s a full-board import.
app.use(express.json({ limit: '10mb' }));

app.use(session({
	// App-owned (see getOrCreateSessionSecret); the env var still wins, so existing installs keep their sessions.
	secret: process.env.SESSION_SECRET || getOrCreateSessionSecret(),
	resave: false,
	saveUninitialized: false,
	cookie: { secure: process.env.NODE_ENV === 'production', httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 },
	store: new SqliteSessionStore(),
}));

app.use('/api/applications', applicationsRouter);
app.use('/api/auth', authRouter);
app.use('/api/gmail', gmailRouter);

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// Single-process mode: when a client build exists, serve it from this server (same origin, so the client's
// relative /api baseURL just works). Dev workflow is unchanged — Vite on :5173 proxies /api here and this
// block is simply unused; without a build (fresh clone, dev-only), the server is API-only as before.
// CLIENT_DIST is set by the launcher in a package (where the build lives under resources/, not beside the
// compiled server); unset (dev) uses the repo-relative build that the tsx-run server sees at ../client/dist.
const clientDistPath = process.env.CLIENT_DIST || path.resolve(__dirname, '../client/dist');
if (existsSync(clientDistPath)) {
	app.use(express.static(clientDistPath));
	// SPA fallback: any non-API GET serves index.html so client-side routes survive a refresh.
	app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(clientDistPath, 'index.html')));
	console.log('Serving client build from client/dist');
}

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
	console.log(`Server running on http://localhost:${PORT}`);
	// Preload the classifier model so the first real email isn't slowed by a cold model load. Fire-and-forget:
	// it retries while Ollama finishes starting and never blocks the server.
	void warmUpModel();
});
