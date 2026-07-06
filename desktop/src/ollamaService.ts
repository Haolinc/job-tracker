// Owns the Ollama daemon's lifecycle: run the preflight (which starts it if present), report when it's
// missing so the launcher can ask the user, download a portable copy on request, and — on quit — stop it,
// but ONLY if this launcher was the one that started it.

import { spawn, spawnSync } from 'node:child_process';
import type { LauncherPaths } from './paths';
import type { LogFn } from './log';
import type { PullProgress } from './shared';

// ensure-ollama.mjs prints this exact phrase ONLY when it launches the daemon itself (vs finding it already
// running) — the launcher's signal that Ollama is ours to stop on quit.
const STARTED_BY_LAUNCHER_MARKER = 'starting `ollama serve`';
// ...and this one when no Ollama is installed and we haven't been told to download it.
const MISSING_MARKER = '[ollama-missing]';
// ensure-ollama.mjs prints this prefix (raw, untagged) for byte-level download progress; we parse it into the
// panel's live line instead of logging it. Keep in sync with the same constant in ensure-ollama.mjs.
const DOWNLOAD_PROGRESS_MARKER = '@download-progress@';
// The modelName we tag the Ollama runtime download's progress with. The panel checks for this to tell the
// (non-cancellable) runtime download apart from model pulls — keep in sync with OLLAMA_DOWNLOAD_LABEL there.
const OLLAMA_DOWNLOAD_LABEL = 'Ollama';

export class OllamaService {
	// True when the preflight had to START Ollama. On quit we stop only what we started: a pre-existing
	// tray/system Ollama is left alone.
	private startedByLauncher = false;
	// Buffers preflight stdout so we can act on whole lines — a progress marker can be split across chunks.
	private stdoutBuffer = '';

	constructor(
		private readonly paths: LauncherPaths,
		private readonly log: LogFn,
		/** Called when a detect run finds no Ollama installed, so the launcher can prompt the user. */
		private readonly onMissing: () => void,
		/** Streams portable-Ollama download progress so the panel can show one live byte line. */
		private readonly onDownloadProgress: (progress: PullProgress) => void,
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
				this.stdoutBuffer += chunk.toString();
				let newlineIndex;
				while ((newlineIndex = this.stdoutBuffer.indexOf('\n')) >= 0) {
					const line = this.stdoutBuffer.slice(0, newlineIndex);
					this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
					this.handleStdoutLine(line);
				}
			});
			preflight.stderr.on('data', (chunk: Buffer) => this.log('ollama', chunk.toString()));
			preflight.on('exit', () => {
				if (this.stdoutBuffer) this.handleStdoutLine(this.stdoutBuffer);   // flush any tail without a newline
				this.stdoutBuffer = '';
				resolve();
			});
		});
	}

	private handleStdoutLine(line: string): void {
		// Download-progress markers drive the panel's live byte line — parse them, don't echo them as raw text.
		if (line.startsWith(DOWNLOAD_PROGRESS_MARKER)) {
			this.emitDownloadProgress(line.slice(DOWNLOAD_PROGRESS_MARKER.length).trim());
			return;
		}
		if (line.includes(STARTED_BY_LAUNCHER_MARKER)) this.startedByLauncher = true;
		if (line.includes(MISSING_MARKER)) this.onMissing();
		this.log('ollama', line);
	}

	private emitDownloadProgress(payload: string): void {
		if (payload === 'done') {
			this.onDownloadProgress({ modelName: OLLAMA_DOWNLOAD_LABEL, status: 'success', completed: 0, total: 0, done: true });
			return;
		}
		if (payload === 'error') {
			this.onDownloadProgress({ modelName: OLLAMA_DOWNLOAD_LABEL, status: 'error: download failed', completed: 0, total: 0, done: true });
			return;
		}
		const [completed, total] = payload.split(' ').map(Number);
		this.onDownloadProgress({ modelName: OLLAMA_DOWNLOAD_LABEL, status: '', completed: completed || 0, total: total || 0, done: false });
	}
}
