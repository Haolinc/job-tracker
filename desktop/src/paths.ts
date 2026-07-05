// Every filesystem location the launcher touches, resolved once for whichever layout we're running in.

import { app } from 'electron';
import path from 'node:path';

export interface LauncherPaths {
	/** true when running from a packaged build (vs the dev checkout). */
	runningPackaged: boolean;
	/** Root the shipped resources sit under — the repo in dev, process.resourcesPath in a package. */
	resourcesRoot: string;
	serverDirectory: string;
	serverEntryPoint: string;
	clientDistDirectory: string;
	ensureOllamaScript: string;
	serverEnvPath: string;
	serverDatabasePath: string;
	serverLogPath: string;
}

/**
 * Resolve paths for both layouts:
 *  - Dev: everything lives in the repo (this file compiles to desktop/dist/, so the repo root is two up).
 *  - Packaged: server/, scripts/, and client/ ship as extraResources under process.resourcesPath, and
 *    anything WRITABLE (.env, database, logs) goes to the per-user app-data dir — never inside the
 *    read-only app bundle.
 */
export function resolveLauncherPaths(): LauncherPaths {
	const runningPackaged = app.isPackaged;
	const resourcesRoot = runningPackaged ? process.resourcesPath : path.resolve(__dirname, '../..');
	const writableDataDir = runningPackaged ? app.getPath('userData') : path.join(resourcesRoot, 'server');
	const serverDirectory = path.join(resourcesRoot, 'server');

	return {
		runningPackaged,
		resourcesRoot,
		serverDirectory,
		serverEntryPoint: path.join(serverDirectory, 'dist', 'index.js'),
		clientDistDirectory: path.join(resourcesRoot, 'client', 'dist'),
		ensureOllamaScript: path.join(resourcesRoot, 'scripts', 'ensure-ollama.mjs'),
		serverEnvPath: path.join(writableDataDir, '.env'),
		serverDatabasePath: path.join(writableDataDir, 'job-tracker.db'),
		serverLogPath: path.join(writableDataDir, 'sync.log'),
	};
}
