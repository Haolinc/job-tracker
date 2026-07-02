// Preflight for `npm run dev`: make sure a local MongoDB is reachable so the server can store applications.
//   • already running (installed as a Windows service, the usual case) → nothing to do
//   • installed but not running → try starting the "MongoDB" service; failing that (no admin rights, or no
//     service configured), spawn `mongod` directly with a repo-local dbpath (data/mongo — gitignored via data/)
//   • not installed → warn and continue; the server will fail on connect with its own error
// Always exits 0 so it never blocks `npm run dev`.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

// server/.env is the single source of connection config (and is gitignored, so machine-specific paths in it
// never reach the repo). Parsed by hand — this script runs before any package's node_modules is guaranteed.
//   MONGODB_URI     → where to health-check (host/port only — auth is the server's business)
//   MONGOD_EXE      → a custom mongod location (e.g. a ZIP install on another drive), tried before PATH
//   MONGOD_DBPATH   → the data directory that mongod already uses — REUSED so a restart keeps existing data
const env = { ...process.env };
try {
	for (const line of readFileSync(path.resolve('server/.env'), 'utf8').split(/\r?\n/)) {
		const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
		if (m && !(m[1] in env)) env[m[1]] = m[2];
	}
} catch { /* no server/.env yet — defaults below still work */ }

const uri = env.MONGODB_URI || 'mongodb://127.0.0.1:27017/job-tracker';
const { hostname: HOST, port } = new URL(uri.replace(/^mongodb(\+srv)?:/, 'http:'));
const PORT = Number(port) || 27017;

const log = (msg) => console.log(`[ensure-mongo] ${msg}`);

/** True when something accepts TCP connections on the Mongo port (Mongo speaks its own protocol, not HTTP). */
function isUp() {
	return new Promise((resolve) => {
		const sock = net.connect({ host: HOST, port: PORT });
		const done = (up) => { sock.destroy(); resolve(up); };
		sock.once('connect', () => done(true));
		sock.once('error', () => done(false));
		sock.setTimeout(1500, () => done(false));
	});
}

/** The `mongod` executable: MONGOD_EXE override first, then PATH, then the default Windows install location
 *  (newest version wins). The override covers ZIP installs that live outside both. */
function resolveMongod() {
	if (env.MONGOD_EXE && existsSync(env.MONGOD_EXE)) return env.MONGOD_EXE;
	const probe = process.platform === 'win32' ? 'where' : 'which';
	const res = spawnSync(probe, ['mongod'], { encoding: 'utf8' });
	if (res.status === 0) return res.stdout.split(/\r?\n/).find(Boolean)?.trim() ?? null;
	if (process.platform === 'win32') {
		const base = 'C:/Program Files/MongoDB/Server';
		try {
			for (const version of readdirSync(base).sort().reverse()) {
				const exe = path.join(base, version, 'bin', 'mongod.exe');
				if (existsSync(exe)) return exe;
			}
		} catch { /* base dir doesn't exist → not installed there */ }
	}
	return null;
}

const waitUntilUp = async (what) => {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 500));
		if (await isUp()) {
			log(`up at ${HOST}:${PORT} (${what})`);
			return true;
		}
	}
	return false;
};

if (await isUp()) {
	log(`already running at ${HOST}:${PORT}`);
	process.exit(0);
}

const mongod = resolveMongod();
if (!mongod) {
	log('MongoDB not found — continuing without it. The server will fail to connect until it is installed.');
	log('install: winget install MongoDB.Server   (or https://www.mongodb.com/try/download/community)');
	process.exit(0);
}

// Prefer the Windows service — it owns the existing data directory, so starting it preserves current data.
// `net start` needs admin rights; when it fails we fall back to a direct spawn below. A MONGOD_EXE override
// means a ZIP install with no service — skip straight to the spawn.
if (process.platform === 'win32' && !env.MONGOD_EXE) {
	log('not running — trying to start the MongoDB service…');
	if (spawnSync('net', ['start', 'MongoDB'], { encoding: 'utf8' }).status === 0 && await waitUntilUp('service')) process.exit(0);
	log('service start failed (needs admin, or no service configured) — spawning mongod directly.');
}

// Direct spawn. MONGOD_DBPATH points at the data directory mongod already uses, so a restart keeps existing
// data; without it we fall back to a repo-local dbpath (data/mongo — gitignored via data/). NOTE: the fallback
// is a DIFFERENT data directory than a service/manual install uses — fine on a fresh setup (empty either way),
// but if your data lives elsewhere, set MONGOD_DBPATH in server/.env.
const dbPath = path.resolve(env.MONGOD_DBPATH || 'data/mongo');
mkdirSync(dbPath, { recursive: true });
log(`starting mongod (dbpath ${dbPath})…`);
spawn(mongod, ['--dbpath', dbPath, '--port', String(PORT)], { detached: true, stdio: 'ignore', windowsHide: true }).unref();

if (!(await waitUntilUp('direct spawn'))) log('did not become ready within 20s — the server will report the connection error.');
process.exit(0);
