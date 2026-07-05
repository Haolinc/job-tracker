// Electron main process: a SIMPLE launcher, not an app shell. It owns the server child process, ensures
// Ollama is up, streams both of their logs to the control panel, and reads/writes the server's .env via the
// config panel. The app always opens in the user's default BROWSER — the launcher never hosts it.
//
// This file is only the composition root: it wires the focused modules (paths, log, OllamaService,
// ServerManager) to the window, the IPC channels, and the app lifecycle. The real work lives in those
// modules; the renderer is a pure display surface.

import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'node:path';
import { DEFAULT_PORT, readConfig, readEnvFile, writeConfig } from './config';
import type { LauncherConfig } from './config';
import type { LauncherStatus } from './shared';
import { resolveLauncherPaths } from './paths';
import { createLog } from './log';
import { isReachable } from './health';
import { OllamaService } from './ollamaService';
import { ServerManager } from './serverManager';

const OLLAMA_HEALTH_URL = 'http://127.0.0.1:11434/api/tags';
const STATUS_POLL_INTERVAL_MS = 2000;
// After stopping the server, give the tree kill this long to release the port before restarting onto it.
const SERVER_RESTART_DELAY_MS = 1500;

const paths = resolveLauncherPaths();

let controlWindow: BrowserWindow | null = null;
const log = createLog(() => controlWindow);
const serverUrl = () => `http://localhost:${readEnvFile(paths.serverEnvPath).get('PORT') || DEFAULT_PORT}`;

const ollama = new OllamaService(paths, log);
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
