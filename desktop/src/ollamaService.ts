// Owns the Ollama daemon's lifecycle: run the preflight (which starts it if needed) and, on quit, stop it —
// but ONLY if this launcher was the one that started it.

import { spawn, spawnSync } from 'node:child_process';
import type { LauncherPaths } from './paths';
import type { LogFn } from './log';

// ensure-ollama.mjs prints this exact phrase ONLY when it has to launch the daemon itself (vs finding it
// already running) — the launcher's signal that Ollama is ours to stop on quit.
const STARTED_BY_LAUNCHER_MARKER = 'starting `ollama serve`';

export class OllamaService {
	// True when the preflight had to START Ollama. On quit we stop only what we started: a pre-existing
	// tray/system Ollama is left alone.
	private startedByLauncher = false;

	constructor(private readonly paths: LauncherPaths, private readonly log: LogFn) {}

	/** Run the preflight script, streaming its output to the log pane. Never rejects (the script always exits 0). */
	ensureRunning(): Promise<void> {
		return new Promise((resolve) => {
			// Dev has system Node; a package doesn't, so run the preflight under Electron's own bundled Node.
			// (Dev keeps the shell form — a single command string, as an args array + shell is deprecated, DEP0190.)
			const preflight = this.paths.runningPackaged
				? spawn(process.execPath, [this.paths.ensureOllamaScript], { cwd: this.paths.resourcesRoot, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
				: spawn(`node "${this.paths.ensureOllamaScript}"`, { cwd: this.paths.resourcesRoot, shell: true });

			preflight.stdout.on('data', (chunk: Buffer) => {
				const outputText = chunk.toString();
				if (outputText.includes(STARTED_BY_LAUNCHER_MARKER)) this.startedByLauncher = true;
				this.log('ollama', outputText);
			});
			preflight.stderr.on('data', (chunk: Buffer) => this.log('ollama', chunk.toString()));
			preflight.on('exit', () => resolve());
		});
	}

	/** On quit: stop Ollama ONLY when this launcher started it. Synchronous so quitting can't outrun it. */
	stopIfStartedByLauncher(): void {
		if (!this.startedByLauncher) return;
		this.log('launcher', 'Stopping Ollama (this launcher started it)…');
		if (process.platform === 'win32') spawnSync('taskkill /IM ollama.exe /F', { shell: true });
		else spawnSync('pkill -f "ollama serve"', { shell: true });
		this.startedByLauncher = false;
	}
}
