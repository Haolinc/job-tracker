// Owns the Ollama daemon's lifecycle: run the preflight (which starts it if present), report when it's
// missing so the launcher can ask the user, download a portable copy on request, and — on quit — stop it,
// but ONLY if this launcher was the one that started it.

import { spawn, spawnSync } from 'node:child_process';
import type { LauncherPaths } from './paths';
import type { LogFn } from './log';

// ensure-ollama.mjs prints this exact phrase ONLY when it launches the daemon itself (vs finding it already
// running) — the launcher's signal that Ollama is ours to stop on quit.
const STARTED_BY_LAUNCHER_MARKER = 'starting `ollama serve`';
// ...and this one when no Ollama is installed and we haven't been told to download it.
const MISSING_MARKER = '[ollama-missing]';

export class OllamaService {
	// True when the preflight had to START Ollama. On quit we stop only what we started: a pre-existing
	// tray/system Ollama is left alone.
	private startedByLauncher = false;

	constructor(
		private readonly paths: LauncherPaths,
		private readonly log: LogFn,
		/** Called when a detect run finds no Ollama installed, so the launcher can prompt the user. */
		private readonly onMissing: () => void,
	) {}

	/** Detect + start an existing Ollama (never downloads). Resolves once the preflight exits. */
	ensureRunning(): Promise<void> {
		return this.runPreflight(false);
	}

	/** The user opted in: download the portable Ollama and serve it (the launcher pulls a model afterwards). */
	installPortable(): Promise<void> {
		return this.runPreflight(true);
	}

	/** On quit: stop Ollama ONLY when this launcher started it. Synchronous so quitting can't outrun it. */
	stopIfStartedByLauncher(): void {
		if (!this.startedByLauncher) return;
		this.log('launcher', 'Stopping Ollama (this launcher started it)…');
		if (process.platform === 'win32') spawnSync('taskkill /IM ollama.exe /F', { shell: true });
		else spawnSync('pkill -f "ollama serve"', { shell: true });
		this.startedByLauncher = false;
	}

	private runPreflight(optInToDownload: boolean): Promise<void> {
		return new Promise((resolve) => {
			// OLLAMA_PORTABLE_DIR tells the preflight where to download/find a portable Ollama (kept in app
			// data). Dev has system Node; a package doesn't, so run under Electron's own bundled Node. (Dev
			// keeps the shell form — a single command string, since an args array + shell is deprecated, DEP0190.)
			const preflightEnv = { ...process.env, OLLAMA_PORTABLE_DIR: this.paths.ollamaPortableDir };
			const scriptArgs = optInToDownload ? ['--install'] : [];
			const preflight = this.paths.runningPackaged
				? spawn(process.execPath, [this.paths.ensureOllamaScript, ...scriptArgs], { cwd: this.paths.resourcesRoot, env: { ...preflightEnv, ELECTRON_RUN_AS_NODE: '1' } })
				: spawn(`node "${this.paths.ensureOllamaScript}" ${scriptArgs.join(' ')}`.trim(), { cwd: this.paths.resourcesRoot, shell: true, env: preflightEnv });

			preflight.stdout.on('data', (chunk: Buffer) => {
				const outputText = chunk.toString();
				if (outputText.includes(STARTED_BY_LAUNCHER_MARKER)) this.startedByLauncher = true;
				if (outputText.includes(MISSING_MARKER)) this.onMissing();
				this.log('ollama', outputText);
			});
			preflight.stderr.on('data', (chunk: Buffer) => this.log('ollama', chunk.toString()));
			preflight.on('exit', () => resolve());
		});
	}
}
