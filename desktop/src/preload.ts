// Preload bridge: the only doorway between the sandboxed control panel and the main process.
// Exposes a typed, minimal API (window.launcher) — commands, config access, and two streams;
// the renderer can never reach Node or Electron internals directly.

import { contextBridge, ipcRenderer } from 'electron';
import type { LauncherBridge, LauncherConfig, LauncherStatus } from './shared';

const launcherBridge: LauncherBridge = {
	startServer: () => ipcRenderer.send('launcher:start'),
	stopServer: () => ipcRenderer.send('launcher:stop'),
	openApp: () => ipcRenderer.send('launcher:open-app'),
	getConfig: () => ipcRenderer.invoke('launcher:get-config') as Promise<LauncherConfig>,
	saveConfig: (config: LauncherConfig) => ipcRenderer.invoke('launcher:save-config', config) as Promise<void>,
	onLog: (handler) => ipcRenderer.on('launcher:log', (_event, line: string) => handler(line)),
	onStatus: (handler) => ipcRenderer.on('launcher:status', (_event, status: LauncherStatus) => handler(status)),
};

contextBridge.exposeInMainWorld('launcher', launcherBridge);
