// Types shared between the Electron main process, the preload bridge, and the control-panel renderer.

import type { LauncherConfig } from './config';
export type { LauncherConfig } from './config';

/** What the control panel needs to render the status dots and button states. */
export interface LauncherStatus {
	/** The server child process exists (we spawned it and it hasn't exited). */
	serverRunning: boolean;
	/** The server answers /api/health — running AND ready. */
	serverUp: boolean;
	/** Ollama answers on its port — the classifier can work. */
	ollamaUp: boolean;
}

/** A single model-download progress update, streamed as a pull runs so the panel can show one live line. */
export interface PullProgress {
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
}

/** The API the preload script exposes to the control panel as `window.launcher`. */
export interface LauncherBridge {
	startServer(): void;
	stopServer(): void;
	openApp(): void;
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
}
