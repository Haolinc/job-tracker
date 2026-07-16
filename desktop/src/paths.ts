// Every filesystem location the launcher touches, resolved once for whichever layout we're running in.

import { app } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';

export interface LauncherPaths {
	/** true when running from a packaged build (vs the dev checkout). */
	runningPackaged: boolean;
	/** true for the portable flavour (extracted from the -Portable.zip): Velopack marks it with a
	 *  `.portable` file in the app's root folder. Portable runs keep ALL writable state in a data/ folder
	 *  inside that root, so deleting the extracted folder removes every trace. */
	runningPortable: boolean;
	/** Root the shipped resources sit under — the repo in dev, process.resourcesPath in a package. */
	resourcesRoot: string;
	serverDirectory: string;
	serverEntryPoint: string;
	clientDistDirectory: string;
	ensureOllamaScript: string;
	serverEnvPath: string;
	serverDatabasePath: string;
	/** Folder the server writes its dated debug-/error- log files to. */
	serverLogsDirectory: string;
	/** Where a portable Ollama is downloaded/extracted when the machine has none — kept in app data. */
	ollamaPortableDir: string;
	/** Our record of model downloads that were interrupted, so we can offer to resume/reclaim them later. */
	incompleteDownloadsPath: string;
}

/**
 * Resolve paths for all three layouts:
 *  - Dev: everything lives in the repo (this file compiles to desktop/dist/, so the repo root is two up).
 *  - Installed (Velopack): the app root is %LocalAppData%\JobTracker, holding Update.exe and a current/
 *    folder with the binaries (process.execPath is inside current/). Updates replace current/ wholesale, so
 *    anything WRITABLE (.env, database, logs) goes to the per-user app-data dir — never beside the exe.
 *  - Portable (extracted -Portable.zip): same root structure, but Velopack drops a `.portable` marker in
 *    the root, and writable state goes to data/ INSIDE that root — beside current/ (which updates replace)
 *    and Velopack's own packages/ download dir. The whole app lives and dies with its folder.
 */
/** Under Velopack the exe runs from <root>\current\; the root above it holds Update.exe and the markers. */
export function velopackRootDirectory(): string {
	return path.dirname(path.dirname(process.execPath));
}

/** True when this build ran from a portable extract: Velopack marks its root with a `.portable` file. */
export function isPortableFlavour(): boolean {
	return existsSync(path.join(velopackRootDirectory(), '.portable'));
}

export function resolveLauncherPaths(): LauncherPaths {
	const runningPackaged = app.isPackaged;
	const runningPortable = runningPackaged && isPortableFlavour();
	const resourcesRoot = runningPackaged ? process.resourcesPath : path.resolve(__dirname, '../..');
	let writableDataDir: string;
	if (runningPortable) writableDataDir = path.join(velopackRootDirectory(), 'data');
	else if (runningPackaged) writableDataDir = app.getPath('userData');
	else writableDataDir = path.join(resourcesRoot, 'server');
	// Portable promise: deleting the folder deletes everything. Electron's own profile (cookies, GPU cache)
	// defaults to %APPDATA% — point it under data/ too. Safe here: this resolver runs at module scope in
	// main.ts, before the app is ready, which is the deadline for changing userData.
	if (runningPortable) app.setPath('userData', path.join(writableDataDir, 'electron'));
	const serverDirectory = path.join(resourcesRoot, 'server');

	return {
		runningPackaged,
		runningPortable,
		resourcesRoot,
		serverDirectory,
		serverEntryPoint: path.join(serverDirectory, 'dist', 'index.js'),
		clientDistDirectory: path.join(resourcesRoot, 'client', 'dist'),
		ensureOllamaScript: path.join(resourcesRoot, 'scripts', 'ensure-ollama.mjs'),
		serverEnvPath: path.join(writableDataDir, '.env'),
		serverDatabasePath: path.join(writableDataDir, 'job-tracker.db'),
		serverLogsDirectory: path.join(writableDataDir, 'logs'),
		ollamaPortableDir: path.join(writableDataDir, 'ollama'),
		incompleteDownloadsPath: path.join(writableDataDir, 'incomplete-downloads.json'),
	};
}
