// Types shared between the Electron main process, the preload bridge, and the control-panel renderer.
//
// Declared GLOBALLY on purpose (no top-level import/export keeps this file in ambient/script mode). The
// control panel compiles to a classic script that control.html loads directly, so control.ts cannot import;
// global ambient types are the one shape it can see. The main-process modules see these same globals, so
// every mirror is now one definition and the compiler catches drift instead of a comment asking people to
// keep two copies in sync. Listed in tsconfig.renderer.json (and picked up by tsconfig.json's `include`).

/** The server/.env values the config panel can read and write. */
interface LauncherConfig {
	googleClientId: string;
	googleClientSecret: string;
	googleRedirectUri: string;
	/** Left empty in the panel → a random secret is generated on save. */
	sessionSecret: string;
	port: string;
	/** Ollama model the classifier uses; the panel offers the user's installed models. Empty → server default. */
	ollamaModel: string;
}

/** What the control panel needs to render the status dots and button states. */
interface LauncherStatus {
	/** The server child process exists (we spawned it and it hasn't exited). */
	serverRunning: boolean;
	/** start() is mid-flight — spawning is async (port probe + Ollama warmup), so this fills the gap
	 *  before serverRunning turns true, letting the panel disable Start the instant a start begins. */
	serverStarting: boolean;
	/** The server answers /api/health — running AND ready. */
	serverUp: boolean;
	/** Ollama answers on its port — the classifier can work. */
	ollamaUp: boolean;
	/** The classification model configured in .env (OLLAMA_MODEL), or null when none is set. */
	activeModel: string | null;
	/** The configured model is present in the running Ollama. False when unset or not installed. */
	activeModelInstalled: boolean;
}

/** A single model-download progress update, streamed as a pull runs so the panel can show one live line. */
interface PullProgress {
	/** The model being pulled. */
	modelName: string;
	/** Ollama's phase text for this event, e.g. "pulling manifest", "verifying sha256 digest", "success". */
	status: string;
	/** Bytes downloaded so far for the current layer (0 when this phase isn't a byte transfer). */
	completed: number;
	/** Total bytes for the current layer (0 when unknown, e.g. manifest/verify phases). */
	total: number;
	/** The pull has finished — success unless `status` reports an error. The panel finalizes the line. */
	done: boolean;
	/** False for downloads Cancel can't stop (the Ollama runtime, app updates). Model pulls omit it. */
	cancellable?: boolean;
}

/** Live progress for an in-flight app update (Velopack), so the panel can show one updating line through the
 *  download → staging → ready phases. Separate from PullProgress (model downloads): an update has its own
 *  phase wording and a download-only 0-100 percent, not the pull line's per-layer byte shape. */
interface UpdateProgress {
	/** The target version being installed. */
	version: string;
	/** Where the update is:
	 *   • 'downloading' — real byte-level progress (percent is a true 0-100 for the download).
	 *   • 'staging'     — a delta's opaque patch-apply step, which Velopack reports NO progress for; the panel
	 *                     shows an animated "please wait" line and ignores percent. Full downloads skip this.
	 *   • 'done'        — downloaded and staged; the real install (the current\ swap) still happens on restart.
	 *   • 'error'       — the download/stage failed (see message).
	 */
	phase: 'downloading' | 'staging' | 'done' | 'error';
	/** 0-100 for the DOWNLOAD only (meaningful during 'downloading'; 100 on 'done'). Ignored for 'staging',
	 *  which has no real progress to report. */
	percent: number;
	/** Bytes fetched / total for the download (present during 'downloading'). */
	bytesCompleted?: number;
	bytesTotal?: number;
	/** What went wrong (present on 'error'). */
	message?: string;
}

/** One event from the server's sync progress stream, mirrored to the launcher so the panel can show a live
 *  sync line instead of the per-email log detail. Mirrors the events routes/gmail.ts sends to the browser. */
interface SyncProgressEvent {
	phase: 'start' | 'warming' | 'progress' | 'done' | 'cancelled' | 'error';
	/** The scan window in days (present on 'start') — how far back this sync searches Gmail. */
	days?: number;
	processed?: number;
	total?: number;
	added?: number;
	updated?: number;
	skipped?: number;
	/** Emails that errored on fetch this run (present on 'done'); retried next sync. */
	failed?: number;
	/** Wall-clock sync duration (present on 'done'). */
	durationMs?: number;
	/** What went wrong (present on 'error'). */
	error?: string;
}

/** The API the preload script exposes to the control panel as `window.launcher`. */
interface LauncherBridge {
	startServer(): void;
	stopServer(): void;
	openApp(): void;
	/** Reveal the server log folder in the OS file manager, so users can find and share logs. */
	openLogsFolder(): void;
	getConfig(): Promise<LauncherConfig>;
	saveConfig(config: LauncherConfig): Promise<void>;
	/** Names of the models installed in the running Ollama, or null when Ollama is unreachable. */
	listInstalledModels(): Promise<string[] | null>;
	/** Pull a model into Ollama; progress streams to the log pane, result reports success/failure/already-present/cancelled. */
	pullModel(modelName: string): Promise<{ ok: boolean; error?: string; alreadyInstalled?: boolean; cancelled?: boolean }>;
	/** Abort the in-flight model pull. Ollama keeps partial data, so a later pull resumes. */
	cancelPull(): void;
	/** Remove an installed model from Ollama, freeing its disk space (a confirm dialog gates it). */
	deleteModel(modelName: string): Promise<{ ok: boolean; error?: string; cancelled?: boolean }>;
	/** Model downloads we recorded as interrupted, reconciled against what's actually installed. */
	listIncompleteDownloads(): Promise<string[]>;
	/** Delete all partial download data to free disk and clear the record. Returns bytes freed. */
	reclaimIncompleteDownloads(): Promise<{ freedBytes: number }>;
	/** Open Ollama's model catalog (ollama.com/library) in the default browser. */
	openModelLibrary(): void;
	onLog(handler: (line: string) => void): void;
	onStatus(handler: (status: LauncherStatus) => void): void;
	/** Live progress for an in-flight model pull, so the panel can show a single updating line. */
	onPullProgress(handler: (progress: PullProgress) => void): void;
	/** Live progress for an in-flight app update, so the panel can show a single updating line. */
	onUpdateProgress(handler: (progress: UpdateProgress) => void): void;
	/** Live progress for a running Gmail sync, so the panel can show a single updating line. */
	onSyncProgress(handler: (event: SyncProgressEvent) => void): void;
}
