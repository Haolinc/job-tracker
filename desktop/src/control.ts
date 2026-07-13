// Control-panel renderer: pure display. Receives log lines and status pushes from the main process via
// the preload bridge (window.launcher) and renders them; buttons send commands back, and the config panel
// reads/writes server/.env through the bridge. No import/export on purpose — this compiles to a plain
// classic script that control.html loads directly.

// The bridge and the message shapes it carries (LauncherBridge, LauncherStatus, LauncherConfig,
// PullProgress, SyncProgressEvent) are ambient globals declared in launcher-globals.d.ts, shared with the
// main-process modules — one definition each, so the compiler catches any drift. A classic script can't
// import, and this file stays import-free on purpose so it compiles to a plain classic script.
declare const launcher: LauncherBridge;   // exposed by preload.ts via contextBridge

const logConsole = document.getElementById('log-console') as HTMLDivElement;
const serverDot = document.getElementById('server-dot') as HTMLSpanElement;
const ollamaDot = document.getElementById('ollama-dot') as HTMLSpanElement;
const modelDot = document.getElementById('model-dot') as HTMLSpanElement;
const modelLabel = document.getElementById('active-model-label') as HTMLSpanElement;
const startButton = document.getElementById('start-button') as HTMLButtonElement;
const stopButton = document.getElementById('stop-button') as HTMLButtonElement;
const openAppButton = document.getElementById('open-app-button') as HTMLButtonElement;
const openLogsButton = document.getElementById('open-logs-button') as HTMLButtonElement;
const configButton = document.getElementById('config-button') as HTMLButtonElement;
const configPanel = document.getElementById('config-panel') as HTMLElement;
const saveConfigButton = document.getElementById('save-config-button') as HTMLButtonElement;

// Every config field is a plain text input EXCEPT the model, which is a dropdown of installed models.
type TextConfigField = Exclude<keyof LauncherConfig, 'ollamaModel'>;

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
const removeModelButton = document.getElementById('remove-model-button') as HTMLButtonElement;
const cancelDownloadButton = document.getElementById('cancel-download-button') as HTMLButtonElement;
const incompleteDownloads = document.getElementById('incomplete-downloads') as HTMLElement;
const incompleteList = document.getElementById('incomplete-list') as HTMLUListElement;
const reclaimIncompleteButton = document.getElementById('reclaim-incomplete-button') as HTMLButtonElement;

const MAX_LOG_LINES = 2000;
// Duplicates config.ts DEFAULT_PORT by necessity — see the no-import note above.
const DEFAULT_PORT = '3001';
// The recommended default model — floated to the top of the picker and pre-selected on a fresh start.
// Mirrors main.ts DEFAULT_MODEL (the no-import boundary again).
const DEFAULT_MODEL = 'qwen2.5:7b';
// The progress stream labels the one-time Ollama runtime download with this modelName (see ollamaService.ts);
// model pulls carry the real model name. Used to tell them apart — only model pulls are cancellable.
const OLLAMA_DOWNLOAD_LABEL = 'Ollama';

// The model saved in .env, remembered so that saving while the picker is disabled (Ollama down, or no models
// installed) preserves the user's choice instead of overwriting it with an empty selection.
let savedOllamaModel = '';

// Whether Ollama is reachable enough to pull into (set by refreshModelPicker) and whether a download is
// currently running (driven by the progress stream). The download field reflects BOTH — no second pull while
// one is already in flight.
let ollamaReachableForPull = false;
let downloadInProgress = false;
// Whether the selected model is an installed one that can be removed, and whether the active download is a
// model pull we can cancel (the Ollama runtime download itself is not cancellable from here).
let hasInstalledSelection = false;
let activeDownloadIsCancellable = false;

// ── Log console ─────────────────────────────────────────────────────────────

// Log lines the pane paints red. The lookbehind spares counts — "3 failed (will retry)" reports a tally,
// not a failure — while "Sync failed: …" still matches.
const ERROR_LINE_PATTERN = /(?<!\d\s)\b(error|exception|failed|failure)/i;

