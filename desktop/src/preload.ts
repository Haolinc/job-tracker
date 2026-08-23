// Preload bridge: the only doorway between the sandboxed control panel and the main process.
// Exposes a typed, minimal API (window.launcher) — commands, config access, and two streams;
// the renderer can never reach Node or Electron internals directly.

import { contextBridge, ipcRenderer } from 'electron';
// LauncherBridge/LauncherConfig/LauncherStatus/PullProgress/SyncProgressEvent are ambient globals
// (launcher-globals.d.ts) — shared with the classic control-panel script, which cannot import.

const launcherBridge: LauncherBridge = {
	startServer: () => ipcRenderer.send('launcher:start'),
	stopServer: () => ipcRenderer.send('launcher:stop'),
	openApp: () => ipcRenderer.send('launcher:open-app'),
	openLogsFolder: () => ipcRenderer.send('launcher:open-logs'),
	getConfig: () => ipcRenderer.invoke('launcher:get-config') as Promise<LauncherConfig>,
	saveConfig: (config: LauncherConfig) => ipcRenderer.invoke('launcher:save-config', config) as Promise<void>,
	listInstalledModels: () => ipcRenderer.invoke('launcher:list-models') as Promise<string[] | null>,
	pullModel: (modelName: string) => ipcRenderer.invoke('launcher:pull-model', modelName) as Promise<{ ok: boolean; error?: string; alreadyInstalled?: boolean; cancelled?: boolean }>,
	cancelPull: () => ipcRenderer.send('launcher:cancel-pull'),
	deleteModel: (modelName: string) => ipcRenderer.invoke('launcher:delete-model', modelName) as Promise<{ ok: boolean; error?: string; cancelled?: boolean }>,
	listIncompleteDownloads: () => ipcRenderer.invoke('launcher:list-incomplete') as Promise<string[]>,
	reclaimIncompleteDownloads: () => ipcRenderer.invoke('launcher:reclaim-incomplete') as Promise<{ freedBytes: number }>,
	openModelLibrary: () => ipcRenderer.send('launcher:browse-models'),
	openSetupGuide: () => ipcRenderer.send('launcher:open-setup-guide'),
	onLog: (handler) => ipcRenderer.on('launcher:log', (_event, line: string) => handler(line)),
	onStatus: (handler) => ipcRenderer.on('launcher:status', (_event, status: LauncherStatus) => handler(status)),
	onPullProgress: (handler) => ipcRenderer.on('launcher:pull-progress', (_event, progress: PullProgress) => handler(progress)),
	onUpdateProgress: (handler) => ipcRenderer.on('launcher:update-progress', (_event, progress: UpdateProgress) => handler(progress)),
	onSyncProgress: (handler) => ipcRenderer.on('launcher:sync-progress', (_event, syncEvent: SyncProgressEvent) => handler(syncEvent)),
};

contextBridge.exposeInMainWorld('launcher', launcherBridge);
