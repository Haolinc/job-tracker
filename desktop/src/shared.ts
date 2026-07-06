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

/** The API the preload script exposes to the control panel as `window.launcher`. */
export interface LauncherBridge {
	startServer(): void;
	stopServer(): void;
	openApp(): void;
	getConfig(): Promise<LauncherConfig>;
	saveConfig(config: LauncherConfig): Promise<void>;
	/** Names of the models installed in the running Ollama, for the config panel's model picker. */
	listInstalledModels(): Promise<string[]>;
	/** Pull a model into Ollama; progress streams to the log pane, result reports success/failure. */
	pullModel(modelName: string): Promise<{ ok: boolean; error?: string }>;
	/** Open Ollama's model catalog (ollama.com/library) in the default browser. */
	openModelLibrary(): void;
	onLog(handler: (line: string) => void): void;
	onStatus(handler: (status: LauncherStatus) => void): void;
}
