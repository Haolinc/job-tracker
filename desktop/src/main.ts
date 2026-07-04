// Electron main process: a SIMPLE launcher, not an app shell. It owns the server child process, ensures
// Ollama is up, streams both of their logs to the control panel, and reads/writes the server's .env via
// the config panel. The app itself always opens in the user's default BROWSER — the launcher never hosts
// it. All I/O (spawning, health checks, .env access) lives HERE — the renderer is a pure display surface.

import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { DEFAULT_PORT, readConfig, readEnvFile, writeConfig } from './config';
import type { LauncherConfig } from './config';
import type { LauncherStatus } from './shared';

// dist/main.js lives at desktop/dist/, so the repo root is two levels up.
const repoRoot = path.resolve(__dirname, '../..');
const serverDirectory = path.join(repoRoot, 'server');
const serverEnvPath = path.join(serverDirectory, '.env');
const ensureOllamaScript = path.join(repoRoot, 'scripts', 'ensure-ollama.mjs');

const OLLAMA_HEALTH_URL = 'http://127.0.0.1:11434/api/tags';
const STATUS_POLL_INTERVAL_MS = 2000;
// After stopping the server, give the tree kill this long to release the port before restarting onto it.
const SERVER_RESTART_DELAY_MS = 1500;
// ensure-ollama.mjs prints this exact phrase ONLY when it has to launch the daemon itself (vs finding it
// already running) — it is the launcher's signal that Ollama is ours to stop on quit.
const OLLAMA_STARTED_BY_LAUNCHER_MARKER = 'starting `ollama serve`';

let controlWindow: BrowserWindow | null = null;
let serverProcess: ChildProcess | null = null;
// True when the ensure-ollama preflight had to START Ollama (vs finding it already running). Closing the
// launcher stops only what it started: a tray/system Ollama that predates us is left alone.
let launcherStartedOllama = false;

// ── Config (server/.env) ────────────────────────────────────────────────────

/** Persist the panel's config and apply it — a running server is restarted onto the new values. */
function saveConfig(config: LauncherConfig): void {
	const { generatedSessionSecret } = writeConfig(serverEnvPath, config);
	if (generatedSessionSecret) sendLog('launcher', 'No session secret provided — generated a random one.');
	sendLog('launcher', 'Config saved to server/.env.');
	if (serverProcess) {
		sendLog('launcher', 'Restarting server to apply the new config…');
		stopServer();
		setTimeout(() => void startServer(), SERVER_RESTART_DELAY_MS);
	}
}

const serverPort = () => readEnvFile(serverEnvPath).get('PORT') || DEFAULT_PORT;
const serverUrl = () => `http://localhost:${serverPort()}`;

// ── Logging & status ────────────────────────────────────────────────────────

// Vite/tsx colorize their output; the log pane renders plain text, so drop the ANSI escape codes.
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '');

/** Append lines to the control panel's log console (and mirror to the launcher's own stdout). */
function sendLog(source: string, chunk: string): void {
	for (const line of stripAnsi(chunk).split(/\r?\n/)) {
		if (!line.trim()) continue;
		const taggedLine = `[${source}] ${line}`;
		console.log(taggedLine);
		controlWindow?.webContents.send('launcher:log', taggedLine);
	}
}

