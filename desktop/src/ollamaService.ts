// Owns the Ollama daemon's lifecycle: run the preflight to detect (or download) it, start `ollama serve`
// ourselves when it's installed but down, report when it's missing so the launcher can ask the user, and — on
// quit — stop it, but ONLY if this launcher was the one that started it.

import { spawn, spawnSync } from 'node:child_process';
import { isReachable } from './health';
import type { LauncherPaths } from './paths';
import type { LogFn } from './log';
import type { PullProgress } from './shared';

// Same daemon the preflight targets — honour OLLAMA_HOST so a custom host/port is reached consistently.
const OLLAMA_BASE_URL = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const OLLAMA_HEALTH_URL = `${OLLAMA_BASE_URL}/api/tags`;   // cheap auth-free endpoint that 200s once the daemon is up
// ensure-ollama.mjs prints this once it has resolved the ollama exe but found the daemon down. WE start serve
// (not the throwaway preflight) so it outlives the preflight AND — since the launcher is a GUI process with no
// console — serve gets its own HIDDEN console that its GPU-discovery probes inherit, instead of each flashing a
// window. Payload: "<exePath>\t<portableModelsDir or empty>". Keep in sync with ensure-ollama.mjs.
const START_SERVE_MARKER = '@start-serve@';
// Printed when no Ollama is installed and we haven't been told to download it.
const MISSING_MARKER = '[ollama-missing]';
// ensure-ollama.mjs prints this prefix (raw, untagged) for byte-level download progress; we parse it into the
// panel's live line instead of logging it. Keep in sync with the same constant in ensure-ollama.mjs.
const DOWNLOAD_PROGRESS_MARKER = '@download-progress@';
// The modelName we tag the Ollama runtime download's progress with. The panel checks for this to tell the
// (non-cancellable) runtime download apart from model pulls — keep in sync with OLLAMA_DOWNLOAD_LABEL there.
const OLLAMA_DOWNLOAD_LABEL = 'Ollama';

export class OllamaService {
	// True when THIS launcher started Ollama. On quit we stop only what we started: a pre-existing
	// tray/system Ollama is left alone.
	private startedByLauncher = false;
	// Buffers preflight stdout so we can act on whole lines — a progress marker can be split across chunks.
	private stdoutBuffer = '';
	// Set when the preflight resolves an exe but finds the daemon down: we start serve after it exits (below).
	private pendingServe: { exe: string; modelsDir: string } | null = null;

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
		// Direct exe spawns (no shell) so windowsHide actually suppresses the console flash on Windows.
		// /T kills the whole tree: a loaded model runs in a llama-server.exe CHILD holding the model's multi-GB
		// memory, and force-killing ollama.exe alone orphans it — it would sit there until its keep_alive... never
		// fires, because its parent daemon is gone. Tree-kill takes both down together.
		if (process.platform === 'win32') spawnSync('taskkill', ['/IM', 'ollama.exe', '/T', '/F'], { windowsHide: true });
		else spawnSync('pkill', ['-f', 'ollama serve']);
		this.startedByLauncher = false;
	}

	private runPreflight(optInToDownload: boolean): Promise<void> {
		return new Promise((resolve) => {
			// OLLAMA_PORTABLE_DIR tells the preflight where to download/find a portable Ollama (kept in app
			// data). Dev has system Node; a package doesn't, so run under Electron's own bundled Node. Both
			// branches spawn the exe directly (no shell) so windowsHide keeps the console hidden — and the
			// preflight's own children (`where`, `tar`) inherit that hidden console instead of popping windows.
			const preflightEnv = { ...process.env, OLLAMA_PORTABLE_DIR: this.paths.ollamaPortableDir };
			const scriptArgs = optInToDownload ? ['--install'] : [];
			const preflight = this.paths.runningPackaged
				? spawn(process.execPath, [this.paths.ensureOllamaScript, ...scriptArgs], { cwd: this.paths.resourcesRoot, windowsHide: true, env: { ...preflightEnv, ELECTRON_RUN_AS_NODE: '1' } })
				: spawn('node', [this.paths.ensureOllamaScript, ...scriptArgs], { cwd: this.paths.resourcesRoot, windowsHide: true, env: preflightEnv });

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
			preflight.on('exit', async () => {
				if (this.stdoutBuffer) this.handleStdoutLine(this.stdoutBuffer);   // flush any tail without a newline
				this.stdoutBuffer = '';
				if (this.pendingServe) {
					const { exe, modelsDir } = this.pendingServe;
					this.pendingServe = null;
					await this.startServeAndWait(exe, modelsDir);
				}
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
		if (line.startsWith(START_SERVE_MARKER)) {
			const [exe = '', modelsDir = ''] = line.slice(START_SERVE_MARKER.length).trim().split('\t');
			this.pendingServe = { exe, modelsDir };
			return;   // internal handoff, not a log line
		}
		if (line.includes(MISSING_MARKER)) this.onMissing();
		this.log('ollama', line);
	}

	/** Start `ollama serve` as the launcher's own child, then poll until it answers. Spawned by the launcher (a
	 *  GUI process with no console) with windowsHide, serve gets its OWN hidden console — so it outlives the
	 *  throwaway preflight AND its ~20 GPU-discovery probes inherit that console instead of each flashing a
	 *  window. We stop it on quit via stopIfStartedByLauncher. */
	private async startServeAndWait(exe: string, modelsDir: string): Promise<void> {
		if (!exe) return;
		this.log('launcher', 'Starting `ollama serve`…');
		const env = modelsDir ? { ...process.env, OLLAMA_MODELS: modelsDir } : process.env;
		spawn(exe, ['serve'], { stdio: 'ignore', windowsHide: true, env }).unref();
		this.startedByLauncher = true;
		const deadline = Date.now() + 20_000;
		while (Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 500));
			if (await isReachable(OLLAMA_HEALTH_URL)) { this.log('ollama', `up at ${OLLAMA_BASE_URL}`); return; }
		}
		this.log('ollama', 'Ollama did not become ready within 20s — continuing; it will retry on first classify.');
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
