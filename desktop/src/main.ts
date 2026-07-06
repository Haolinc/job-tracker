// Electron main process: a SIMPLE launcher, not an app shell. It owns the server child process, ensures
// Ollama is up, streams both of their logs to the control panel, and reads/writes the server's .env via the
// config panel. The app always opens in the user's default BROWSER — the launcher never hosts it.
//
// This file is only the composition root: it wires the focused modules (paths, log, OllamaService,
// ServerManager) to the window, the IPC channels, and the app lifecycle. The real work lives in those
// modules; the renderer is a pure display surface.

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { DEFAULT_PORT, readConfig, readEnvFile, writeConfig } from './config';
import type { LauncherConfig } from './config';
import type { LauncherStatus, PullProgress } from './shared';
import { resolveLauncherPaths } from './paths';
import { createLog } from './log';
import { isReachable } from './health';
import { OllamaService } from './ollamaService';
import { ServerManager } from './serverManager';

// Match the preflight (ensure-ollama.mjs): honour OLLAMA_HOST so a custom port/host reaches the same daemon.
const OLLAMA_BASE_URL = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const OLLAMA_HEALTH_URL = `${OLLAMA_BASE_URL}/api/tags`;
const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download';
const MODEL_LIBRARY_URL = 'https://ollama.com/library';
// Pulled automatically only after a fresh portable install (which ships no models); otherwise the user picks.
const DEFAULT_MODEL = 'qwen2.5:7b';
const STATUS_POLL_INTERVAL_MS = 2000;
// After stopping the server, give the tree kill this long to release the port before restarting onto it.
const SERVER_RESTART_DELAY_MS = 1500;

const paths = resolveLauncherPaths();

let controlWindow: BrowserWindow | null = null;
const log = createLog(() => controlWindow);
const serverUrl = () => `http://localhost:${readEnvFile(paths.serverEnvPath).get('PORT') || DEFAULT_PORT}`;

// Shown at most once per session: when the preflight reports no Ollama, ask the user before downloading it.
let ollamaPromptShown = false;
const ollama = new OllamaService(paths, log, () => {
	if (ollamaPromptShown) return;
	ollamaPromptShown = true;
	void promptOllamaInstall();
}, sendPullProgress);
const server = new ServerManager(paths, log, serverUrl, ollama, () => void pushStatus());

// ── Status ────────────────────────────────────────────────────────────────────

async function pushStatus(): Promise<void> {
	if (!controlWindow) return;   // nobody to display it — skip the health probes
	const status: LauncherStatus = {
		serverRunning: server.isRunning,
		serverUp: await isReachable(`${serverUrl()}/api/health`),
		ollamaUp: await isReachable(OLLAMA_HEALTH_URL),
	};
	controlWindow.webContents.send('launcher:status', status);
}

// Push a model-download progress update to the panel so it can render one live, in-place line.
function sendPullProgress(progress: PullProgress): void {
	controlWindow?.webContents.send('launcher:pull-progress', progress);
}

// ── Models ──────────────────────────────────────────────────────────────────

/**
 * Names of the models installed in the running Ollama, or null when Ollama is unreachable. The panel needs
 * to tell "Ollama is down" (keep the saved choice) apart from "Ollama is up but has no models" (offer none) —
 * an empty array can't express that, so unreachable is its own value.
 */
async function listInstalledModels(): Promise<string[] | null> {
	try {
		const response = await fetch(OLLAMA_HEALTH_URL, { signal: AbortSignal.timeout(1500) });
		if (!response.ok) return null;
		const body = (await response.json()) as { models?: { name: string }[] };
		return (body.models ?? []).map((model) => model.name);
	} catch {
		return null;
	}
}

/** Pull a model via Ollama's streaming API, emitting byte-level progress so the panel shows one live line. */
async function pullModel(modelName: string): Promise<{ ok: boolean; error?: string; alreadyInstalled?: boolean }> {
	// Already installed? Skip the pull — Ollama would just report "success" and we'd falsely say "downloaded".
	// A bare name (no tag) resolves to :latest, which is how /api/tags reports it, so normalise before matching.
	const installedModels = await listInstalledModels();
	const requestedTag = modelName.includes(':') ? modelName : `${modelName}:latest`;
	if (installedModels?.includes(requestedTag)) {
		log('launcher', `Model ${modelName} is already installed — skipping the download.`);
		return { ok: true, alreadyInstalled: true };
	}

	log('launcher', `Downloading model ${modelName}…`);
	try {
		const response = await fetch(`${OLLAMA_BASE_URL}/api/pull`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: modelName, stream: true }),
		});
		if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let pending = '';
		let lastSentAt = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			pending += decoder.decode(value, { stream: true });
			let newlineIndex;
			while ((newlineIndex = pending.indexOf('\n')) >= 0) {
				const line = pending.slice(0, newlineIndex).trim();
				pending = pending.slice(newlineIndex + 1);
				if (!line) continue;
				const event = JSON.parse(line) as { error?: string; status?: string; total?: number; completed?: number };
				if (event.error) throw new Error(event.error);
				// Throttle to ~5/sec; always emit when a layer completes so the line lands on the exact final byte count.
				if (Date.now() - lastSentAt >= 200 || event.completed === event.total) {
					lastSentAt = Date.now();
					sendPullProgress({ modelName, status: event.status ?? '', completed: event.completed ?? 0, total: event.total ?? 0, done: false });
				}
			}
		}
		sendPullProgress({ modelName, status: 'success', completed: 0, total: 0, done: true });
		return { ok: true };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		sendPullProgress({ modelName, status: `error: ${message}`, completed: 0, total: 0, done: true });
		log('launcher', `Failed to download ${modelName}: ${message}`);
		return { ok: false, error: message };
	}
}

