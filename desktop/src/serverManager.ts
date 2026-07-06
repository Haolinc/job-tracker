// Owns the API server child process: start (reusing an already-running server if one answers), stop, and
// the dev-vs-packaged spawn difference. Reports state changes back so the caller can refresh status.

import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isReachable } from './health';
import type { LauncherPaths } from './paths';
import type { LogFn } from './log';
import type { OllamaService } from './ollamaService';

export class ServerManager {
	private childProcess: ChildProcess | null = null;

	constructor(
		private readonly paths: LauncherPaths,
		private readonly log: LogFn,
		private readonly serverUrl: () => string,
		private readonly ollama: OllamaService,
		private readonly onStateChange: () => void,
	) {}

	get isRunning(): boolean {
		return this.childProcess !== null;
	}

	async start(): Promise<void> {
		if (this.childProcess) {
			this.log('launcher', 'Server is already running.');
			return;
		}
		// Something ELSE already answers on the port (a dev server, or an earlier launcher's leftover) —
		// spawning into it would just crash with EADDRINUSE. Reuse it: the dots go green and Open App works;
		// Stop only affects servers this launcher started.
		if (await isReachable(`${this.serverUrl()}/api/health`)) {
			this.log('launcher', `A server is already running at ${this.serverUrl()} — reusing it instead of starting another.`);
			this.onStateChange();
			return;
		}
		if (this.paths.runningPackaged && !existsSync(this.paths.serverEntryPoint)) {
			this.log('launcher', `Server build missing at ${this.paths.serverEntryPoint} — the package looks incomplete.`);
			return;
		}

		await this.ollama.ensureRunning();
		this.log('launcher', 'Starting server…');
		this.childProcess = this.paths.runningPackaged ? this.spawnPackaged() : this.spawnDev();
		this.childProcess.stdout?.on('data', (chunk: Buffer) => this.log('server', chunk.toString()));
		this.childProcess.stderr?.on('data', (chunk: Buffer) => this.log('server', chunk.toString()));
		this.childProcess.on('exit', (code) => {
			this.log('launcher', `Server exited${code === null ? '' : ` (code ${code})`}.`);
			this.childProcess = null;
			this.onStateChange();
		});
		this.onStateChange();
	}

	stop(): void {
		if (!this.childProcess) return;
		this.log('launcher', 'Stopping server…');
		if (process.platform === 'win32' && this.childProcess.pid) {
			// shell:true means a process tree (cmd → npm → node); taskkill /T is the only reliable tree kill.
			// SYNCHRONOUS on purpose: this also runs during quit, and an async kill loses the race with app
			// exit — the launcher disappears while the server lives on.
			spawnSync(`taskkill /PID ${this.childProcess.pid} /T /F`, { shell: true });
		} else {
			this.childProcess.kill('SIGTERM');
		}
		this.childProcess = null;
	}

	// Packaged: no system Node — run the COMPILED server under Electron's bundled Node, pointed at the
	// writable app-data locations for its .env, database, and logs, and at the shipped client build. CLIENT_URL
	// keeps OAuth redirects and CORS on the server's own origin (single-process mode serves the built client).
	private spawnPackaged(): ChildProcess {
		return spawn(process.execPath, [this.paths.serverEntryPoint], {
			cwd: this.paths.serverDirectory,
			env: {
				...process.env,
				ELECTRON_RUN_AS_NODE: '1',
				// So the server can self-exit if this launcher is force-killed (its stop() never runs then).
				LAUNCHER_PID: String(process.pid),
				CLIENT_URL: this.serverUrl(),
				ENV_FILE: this.paths.serverEnvPath,
				DB_PATH: this.paths.serverDatabasePath,
				LOG_FILE: this.paths.serverLogPath,
				CLIENT_DIST: this.paths.clientDistDirectory,
			},
		});
	}

	// Dev: system Node is present — keep the familiar tsx npm script (its better-sqlite3 is built for system
	// Node's ABI, unlike the Electron-ABI copy that ships in the package).
	private spawnDev(): ChildProcess {
		return spawn('npm run start', {
			cwd: this.paths.serverDirectory,
			shell: true,   // npm is npm.cmd on Windows
			// LAUNCHER_PID: same force-kill backstop as the packaged path — the dev server (cmd → npm → node)
			// is exactly what orphaned before, and the tree-kill in stop() only runs on a graceful quit.
			env: { ...process.env, CLIENT_URL: this.serverUrl(), LAUNCHER_PID: String(process.pid) },
		});
	}
}
