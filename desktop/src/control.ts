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
}

interface ControlPanelBridge {
	startServer(): void;
	stopServer(): void;
	openApp(): void;
	getConfig(): Promise<ControlPanelConfig>;
	saveConfig(config: ControlPanelConfig): Promise<void>;
	onLog(handler: (line: string) => void): void;
	onStatus(handler: (status: ControlPanelStatus) => void): void;
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

// Record<…> makes the compiler verify an input exists for EVERY config field — and the derived list
// below keeps load and save in lockstep with the interface.
const configInputs: Record<keyof ControlPanelConfig, HTMLInputElement> = {
	googleClientId: document.getElementById('google-client-id') as HTMLInputElement,
	googleClientSecret: document.getElementById('google-client-secret') as HTMLInputElement,
	googleRedirectUri: document.getElementById('google-redirect-uri') as HTMLInputElement,
	sessionSecret: document.getElementById('session-secret') as HTMLInputElement,
	port: document.getElementById('server-port') as HTMLInputElement,
};
const configFields = Object.keys(configInputs) as (keyof ControlPanelConfig)[];

const MAX_LOG_LINES = 2000;
// Duplicates config.ts DEFAULT_PORT by necessity — see the no-import note above.
const DEFAULT_PORT = '3001';

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
}

configButton.addEventListener('click', () => {
	const panelIsNowOpen = configPanel.classList.toggle('open');
	if (panelIsNowOpen) void loadConfigIntoPanel();
});

saveConfigButton.addEventListener('click', async () => {
	const config = {} as ControlPanelConfig;
	for (const configField of configFields) config[configField] = configInputs[configField].value.trim();
	if (!config.port) config.port = DEFAULT_PORT;   // an empty PORT= line would break the server
	await launcher.saveConfig(config);
	configPanel.classList.remove('open');
});