launcher.onLog((line) => {
	// Only autoscroll when the user is already reading the tail — don't yank them back down mid-scroll.
	const pinnedToBottom = logConsole.scrollTop + logConsole.clientHeight >= logConsole.scrollHeight - 8;

	const logLine = document.createElement('div');
	logLine.className = 'log-line';
	if (ERROR_LINE_PATTERN.test(line)) logLine.classList.add('error-line');
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

/** How a live line reads at a glance: running, finished, stopped early, or broken. */
type LineTone = 'progress' | 'success' | 'warning' | 'error';
const TONE_CLASS: Record<LineTone, string> = {
	progress: 'progress-line',
	success: 'success-line',
	warning: 'warning-line',
	error: 'error-line',
};

/**
 * A log-console line that rewrites itself IN PLACE — the shared mechanic behind every live status line
 * (model downloads, sync progress). Returns an updater: call it with the new text each tick; pass
 * `finalize: true` with the last text so it stays put and the next update starts a fresh line. Each call
 * makes an independent line, so different streams (a download, a sync) never overwrite each other.
 */
function createLiveLine(logContainer: HTMLDivElement): (text: string, options?: { finalize?: boolean; tone?: LineTone }) => void {
	// Held across updates so the same line is rewritten; null between streams so the next one starts fresh.
	let liveLineElement: HTMLDivElement | null = null;
	return (text, options = {}) => {
		const pinnedToBottom = logContainer.scrollTop + logContainer.clientHeight >= logContainer.scrollHeight - 8;

		// Reuse the line unless the log-line cap trimmed it away; then start a fresh one.
		if (!liveLineElement || !liveLineElement.isConnected) {
			liveLineElement = document.createElement('div');
			logContainer.appendChild(liveLineElement);
		}

		liveLineElement.textContent = text;
		// Set every update, not just on create: a line recolors as its stream ends.
		liveLineElement.className = `log-line ${TONE_CLASS[options.tone ?? 'progress']}`;
		if (options.finalize) liveLineElement = null;

		if (pinnedToBottom) logContainer.scrollTop = logContainer.scrollHeight;
	};
}

const renderDownloadLine = createLiveLine(logConsole);
function renderPullProgress(progress: PullProgress): void {
	if (progress.done) {
		if (progress.status === 'cancelled') {
			renderDownloadLine(`⊘ ${progress.modelName} — cancelled`, { finalize: true, tone: 'warning' });
		} else if (progress.status.startsWith('error')) {
			renderDownloadLine(`✗ ${progress.modelName} — ${progress.status}`, { finalize: true, tone: 'error' });
		} else {
			renderDownloadLine(`✓ ${progress.modelName} downloaded`, { finalize: true, tone: 'success' });
		}
	} else if (progress.total > 0) {
		const percent = Math.min(100, Math.floor((progress.completed / progress.total) * 100));
		renderDownloadLine(`⬇ ${progress.modelName}  ${formatBytes(progress.completed)} / ${formatBytes(progress.total)}  (${percent}%)`);
	} else {
		renderDownloadLine(`⬇ ${progress.modelName}  ${progress.status || 'preparing'}…`);
	}
}

launcher.onPullProgress((progress) => {
	downloadInProgress = !progress.done;
	activeDownloadIsCancellable = !progress.done && progress.modelName !== OLLAMA_DOWNLOAD_LABEL;
	syncDownloadControls();
	renderPullProgress(progress);
});

// ── Sync progress ────────────────────────────────────────────────────────────

/** A millisecond duration as compact h/m/s ("5m 41s", "1h 2m", "8s"). Zero-value units are dropped. */
// Exact copy of formatDuration in server/utils.ts and client/src/utils/formatDuration.ts — the no-import
// boundary again. Keep all copies identical.
function formatDuration(ms: number): string {
	const total = Math.round(ms / 1000);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const parts: string[] = [];
	if (h) parts.push(`${h}h`);
	if (m) parts.push(`${m}m`);
	if (s || !parts.length) parts.push(`${s}s`);
	return parts.join(' ');
}

// The sync's story in the log pane, without the per-email flood: "found N" stays as its own line, one live
// line tracks processed/added/updated counts in place, and it finalizes to a ✓ summary (or ✗ on error).
const renderSyncLine = createLiveLine(logConsole);
// A sync only reports 'done'/'error' when it runs to completion. If the server dies first, no closing event
// ever arrives — so track the sync ourselves and close the line out when the server goes away.
let syncInProgress = false;
function renderSyncProgress(event: SyncProgressEvent): void {
	syncInProgress = event.phase !== 'done' && event.phase !== 'error';
	const countsText = `${event.added ?? 0} added, ${event.updated ?? 0} updated, ${event.skipped ?? 0} skipped`;
	if (event.phase === 'start') {
		const totalEmails = event.total ?? 0;
		const scanWindowText = event.days ? `scanning the last ${event.days} days — ` : '';
		renderSyncLine(`⟳ Sync started: ${scanWindowText}found ${totalEmails} new email${totalEmails === 1 ? '' : 's'} (${event.skipped ?? 0} already synced)`, { finalize: true });
	} else if (event.phase === 'warming') {
		renderSyncLine('⟳ Sync: preparing the model…');
	} else if (event.phase === 'progress') {
		renderSyncLine(`⟳ Sync: processed ${event.processed ?? 0}/${event.total ?? 0} emails · ${countsText}`);
	} else if (event.phase === 'done') {
		const failedNote = event.failed ? `, ${event.failed} failed (will retry)` : '';
		const durationText = event.durationMs ? ` — ${formatDuration(event.durationMs)}` : '';
		renderSyncLine(`✓ Sync finished: ${countsText}${failedNote}${durationText}`, { finalize: true, tone: 'success' });
	} else if (event.phase === 'error') {
		renderSyncLine(`✗ Sync failed: ${event.error ?? 'unknown error'}`, { finalize: true, tone: 'error' });
	}
}
launcher.onSyncProgress(renderSyncProgress);

/** Replace the stalled progress line, which would otherwise sit at its last count as if still working. */
function markSyncInterrupted(): void {
	syncInProgress = false;
	renderSyncLine('⊘ Sync interrupted: the server stopped before it finished — results may not have been saved', { finalize: true, tone: 'warning' });
}

// ── Status dots & buttons ───────────────────────────────────────────────────

launcher.onStatus((status) => {
	serverDot.classList.toggle('up', status.serverUp);
	ollamaDot.classList.toggle('up', status.ollamaUp);
	renderModelStatus(status);
	startButton.disabled = status.serverRunning || status.serverStarting;
	stopButton.disabled = !status.serverRunning;
	openAppButton.disabled = !status.serverUp;
	if (syncInProgress && !status.serverRunning) markSyncInterrupted();
});

/** Header model indicator: green when the configured model is installed, amber when it's unset or missing
 *  (classification would fail), neutral while Ollama is unreachable (we can't tell). */
function renderModelStatus(status: LauncherStatus): void {
	modelDot.classList.remove('up', 'warn');
	if (!status.ollamaUp) {
		modelLabel.textContent = 'Model';
		modelLabel.title = 'Ollama is not running — model status unknown.';
	} else if (status.activeModel && status.activeModelInstalled) {
		modelDot.classList.add('up');
		modelLabel.textContent = status.activeModel;
		modelLabel.title = `Classifying with ${status.activeModel}.`;
	} else if (status.activeModel) {
		modelDot.classList.add('warn');
		modelLabel.textContent = `${status.activeModel} (missing)`;
		modelLabel.title = `The configured model "${status.activeModel}" isn't installed — download it or pick another in Config.`;
	} else {
		modelDot.classList.add('warn');
		modelLabel.textContent = 'No model';
		modelLabel.title = 'No classification model is configured — download one in Config.';
	}
}

startButton.addEventListener('click', () => launcher.startServer());
stopButton.addEventListener('click', () => launcher.stopServer());
openAppButton.addEventListener('click', () => launcher.openApp());
openLogsButton.addEventListener('click', () => launcher.openLogsFolder());

// ── Config panel ────────────────────────────────────────────────────────────

async function loadConfigIntoPanel(): Promise<void> {
	const config = await launcher.getConfig();
	for (const configField of configFields) configInputs[configField].value = config[configField];
	savedOllamaModel = config.ollamaModel;
	await refreshModelPicker(savedOllamaModel);
	await refreshIncompleteDownloads();
}

/** The recommended default first (when installed), then every other model alphabetically. */
function orderModels(models: string[]): string[] {
	const others = models.filter((name) => name !== DEFAULT_MODEL).sort((first, second) => first.localeCompare(second));
	return models.includes(DEFAULT_MODEL) ? [DEFAULT_MODEL, ...others] : others;
}

/**
 * Reflect the download service on the field: usable only when Ollama can be pulled into AND nothing is already
 * downloading. The button reads "Downloading…" while a pull runs, so re-opening Config mid-download can't present
 * an enabled button to click again.
 */
function syncDownloadControls(): void {
	const canDownload = ollamaReachableForPull && !downloadInProgress;
	pullModelInput.disabled = !canDownload;
	pullModelButton.disabled = !canDownload;
	pullModelButton.textContent = downloadInProgress ? 'Downloading…' : 'Download';
	cancelDownloadButton.hidden = !activeDownloadIsCancellable;
	removeModelButton.disabled = !hasInstalledSelection || downloadInProgress;
	reclaimIncompleteButton.disabled = downloadInProgress;
	for (const incompleteButton of incompleteList.querySelectorAll('button')) incompleteButton.disabled = downloadInProgress;
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
		ollamaReachableForPull = false;
		hasInstalledSelection = false;
		syncDownloadControls();
		return;
	}

	// State 2 — Ollama up but no models: nothing to select yet; downloading is the way to get one.
	if (installedModels.length === 0) {
		modelSelect.appendChild(new Option('No models installed — download one below', ''));
		modelSelect.value = '';
		modelSelect.disabled = true;
		ollamaReachableForPull = true;
		hasInstalledSelection = false;
		syncDownloadControls();
		return;
	}

	// State 3 — Ollama up with models: default first (labelled), the rest alphabetical.
	const orderedModels = orderModels(installedModels);
	for (const modelName of orderedModels) {
		const label = modelName === DEFAULT_MODEL ? `${modelName} (default)` : modelName;
		modelSelect.appendChild(new Option(label, modelName));
	}
	modelSelect.disabled = false;
	ollamaReachableForPull = true;
	hasInstalledSelection = true;
	syncDownloadControls();

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

cancelDownloadButton.addEventListener('click', () => launcher.cancelPull());

// Remove the selected installed model (frees disk). A confirm dialog in the main process gates it.
removeModelButton.addEventListener('click', async () => {
	const modelName = modelSelect.value;
	if (!modelName || downloadInProgress) return;
	const result = await launcher.deleteModel(modelName);
	if (result.ok) await refreshModelPicker(savedOllamaModel);
});

// Start (or resume) a model download; progress streams to the live line. Shared by the Download button and
// the Resume buttons in the incomplete-downloads list.
async function startModelDownload(modelName: string): Promise<void> {
	if (downloadInProgress || !modelName) return;
	downloadInProgress = true;
	activeDownloadIsCancellable = true;
	syncDownloadControls();
	const result = await launcher.pullModel(modelName);
	downloadInProgress = false;
	activeDownloadIsCancellable = false;
	if (result.ok) {
		pullModelInput.value = '';
		await refreshModelPicker(modelName);   // now installed (or already was) → select it; also re-syncs controls
	} else {
		syncDownloadControls();
	}
	await refreshIncompleteDownloads();   // a cancel records a partial; a success clears it
	// Confirm right on the button, since the user clicked here — a re-download reports "already installed".
	if (result.alreadyInstalled) {
		pullModelButton.textContent = 'Already installed';
		window.setTimeout(() => { pullModelButton.textContent = 'Download'; }, 2500);
	}
}

pullModelButton.addEventListener('click', () => void startModelDownload(pullModelInput.value.trim()));

/** Show the interrupted-downloads section with per-model Resume buttons, or hide it when there are none. */
async function refreshIncompleteDownloads(): Promise<void> {
	const incompleteModels = await launcher.listIncompleteDownloads();
	incompleteList.replaceChildren();
	incompleteDownloads.hidden = incompleteModels.length === 0;
	for (const modelName of incompleteModels) {
		const listItem = document.createElement('li');
		const nameLabel = document.createElement('span');
		nameLabel.textContent = modelName;
		const resumeButton = document.createElement('button');
		resumeButton.type = 'button';
		resumeButton.className = 'mini';
		resumeButton.textContent = 'Resume';
		resumeButton.addEventListener('click', () => void startModelDownload(modelName));
		listItem.append(nameLabel, resumeButton);
		incompleteList.appendChild(listItem);
	}
	syncDownloadControls();   // apply the current download-in-progress state to the reclaim/resume buttons
}

// Delete all partial download data to reclaim disk (a confirm dialog in the main process gates it).
reclaimIncompleteButton.addEventListener('click', async () => {
	if (downloadInProgress) return;
	await launcher.reclaimIncompleteDownloads();
	await refreshIncompleteDownloads();
});

saveConfigButton.addEventListener('click', async () => {
	const config = {} as LauncherConfig;
	for (const configField of configFields) config[configField] = configInputs[configField].value.trim();
	// When the picker is disabled (Ollama down, or nothing installed) there's no real selection to save —
	// keep the previously saved model rather than overwriting it with an empty value.
	config.ollamaModel = modelSelect.disabled ? savedOllamaModel : modelSelect.value;
	if (!config.port) config.port = DEFAULT_PORT;   // an empty PORT= line would break the server
	await launcher.saveConfig(config);
	configPanel.classList.remove('open');
});
