// Control-panel renderer: pure display. Receives log lines and status pushes from the main process via
// the preload bridge (window.launcher) and renders them; buttons send commands back, and the config panel
// reads/writes server/.env through the bridge. No import/export on purpose — this compiles to a plain
// classic script that control.html loads directly.

// These interfaces MIRROR shared.ts (LauncherStatus/LauncherConfig/LauncherBridge) rather than import
// them: a classic script cannot import, and this file must stay import-free to compile as one.
interface ControlPanelStatus {
	serverRunning: boolean;
	serverUp: boolean;
	ollamaUp: boolean;
}

interface ControlPanelConfig {
	googleClientId: string;
	googleClientSecret: string;
	googleRedirectUri: string;
	sessionSecret: string;
	port: string;
	ollamaModel: string;
}

interface ControlPanelPullProgress {
	modelName: string;
	status: string;
	completed: number;
	total: number;
	done: boolean;
}

interface ControlPanelBridge {
	startServer(): void;
	stopServer(): void;
	openApp(): void;
	getConfig(): Promise<ControlPanelConfig>;
	saveConfig(config: ControlPanelConfig): Promise<void>;
	listInstalledModels(): Promise<string[] | null>;
	pullModel(modelName: string): Promise<{ ok: boolean; error?: string; alreadyInstalled?: boolean }>;
	openModelLibrary(): void;
	onLog(handler: (line: string) => void): void;
	onStatus(handler: (status: ControlPanelStatus) => void): void;
	onPullProgress(handler: (progress: ControlPanelPullProgress) => void): void;
}

declare const launcher: ControlPanelBridge;   // exposed by preload.ts via contextBridge

const logConsole = document.getElementById('log-console') as HTMLDivElement;
const serverDot = document.getElementById('server-dot') as HTMLSpanElement;
const ollamaDot = document.getElementById('ollama-dot') as HTMLSpanElement;
const startButton = document.getElementById('start-button') as HTMLButtonElement;
const stopButton = document.getElementById('stop-button') as HTMLButtonElement;
const openAppButton = document.getElementById('open-app-button') as HTMLButtonElement;
const configButton = document.getElementById('config-button') as HTMLButtonElement;
const configPanel = document.getElementById('config-panel') as HTMLElement;
const saveConfigButton = document.getElementById('save-config-button') as HTMLButtonElement;

// Every config field is a plain text input EXCEPT the model, which is a dropdown of installed models.
type TextConfigField = Exclude<keyof ControlPanelConfig, 'ollamaModel'>;

// Record<…> makes the compiler verify an input exists for every text field — and the derived list below
// keeps load and save in lockstep with the interface.
const configInputs: Record<TextConfigField, HTMLInputElement> = {
	googleClientId: document.getElementById('google-client-id') as HTMLInputElement,
	googleClientSecret: document.getElementById('google-client-secret') as HTMLInputElement,
	googleRedirectUri: document.getElementById('google-redirect-uri') as HTMLInputElement,
	sessionSecret: document.getElementById('session-secret') as HTMLInputElement,
	port: document.getElementById('server-port') as HTMLInputElement,
};
const configFields = Object.keys(configInputs) as TextConfigField[];
const modelSelect = document.getElementById('ollama-model') as HTMLSelectElement;
const refreshModelsButton = document.getElementById('refresh-models-button') as HTMLButtonElement;
const pullModelInput = document.getElementById('pull-model-input') as HTMLInputElement;
const pullModelButton = document.getElementById('pull-model-button') as HTMLButtonElement;
const browseModelsLink = document.getElementById('browse-models-link') as HTMLAnchorElement;

const MAX_LOG_LINES = 2000;
// Duplicates config.ts DEFAULT_PORT by necessity — see the no-import note above.
const DEFAULT_PORT = '3001';
// The recommended default model — floated to the top of the picker and pre-selected on a fresh start.
// Mirrors main.ts DEFAULT_MODEL (the no-import boundary again).
const DEFAULT_MODEL = 'qwen2.5:7b';

// The model saved in .env, remembered so that saving while the picker is disabled (Ollama down, or no models
// installed) preserves the user's choice instead of overwriting it with an empty selection.
let savedOllamaModel = '';