/** True when `url` answers HTTP within the timeout. */
async function isReachable(url: string): Promise<boolean> {
	try {
		return (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok;
	} catch {
		return false;
	}
}

async function pushStatus(): Promise<void> {
	if (!controlWindow) return;   // nobody to display it — skip the two health probes
	const status: LauncherStatus = {
		serverRunning: serverProcess !== null,
		serverUp: await isReachable(`${serverUrl()}/api/health`),
		ollamaUp: await isReachable(OLLAMA_HEALTH_URL),
	};
	controlWindow?.webContents.send('launcher:status', status);
}

// ── Server lifecycle ────────────────────────────────────────────────────────

/** Run the existing preflight script; its output streams into the log pane. Never rejects (exit 0 always). */
function ensureOllama(): Promise<void> {
	return new Promise((resolve) => {
		// Single command string with shell:true (an args array there is deprecated — DEP0190).
		const preflightProcess = spawn(`node "${ensureOllamaScript}"`, { cwd: repoRoot, shell: true });
		preflightProcess.stdout.on('data', (chunk: Buffer) => {
			const outputText = chunk.toString();
			if (outputText.includes(OLLAMA_STARTED_BY_LAUNCHER_MARKER)) launcherStartedOllama = true;
			sendLog('ollama', outputText);
		});
		preflightProcess.stderr.on('data', (chunk: Buffer) => sendLog('ollama', chunk.toString()));
		preflightProcess.on('exit', () => resolve());
	});
}

/** On quit: take down Ollama ONLY when this launcher started it — never a pre-existing instance. */
function stopOllamaIfLauncherStartedIt(): void {
	if (!launcherStartedOllama) return;
	sendLog('launcher', 'Stopping Ollama (this launcher started it)…');
	// Synchronous so quitting can't outrun it.
	if (process.platform === 'win32') spawnSync('taskkill /IM ollama.exe /F', { shell: true });
	else spawnSync('pkill -f "ollama serve"', { shell: true });
	launcherStartedOllama = false;
}

async function startServer(): Promise<void> {
	if (serverProcess) {
		sendLog('launcher', 'Server is already running.');
		return;
	}
	// Something ELSE already answers on the port (a dev server, or an earlier launcher's leftover) —
	// spawning into it would just crash with EADDRINUSE. Reuse it: the dots go green and Open App works;
	// Stop only affects servers this launcher started.
	if (await isReachable(`${serverUrl()}/api/health`)) {
		sendLog('launcher', `A server is already running at ${serverUrl()} — reusing it instead of starting another.`);
		void pushStatus();
		return;
	}
	await ensureOllama();
	sendLog('launcher', 'Starting server…');
	serverProcess = spawn('npm run start', {
		cwd: serverDirectory,
		shell: true,   // npm is npm.cmd on Windows
		env: {
			...process.env,
			// Single-process mode: the server serves the built client, so OAuth redirects and CORS must
			// point at the server's own origin, not the Vite dev port.
			CLIENT_URL: serverUrl(),
		},
	});
	serverProcess.stdout?.on('data', (chunk: Buffer) => sendLog('server', chunk.toString()));
	serverProcess.stderr?.on('data', (chunk: Buffer) => sendLog('server', chunk.toString()));
	serverProcess.on('exit', (code) => {
		sendLog('launcher', `Server exited${code === null ? '' : ` (code ${code})`}.`);
		serverProcess = null;
		void pushStatus();
	});
	void pushStatus();
}

function stopServer(): void {
	if (!serverProcess) return;
	sendLog('launcher', 'Stopping server…');
	if (process.platform === 'win32' && serverProcess.pid) {
		// shell:true means a process tree (cmd → npm → node); taskkill /T is the only reliable tree kill.
		// SYNCHRONOUS on purpose: this also runs during quit, and an async kill loses the race with app
		// exit — the launcher disappears while the server lives on.
		spawnSync(`taskkill /PID ${serverProcess.pid} /T /F`, { shell: true });
	} else {
		serverProcess.kill('SIGTERM');
	}
	serverProcess = null;
}

// ── Windows & wiring ────────────────────────────────────────────────────────

function createControlWindow(): void {
	controlWindow = new BrowserWindow({
		width: 860,
		height: 620,
		title: 'Job Tracker Launcher',
		webPreferences: { preload: path.join(__dirname, 'preload.js') },
	});
	// Surface renderer-side failures in the launcher's own stdout — a broken preload or a panel script
	// error otherwise fails silently and the window just sits there dead.
	controlWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
		console.error(`[panel] preload failed (${preloadPath}):`, error);
	});
	controlWindow.webContents.on('console-message', (details) => {
		if (details.level === 'error' || details.level === 'warning') console.log(`[panel] ${details.message}`);
	});
	void controlWindow.loadFile(path.join(__dirname, '../control.html'));
	controlWindow.on('closed', () => { controlWindow = null; });
}

ipcMain.on('launcher:start', () => void startServer());
ipcMain.on('launcher:stop', () => stopServer());
// The app lives in the browser — the launcher just points the default browser at it.
ipcMain.on('launcher:open-app', () => void shell.openExternal(serverUrl()));
ipcMain.handle('launcher:get-config', () => readConfig(serverEnvPath));
ipcMain.handle('launcher:save-config', (_event, config: LauncherConfig) => saveConfig(config));

// One launcher at a time: a second launch just focuses the existing window instead of spawning a rival
// that would fight over the same port and server process.
if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on('second-instance', () => {
		if (controlWindow) {
			if (controlWindow.isMinimized()) controlWindow.restore();
			controlWindow.focus();
		}
	});

	app.whenReady().then(() => {
		createControlWindow();
		controlWindow?.webContents.once('did-finish-load', () => {
			sendLog('launcher', 'Launcher ready.');
			void startServer();   // auto-start: the panel is for watching, not ceremony
		});
		setInterval(() => void pushStatus(), STATUS_POLL_INTERVAL_MS);
	});
}

app.on('window-all-closed', () => {
	stopServer();
	stopOllamaIfLauncherStartedIt();
	app.quit();
});

app.on('before-quit', () => {
	stopServer();
	stopOllamaIfLauncherStartedIt();
});
