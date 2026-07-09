// Owns the API server child process: start (reusing an already-running server if one answers), stop, and
// the dev-vs-packaged spawn difference. Reports state changes back so the caller can refresh status.

import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isReachable } from './health';
import type { LauncherPaths } from './paths';
import type { LogFn } from './log';
import type { OllamaService } from './ollamaService';
import type { SyncProgressEvent } from './shared';

// The server mirrors each sync progress event to stdout as "@sync-progress@ {json}" — keep in sync with the
// same constant in server/routes/gmail.ts. Parsed into the panel's live sync line instead of logged as text.
// (The server routes its output at the source: per-email debug detail goes to the debug log only and never
// reaches stdout, so everything arriving here is either a marker or a line meant for the panel.)
const SYNC_PROGRESS_MARKER = '@sync-progress@';

export class ServerManager {
	private childProcess: ChildProcess | null = null;
	// Buffers server stdout so we act on whole lines — a marker line can be split across chunks.
	private stdoutRemainder = '';

	constructor(
		private readonly paths: LauncherPaths,
		private readonly log: LogFn,
		private readonly serverUrl: () => string,
		private readonly ollama: OllamaService,
		private readonly onStateChange: () => void,
		private readonly onSyncProgress: (event: SyncProgressEvent) => void,
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
		this.childProcess.stdout?.on('data', (chunk: Buffer) => this.handleStdoutChunk(chunk.toString()));
		this.childProcess.stderr?.on('data', (chunk: Buffer) => this.log('server', chunk.toString()));
		this.childProcess.on('exit', (code) => {
			if (this.stdoutRemainder) { this.handleServerLine(this.stdoutRemainder); this.stdoutRemainder = ''; }
			this.log('launcher', `Server exited${code === null ? '' : ` (code ${code})`}.`);
			this.childProcess = null;
			this.onStateChange();
		});
		this.onStateChange();
	}

	// Server stdout is parsed line by line (a chunk can split a line): sync-progress markers feed the panel's
	// live sync line, everything else is logged as before.
	private handleStdoutChunk(chunk: string): void {
		this.stdoutRemainder += chunk;
		let newlineIndex;
		while ((newlineIndex = this.stdoutRemainder.indexOf('\n')) >= 0) {
			const line = this.stdoutRemainder.slice(0, newlineIndex);
			this.stdoutRemainder = this.stdoutRemainder.slice(newlineIndex + 1);
			this.handleServerLine(line);
		}
	}

	private handleServerLine(line: string): void {
		if (line.startsWith(SYNC_PROGRESS_MARKER)) {
			try {
				this.onSyncProgress(JSON.parse(line.slice(SYNC_PROGRESS_MARKER.length)) as SyncProgressEvent);
			} catch {
				// A malformed marker line is dropped — the next event refreshes the panel anyway.
			}
			return;
		}
		this.log('server', line);
	}

	stop(): void {
		if (!this.childProcess) return;
		this.log('launcher', 'Stopping server…');
		if (process.platform === 'win32' && this.childProcess.pid) {
			// The server is a process tree (cmd → npm → node); taskkill /T is the only reliable tree kill.
			// SYNCHRONOUS on purpose: this also runs during quit, and an async kill loses the race with app
			// exit — the launcher disappears while the server lives on. Direct exe spawn (no shell) so
			// windowsHide actually suppresses taskkill's console flash.
			spawnSync('taskkill', ['/PID', String(this.childProcess.pid), '/T', '/F'], { windowsHide: true });
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
			windowsHide: true,   // don't pop a console window for the server child (Electron is a GUI app)
			env: {
				...process.env,
				ELECTRON_RUN_AS_NODE: '1',
				// So the server can self-exit if this launcher is force-killed (its stop() never runs then).
				LAUNCHER_PID: String(process.pid),
				CLIENT_URL: this.serverUrl(),
				ENV_FILE: this.paths.serverEnvPath,
				DB_PATH: this.paths.serverDatabasePath,
				LOG_DIR: this.paths.serverLogsDirectory,
				CLIENT_DIST: this.paths.clientDistDirectory,
			},
		});
	}

	// Dev: system Node is present — keep the familiar tsx npm script (its better-sqlite3 is built for system
	// Node's ABI, unlike the Electron-ABI copy that ships in the package).
	// LAUNCHER_PID: same force-kill backstop as the packaged path — the dev server (cmd → npm → node) is
	// exactly what orphaned before, and the tree-kill in stop() only runs on a graceful quit.
	private spawnDev(): ChildProcess {
		const env = { ...process.env, CLIENT_URL: this.serverUrl(), LAUNCHER_PID: String(process.pid) };
		// npm is npm.cmd on Windows, which needs a shell — but `shell: true` makes Node IGNORE windowsHide,
		// so the console pops anyway. Spawn cmd.exe ourselves instead: as a direct exe, windowsHide applies
		// CREATE_NO_WINDOW, and npm → node → tsx inherit that one hidden console rather than each popping a window.
		if (process.platform === 'win32') {
			return spawn('cmd.exe', ['/d', '/s', '/c', 'npm run start'], { cwd: this.paths.serverDirectory, windowsHide: true, env });
		}
		return spawn('npm run start', { cwd: this.paths.serverDirectory, shell: true, env });
	}
}
