// The launcher's output channels — callers declare intent, consumers never filter:
//   createLog()     → launcher stdout + the control panel's log console
//   logToTerminal() → launcher stdout only, for outcomes the panel already renders on its own live line
//                     (a model download's success/failure/cancel), which would otherwise print twice.

import type { BrowserWindow } from 'electron';

export type LogFn = (source: string, chunk: string) => void;

// Vite/tsx colorize their output; the log pane renders plain text, so drop the ANSI escape codes.
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '');

const taggedLines = (source: string, chunk: string): string[] =>
	stripAnsi(chunk).split(/\r?\n/).filter((line) => line.trim()).map((line) => `[${source}] ${line}`);

/**
 * Build the log function. It reads the target window lazily (via `getWindow`) so it keeps working across
 * window open/close without holding a stale reference — before any window exists, lines still reach stdout.
 */
export function createLog(getWindow: () => BrowserWindow | null): LogFn {
	return (source, chunk) => {
		for (const taggedLine of taggedLines(source, chunk)) {
			console.log(taggedLine);
			getWindow()?.webContents.send('launcher:log', taggedLine);
		}
	};
}

/** Keep the terminal's record of an event without echoing it into the panel that already shows it. */
export function logToTerminal(source: string, chunk: string): void {
	for (const taggedLine of taggedLines(source, chunk)) console.log(taggedLine);
}