/** Ask before a model download starts, so a multi-gigabyte pull is always the user's explicit choice. */
async function confirmModelDownload(modelName: string): Promise<boolean> {
	if (!controlWindow) return false;
	const { response } = await dialog.showMessageBox(controlWindow, {
		type: 'question',
		title: 'Download model',
		message: `Download the classification model "${modelName}"?`,
		detail: 'Language models are large — this is a one-time download of several gigabytes and can take a while. Progress shows in the log below.',
		buttons: ['Download', 'Not now'],
		defaultId: 0,
		cancelId: 1,
	});
	return response === 0;
}

// ── Config panel ────────────────────────────────────────────────────────────

/** Persist the panel's config and apply it: restart a running server, or start it if first-run left none. */
function saveConfig(config: LauncherConfig): void {
	const { generatedSessionSecret } = writeConfig(paths.serverEnvPath, config);
	if (generatedSessionSecret) log('launcher', 'No session secret provided — generated a random one.');
	log('launcher', 'Config saved.');
	if (server.isRunning) {
		log('launcher', 'Restarting server to apply the new config…');
		server.stop();
		setTimeout(() => void server.start(), SERVER_RESTART_DELAY_MS);
	} else {
		// First run: the server had no valid .env and exited, so there's nothing to restart — start it now.
		log('launcher', 'Starting server with the new config…');
		void server.start();
	}
}

// ── Ollama setup ────────────────────────────────────────────────────────────

/**
 * The preflight found no Ollama. Warn the user and let them choose: download it in-app (a big one-time
 * download), get it themselves from ollama.com, or skip. The app runs either way — only classification needs it.
 */
async function promptOllamaInstall(): Promise<void> {
	if (!controlWindow) return;
	const { response } = await dialog.showMessageBox(controlWindow, {
		type: 'warning',
		title: 'Ollama not found',
		message: 'Ollama is needed for email classification, and it was not found on this computer.',
		detail: 'This installs a portable Ollama (~1.5 GB) into the app — a one-time setup. You then choose a classification model to download. Or get Ollama yourself from ollama.com. The app still works without it — only email classification is unavailable.',
		buttons: ['Download in the app', 'Open ollama.com', 'Not now'],
		defaultId: 0,
		cancelId: 2,
	});
	if (response === 0) {
		log('launcher', 'Setting up Ollama — this is a large one-time download…');
		await ollama.installPortable();
		// A fresh portable Ollama ships with no models. Ask before pulling the default so the multi-GB model
		// download is the user's explicit choice — they can also skip and pick one later from Config.
		if (((await listInstalledModels()) ?? []).length === 0) {
			if (await confirmModelDownload(DEFAULT_MODEL)) await pullModel(DEFAULT_MODEL);
			else log('launcher', 'Skipped the model download — choose or download one anytime from Config.');
		}
		void pushStatus();
	} else if (response === 1) {
		void shell.openExternal(OLLAMA_DOWNLOAD_URL);
	} else {
		log('launcher', 'Skipped Ollama setup — classification stays off until Ollama is installed.');
	}
}

// ── Window ────────────────────────────────────────────────────────────────────

function createControlWindow(): void {
	controlWindow = new BrowserWindow({
		width: 860,
		height: 620,
		title: 'Job Tracker Launcher',
		webPreferences: { preload: path.join(__dirname, 'preload.js') },
	});
	// Surface renderer-side failures in the launcher's own stdout — a broken preload or a panel script error
	// otherwise fails silently and the window just sits there dead.
	controlWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
		console.error(`[panel] preload failed (${preloadPath}):`, error);
	});
	controlWindow.webContents.on('console-message', (details) => {
		if (details.level === 'error' || details.level === 'warning') console.log(`[panel] ${details.message}`);
	});
	void controlWindow.loadFile(path.join(__dirname, '../control.html'));
	controlWindow.on('closed', () => { controlWindow = null; });
}

// ── IPC wiring ────────────────────────────────────────────────────────────────

ipcMain.on('launcher:start', () => void server.start());
ipcMain.on('launcher:stop', () => server.stop());
ipcMain.on('launcher:open-app', () => void shell.openExternal(serverUrl()));   // the app lives in the browser
ipcMain.handle('launcher:get-config', () => readConfig(paths.serverEnvPath));
ipcMain.handle('launcher:save-config', (_event, config: LauncherConfig) => saveConfig(config));
ipcMain.handle('launcher:list-models', () => listInstalledModels());
ipcMain.handle('launcher:pull-model', (_event, modelName: string) => pullModel(modelName));
ipcMain.on('launcher:browse-models', () => void shell.openExternal(MODEL_LIBRARY_URL));

// ── App lifecycle ───────────────────────────────────────────────────────────

/** Stop everything this launcher started; a reused server or pre-existing Ollama is left alone. */
function shutDown(): void {
	server.stop();
	ollama.stopIfStartedByLauncher();
}

// One launcher at a time: a second launch just focuses the existing window instead of spawning a rival that
// would fight over the same port and server process.
if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on('second-instance', () => {
		if (!controlWindow) return;
		if (controlWindow.isMinimized()) controlWindow.restore();
		controlWindow.focus();
	});

	app.whenReady().then(() => {
		createControlWindow();
		controlWindow?.webContents.once('did-finish-load', () => {
			log('launcher', 'Launcher ready.');
			void server.start();   // auto-start: the panel is for watching, not ceremony
		});
		setInterval(() => void pushStatus(), STATUS_POLL_INTERVAL_MS);
	});
}

app.on('window-all-closed', () => { shutDown(); app.quit(); });
app.on('before-quit', () => shutDown());
