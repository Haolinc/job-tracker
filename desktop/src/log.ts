// The launcher's log tee: every line goes to the launcher's own stdout AND to the control panel's console.

import type { BrowserWindow } from 'electron';

export type LogFn = (source: string, chunk: string) => void;

// Vite/tsx colorize their output; the log pane renders plain text, so drop the ANSI escape codes.
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '');

/**
 * Build the log function. It reads the target window lazily (via `getWindow`) so it keeps working across
 * window open/close without holding a stale reference — before any window exists, lines still reach stdout.
 */
export function createLog(getWindow: () => BrowserWindow | null): LogFn {
	return (source, chunk) => {
		for (const line of stripAnsi(chunk).split(/\r?\n/)) {
			if (!line.trim()) continue;
			const taggedLine = `[${source}] ${line}`;
			console.log(taggedLine);
			getWindow()?.webContents.send('launcher:log', taggedLine);
		}
	};
}
