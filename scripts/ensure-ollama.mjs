// Preflight for `npm run dev`: make sure a local Ollama is reachable so the email classifier works.
//   • already running (the usual case — the Windows installer runs it in the tray) → nothing to do
//   • installed but not running → start `ollama serve` detached and wait until it answers
//   • not installed → warn and continue; client + server still run, only LLM classification is unavailable
// Always exits 0 so it never blocks `npm run dev`.

import { spawn, spawnSync } from 'node:child_process';

const HOST = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const PING = `${HOST}/api/tags`;   // cheap authenticated-free endpoint that 200s once the daemon is up

const log = (msg) => console.log(`[ensure-ollama] ${msg}`);

/** True when the Ollama HTTP API answers. */
async function isUp() {
	try {
		return (await fetch(PING, { signal: AbortSignal.timeout(1500) })).ok;
	} catch {
		return false;   // connection refused / timeout → not up
	}
}

/** The resolved `ollama` executable path if it's on PATH, else null. */
function resolveOllama() {
	const probe = process.platform === 'win32' ? 'where' : 'which';
	const res = spawnSync(probe, ['ollama'], { encoding: 'utf8' });
	if (res.status !== 0) return null;
	return res.stdout.split(/\r?\n/).find(Boolean)?.trim() ?? null;
}

if (await isUp()) {
	log(`already running at ${HOST}`);
	process.exit(0);
}

const bin = resolveOllama();
if (!bin) {
	log('not found on PATH — continuing without it. LLM classification will be unavailable.');
	log('install it from https://ollama.com to enable email classification.');
	process.exit(0);
}

log('not running — starting `ollama serve`…');
// Detached + unref so the daemon outlives this preflight (and the dev servers) as a shared background service.
spawn(bin, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();

const deadline = Date.now() + 20_000;
while (Date.now() < deadline) {
	await new Promise((resolve) => setTimeout(resolve, 500));
	if (await isUp()) {
		log(`up at ${HOST}`);
		process.exit(0);
	}
}
log('did not become ready within 20s — continuing anyway (the server will retry on first classify).');
process.exit(0);
