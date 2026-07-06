// Preflight: work out how the launcher should reach a local Ollama DAEMON for the email classifier. This script
// only DETECTS (and, on request, downloads) Ollama — it does NOT start `ollama serve` itself; it hands the exe
// path back and the launcher starts serve (a long-lived, console-less GUI parent gives serve a hidden console so
// its GPU-discovery probes don't flash windows). Model choice and downloading live in the launcher, not here.
// Strategy:
//   • Ollama HTTP already answers            → nothing to do
//   • ollama on PATH, or a portable copy we  → print @start-serve@ <exe> for the launcher to start
//     installed earlier, exists
//   • nothing installed (default run)        → report "[ollama-missing]" and stop — we do NOT download
//                                              behind the user's back; the launcher asks first
//   • nothing installed + `--install`        → the user opted in: download a PORTABLE Ollama into app data
//                                              (nothing system-wide, removable) → hand its path to the launcher
//   • non-Windows without Ollama             → warn and continue (portable path is Windows-only for now)
// Always exits 0 so it never blocks startup; classification simply stays unavailable if a step fails.

import { spawnSync } from 'node:child_process';
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

// Printed raw on stdout for the launcher to turn into the panel's live download line (must match ollamaService.ts).
const DOWNLOAD_PROGRESS_MARKER = '@download-progress@';
// Printed once we've resolved the ollama exe but found the daemon down: the launcher (a long-lived GUI process
// with no console) starts `ollama serve` itself so its GPU-discovery probes inherit a hidden console instead of
// each flashing a window. Payload is "<exePath>\t<portableModelsDir or empty>". Keep in sync with ollamaService.ts.
const START_SERVE_MARKER = '@start-serve@';

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
	const probeResult = spawnSync(probeCommand, ['ollama'], { encoding: 'utf8', windowsHide: true });
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
	let lastSentAt = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!fileStream.write(value)) await once(fileStream, 'drain');   // wait when the buffer is full
		receivedBytes += value.length;
		// Throttle to ~5/sec; the launcher turns these markers into the panel's live byte/percent line.
		const now = Date.now();
		if (now - lastSentAt >= 200) {
			lastSentAt = now;
			console.log(`${DOWNLOAD_PROGRESS_MARKER} ${receivedBytes} ${totalBytes}`);
		}
	}
	fileStream.end();
	await once(fileStream, 'finish');
	console.log(`${DOWNLOAD_PROGRESS_MARKER} ${receivedBytes} ${totalBytes}`);   // final exact count
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
		const extraction = spawnSync(systemBsdTar, ['-xf', zipPath, '-C', portableDir], { stdio: 'inherit', windowsHide: true });
		if (extraction.status !== 0) throw new Error(`extraction failed (tar exit ${extraction.status})`);
		console.log(`${DOWNLOAD_PROGRESS_MARKER} done`);
	} catch (error) {
		console.log(`${DOWNLOAD_PROGRESS_MARKER} error`);
		log(`could not set up portable Ollama: ${error.message}`);
		return null;
	} finally {
		rmSync(zipPath, { force: true });
	}
	return existsSync(portableExecutable) ? portableExecutable : null;
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

// Daemon is down but we have an exe. Hand it to the launcher to start (see START_SERVE_MARKER above) rather than
// starting it here: the launcher outlives this preflight and gives serve a hidden console, so serve survives and
// its GPU-discovery probes don't flash windows. Payload: "<exePath>\t<portableModelsDir or empty>".
const serveModelsDir = usingPortable ? portableModelsDir : '';
console.log(`${START_SERVE_MARKER} ${ollamaExecutable}\t${serveModelsDir}`);
process.exit(0);
