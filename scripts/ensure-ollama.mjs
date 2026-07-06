// Preflight: make sure a local Ollama DAEMON is reachable so the email classifier can use it. Model choice
// and downloading live in the launcher, not here. Strategy:
//   • Ollama HTTP already answers            → nothing to do
//   • ollama on PATH, or a portable copy we  → start `ollama serve`
//     installed earlier, exists
//   • nothing installed (default run)        → report "[ollama-missing]" and stop — we do NOT download
//                                              behind the user's back; the launcher asks first
//   • nothing installed + `--install`        → the user opted in: download a PORTABLE Ollama into app data
//                                              (nothing system-wide, removable) → serve
//   • non-Windows without Ollama             → warn and continue (portable path is Windows-only for now)
// Always exits 0 so it never blocks startup; classification simply stays unavailable if a step fails.

import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';

const OLLAMA_BASE_URL = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const HEALTH_CHECK_URL = `${OLLAMA_BASE_URL}/api/tags`;   // cheap auth-free endpoint that 200s once the daemon is up

// Portable Ollama lives in app data (passed by the launcher as OLLAMA_PORTABLE_DIR) so it's self-contained
// and removable with the app; a lone dev run falls back to a dot-dir under the home folder.
const portableDir = process.env.OLLAMA_PORTABLE_DIR || path.join(os.homedir(), '.jobtracker-ollama');
const portableExecutable = path.join(portableDir, 'ollama.exe');
const portableModelsDir = path.join(portableDir, 'models');

const PORTABLE_ZIP_URL = 'https://ollama.com/download/ollama-windows-amd64.zip';
// GNU tar (Git's) can't open a zip; the Windows-bundled bsdtar at System32\tar.exe can — call it by full path.
const systemBsdTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');

const log = (message) => console.log(`[ensure-ollama] ${message}`);

/** True when the Ollama HTTP API answers. */
async function isUp() {
	try {
		return (await fetch(HEALTH_CHECK_URL, { signal: AbortSignal.timeout(1500) })).ok;
	} catch {
		return false;   // connection refused / timeout → not up
	}
}

/** The resolved `ollama` executable path if it's on PATH, else null. */
function resolveOllamaOnPath() {
	const probeCommand = process.platform === 'win32' ? 'where' : 'which';
	const probeResult = spawnSync(probeCommand, ['ollama'], { encoding: 'utf8' });
	if (probeResult.status !== 0) return null;
	return probeResult.stdout.split(/\r?\n/).find(Boolean)?.trim() ?? null;
}

/** Stream a download to disk, honouring back-pressure and logging progress every ~10%. */
async function downloadToFile(url, destinationPath) {
	const response = await fetch(url, { redirect: 'follow' });
	if (!response.ok || !response.body) throw new Error(`download failed: HTTP ${response.status}`);
	const totalBytes = Number(response.headers.get('content-length')) || 0;
	const fileStream = createWriteStream(destinationPath);
	const reader = response.body.getReader();

	let receivedBytes = 0;
	let lastLoggedPercent = -10;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!fileStream.write(value)) await once(fileStream, 'drain');   // wait when the buffer is full
		receivedBytes += value.length;
		if (totalBytes) {
			const percent = Math.floor((receivedBytes / totalBytes) * 100);
			if (percent >= lastLoggedPercent + 10) {
				lastLoggedPercent = percent;
				log(`downloading Ollama… ${percent}%`);
			}
		}
	}
	fileStream.end();
	await once(fileStream, 'finish');
}

/** Download + extract a portable Ollama into app data. Returns its exe path, or null if unavailable. */
async function ensurePortableOllama() {
	if (existsSync(portableExecutable)) return portableExecutable;
	if (process.platform !== 'win32') return null;   // portable download is Windows-only for now

	log('Ollama not found — downloading a portable copy (~1.5 GB, one-time). This can take a while…');
	mkdirSync(portableDir, { recursive: true });
	const zipPath = path.join(portableDir, 'ollama-portable.zip');
	try {
		await downloadToFile(PORTABLE_ZIP_URL, zipPath);
		log('extracting Ollama…');
		const extraction = spawnSync(systemBsdTar, ['-xf', zipPath, '-C', portableDir], { stdio: 'inherit' });
		if (extraction.status !== 0) throw new Error(`extraction failed (tar exit ${extraction.status})`);
	} catch (error) {
		log(`could not set up portable Ollama: ${error.message}`);
		return null;
	} finally {
		rmSync(zipPath, { force: true });
	}
	return existsSync(portableExecutable) ? portableExecutable : null;
}

/** Start `ollama serve` detached so it outlives this preflight. Portable copies keep models in app data. */
function startServe(ollamaExecutable, usingPortable) {
	// This exact phrase is the launcher's signal that IT started Ollama (so it stops it on quit) — keep it.
	log('not running — starting `ollama serve`…');
	const serveEnv = usingPortable ? { ...process.env, OLLAMA_MODELS: portableModelsDir } : process.env;
	spawn(ollamaExecutable, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true, env: serveEnv }).unref();
}

/** Poll until the daemon answers, up to `timeoutMs`. Returns whether it came up. */
async function waitUntilUp(timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 500));
		if (await isUp()) return true;
	}
	return false;
}

// ── Orchestration ──────────────────────────────────────────────────────────

// The launcher passes --install only after the user opts in via the "Ollama not found" prompt.
const optedIntoDownload = process.argv.includes('--install');

if (await isUp()) {
	log(`already running at ${OLLAMA_BASE_URL}`);
	process.exit(0);
}

let ollamaExecutable = resolveOllamaOnPath() ?? (existsSync(portableExecutable) ? portableExecutable : null);
let usingPortable = ollamaExecutable === portableExecutable;
if (!ollamaExecutable) {
	if (!optedIntoDownload) {
		// Detect-only run: report it and stop. The launcher shows the user a prompt; if they choose to
		// download in-app, it re-runs this script with --install. [ollama-missing] is the launcher's cue.
		log('Ollama is not installed on this machine. [ollama-missing]');
		process.exit(0);
	}
	ollamaExecutable = await ensurePortableOllama();
	usingPortable = ollamaExecutable !== null;
	if (!ollamaExecutable) {
		log('could not obtain Ollama (non-Windows, or the download failed) — continuing without it.');
		process.exit(0);
	}
}

startServe(ollamaExecutable, usingPortable);
if (await waitUntilUp(20_000)) {
	log(`up at ${OLLAMA_BASE_URL}`);
	process.exit(0);
}
log('did not become ready within 20s — continuing anyway (the server will retry on first classify).');
process.exit(0);