// ── Log console ─────────────────────────────────────────────────────────────

launcher.onLog((line) => {
	// Only autoscroll when the user is already reading the tail — don't yank them back down mid-scroll.
	const pinnedToBottom = logConsole.scrollTop + logConsole.clientHeight >= logConsole.scrollHeight - 8;

	const logLine = document.createElement('div');
	logLine.className = 'log-line';
	if (/error|failed|exception/i.test(line)) logLine.classList.add('error-line');
	if (line.startsWith('[launcher]')) logLine.classList.add('launcher-line');
	logLine.textContent = line;
	logConsole.appendChild(logLine);

	while (logConsole.childElementCount > MAX_LOG_LINES) logConsole.firstElementChild!.remove();
	if (pinnedToBottom) logConsole.scrollTop = logConsole.scrollHeight;
});

// ── Model download progress ──────────────────────────────────────────────────

/** Human-readable bytes: 512 B, 3.4 MB, 4.7 GB. Decimal (1000-based) to match ollama.com's own size labels. */
function formatBytes(byteCount: number): string {
	if (byteCount <= 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	const exponent = Math.min(Math.floor(Math.log(byteCount) / Math.log(1000)), units.length - 1);
	const value = byteCount / 1000 ** exponent;
	return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

/**
 * A self-contained live download line for the log console. It owns one <div> that updates IN PLACE (bytes +
 * percent) instead of appending a line per tick, and finalizes to ✓/✗ when the download ends. Returns the
 * update handler — feed it every progress event. Reusable for any download source (Ollama, model pulls, …);
 * each call makes an independent line, so call it once and reuse the returned handler for one stream at a time.
 */
function createProgressLine(logContainer: HTMLDivElement): (progress: ControlPanelPullProgress) => void {
	// Held across updates so the same line is rewritten; null between downloads so the next one starts fresh.
	let line: HTMLDivElement | null = null;
	return (progress) => {
		const pinnedToBottom = logContainer.scrollTop + logContainer.clientHeight >= logContainer.scrollHeight - 8;

		// Reuse the line unless the log-line cap trimmed it away; then start a fresh one.
		if (!line || !line.isConnected) {
			line = document.createElement('div');
			line.className = 'log-line launcher-line';
			logContainer.appendChild(line);
		}

		if (progress.done) {
			const failed = progress.status.startsWith('error');
			line.textContent = failed ? `✗ ${progress.modelName} — ${progress.status}` : `✓ ${progress.modelName} downloaded`;
			if (failed) line.classList.add('error-line');
			line = null;   // finalize — the next download gets its own line
		} else if (progress.total > 0) {
			const percent = Math.min(100, Math.floor((progress.completed / progress.total) * 100));
			line.textContent = `⬇ ${progress.modelName}  ${formatBytes(progress.completed)} / ${formatBytes(progress.total)}  (${percent}%)`;
		} else {
			line.textContent = `⬇ ${progress.modelName}  ${progress.status || 'preparing'}…`;
		}

		if (pinnedToBottom) logContainer.scrollTop = logContainer.scrollHeight;
	};
}

launcher.onPullProgress(createProgressLine(logConsole));

// ── Status dots & buttons ───────────────────────────────────────────────────

launcher.onStatus((status) => {
	serverDot.classList.toggle('up', status.serverUp);
	ollamaDot.classList.toggle('up', status.ollamaUp);
	startButton.disabled = status.serverRunning;
	stopButton.disabled = !status.serverRunning;
	openAppButton.disabled = !status.serverUp;
});

startButton.addEventListener('click', () => launcher.startServer());
stopButton.addEventListener('click', () => launcher.stopServer());
openAppButton.addEventListener('click', () => launcher.openApp());

// ── Config panel ────────────────────────────────────────────────────────────

async function loadConfigIntoPanel(): Promise<void> {
	const config = await launcher.getConfig();
	for (const configField of configFields) configInputs[configField].value = config[configField];
	savedOllamaModel = config.ollamaModel;
	await refreshModelPicker(savedOllamaModel);
}

/** The recommended default first (when installed), then every other model alphabetically. */
function orderModels(models: string[]): string[] {
	const others = models.filter((name) => name !== DEFAULT_MODEL).sort((first, second) => first.localeCompare(second));
	return models.includes(DEFAULT_MODEL) ? [DEFAULT_MODEL, ...others] : others;
}

/** Enable or disable the "download a model" field — off when there is no reachable Ollama to pull into. */
function setDownloadEnabled(enabled: boolean): void {
	pullModelInput.disabled = !enabled;
	pullModelButton.disabled = !enabled;
}

/**
 * Reflect Ollama's state in the model picker and the download field:
 *   • unreachable    → nothing to pick and no way to pull: both disabled
 *   • up, no models  → nothing to pick yet, but the user can type a model to download
 *   • up, has models → the default (qwen) on top, the rest alphabetical; only installed models are selectable
 * A returning user keeps their saved choice when it's still installed; a fresh start lands on the default.
 */
async function refreshModelPicker(savedModel: string): Promise<void> {
	const installedModels = await launcher.listInstalledModels();   // null → Ollama unreachable
	modelSelect.replaceChildren();

	// State 1 — Ollama not found: can't list or verify anything, so offer nothing and lock the controls.
	if (installedModels === null) {
		modelSelect.appendChild(new Option('Ollama not running', ''));
		modelSelect.value = '';
		modelSelect.disabled = true;
		setDownloadEnabled(false);
		return;
	}

	// State 2 — Ollama up but no models: nothing to select yet; downloading is the way to get one.
	if (installedModels.length === 0) {
		modelSelect.appendChild(new Option('No models installed — download one below', ''));
		modelSelect.value = '';
		modelSelect.disabled = true;
		setDownloadEnabled(true);
		return;
	}

	// State 3 — Ollama up with models: default first (labelled), the rest alphabetical.
	const orderedModels = orderModels(installedModels);
	for (const modelName of orderedModels) {
		const label = modelName === DEFAULT_MODEL ? `${modelName} (default)` : modelName;
		modelSelect.appendChild(new Option(label, modelName));
	}
	modelSelect.disabled = false;
	setDownloadEnabled(true);

	const savedIsInstalled = savedModel !== '' && installedModels.includes(savedModel);
	modelSelect.value = savedIsInstalled
		? savedModel
		: installedModels.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : orderedModels[0];
}

configButton.addEventListener('click', () => {
	const panelIsNowOpen = configPanel.classList.toggle('open');
	if (panelIsNowOpen) void loadConfigIntoPanel();
});

// Re-check Ollama and rebuild the picker, keeping the current pick selected if it's still installed. Always
// available — it's how the user re-detects models after starting Ollama or downloading one.
refreshModelsButton.addEventListener('click', () => void refreshModelPicker(modelSelect.value || savedOllamaModel));

browseModelsLink.addEventListener('click', (event) => {
	event.preventDefault();
	launcher.openModelLibrary();
});

// Download a model into Ollama; progress streams to the log pane. On success, select it in the dropdown.
pullModelButton.addEventListener('click', async () => {
	const modelName = pullModelInput.value.trim();
	if (!modelName) return;
	pullModelButton.disabled = true;
	pullModelButton.textContent = 'Downloading…';
	const result = await launcher.pullModel(modelName);
	pullModelButton.disabled = false;
	if (result.ok) {
		pullModelInput.value = '';
		await refreshModelPicker(modelName);   // now installed (or already was) → select it
	}
	// Confirm right on the button, since the user clicked here — "already installed" vs a fresh download.
	pullModelButton.textContent = result.alreadyInstalled ? 'Already installed' : 'Download';
	if (result.alreadyInstalled) window.setTimeout(() => { pullModelButton.textContent = 'Download'; }, 2500);
});

saveConfigButton.addEventListener('click', async () => {
	const config = {} as ControlPanelConfig;
	for (const configField of configFields) config[configField] = configInputs[configField].value.trim();
	// When the picker is disabled (Ollama down, or nothing installed) there's no real selection to save —
	// keep the previously saved model rather than overwriting it with an empty value.
	config.ollamaModel = modelSelect.disabled ? savedOllamaModel : modelSelect.value;
	if (!config.port) config.port = DEFAULT_PORT;   // an empty PORT= line would break the server
	await launcher.saveConfig(config);
	configPanel.classList.remove('open');
});
