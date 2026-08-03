import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// enable() patches the console and is idempotent, so it can only be configured once per module instance —
// each case therefore loads a FRESH logger into a throwaway directory and asserts against what actually
// landed on disk, not against a mock.

let logsDirectory: string;
// Captured before any test patches them, so a fresh module never captures an already-patched console as its
// "original" and starts nesting the tee.
const unpatchedConsole = { log: console.log, warn: console.warn, error: console.error };

beforeEach(() => {
	logsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'));
	vi.resetModules();
});

afterEach(() => {
	Object.assign(console, unpatchedConsole);
	fs.rmSync(logsDirectory, { recursive: true, force: true });
});

async function loadLogger(debugLogging: boolean) {
	const logger = await import('./logger');
	logger.setDebugLogging(debugLogging);
	logger.enable({ directory: logsDirectory });
	return logger;
}

const readLogFile = (prefix: string): string => {
	const name = fs.readdirSync(logsDirectory).find(entry => entry.startsWith(prefix));
	return name ? fs.readFileSync(path.join(logsDirectory, name), 'utf8') : '';
};

/**
 * The day's log file, polled until `expected` shows up — fs.WriteStream buffers, so reading straight after a
 * write races the flush. Writes land in order, so once a later line is present an earlier one either arrived
 * or was never written, which is what the suppression assertions rely on.
 */
async function logFileOnceItContains(prefix: string, expected: string): Promise<string> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const contents = readLogFile(prefix);
		if (contents.includes(expected)) return contents;
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	throw new Error(`"${expected}" never reached the ${prefix} log`);
}

describe('debug mode off', () => {
	it('should keep per-email trace out of the file but still record milestones', async () => {
		const logger = await loadLogger(false);

		logger.debug('[sync] body subject="Your application to Acme" cleaned="…"');
		logger.info('[sync] completed: 511 added, 204 updated, 55 skipped');

		// The milestone was written AFTER the trace, so its arrival proves the trace was dropped, not pending.
		const contents = await logFileOnceItContains('debug-', '[sync] completed');
		expect(contents).not.toContain('[sync] body');
	});

	it('should record warnings and errors in the error log alone', async () => {
		const logger = await loadLogger(false);

		console.warn('[sync] 2 message(s) could not be fetched');
		console.error('Sync error:', 'Ollama is not running');
		logger.info('[sync] duration: 6m 24s');

		const errorContents = await logFileOnceItContains('error-', 'Sync error');
		expect(errorContents).toContain('[WARN] [sync] 2 message(s) could not be fetched');
		expect(errorContents).toContain('[ERROR] Sync error: Ollama is not running');
		// The milestone was written last, so its arrival proves the debug log is genuinely free of both —
		// they were never mirrored, rather than still sitting in the stream's buffer.
		const debugContents = await logFileOnceItContains('debug-', '[sync] duration');
		expect(debugContents).not.toContain('[WARN]');
		expect(debugContents).not.toContain('[ERROR]');
	});
});

describe('debug mode on', () => {
	it('should record the per-email trace alongside the milestones', async () => {
		const logger = await loadLogger(true);

		logger.debug('[sync] body subject="Your application to Acme" cleaned="…"');
		logger.info('[sync] completed: 511 added, 204 updated, 55 skipped');

		const contents = await logFileOnceItContains('debug-', '[sync] completed');
		expect(contents).toContain('[sync] body subject="Your application to Acme"');
	});

	it('should keep warnings and errors in the error log here too', async () => {
		const logger = await loadLogger(true);

		console.error('Sync error:', 'Ollama is not running');
		logger.info('[sync] duration: 6m 24s');

		// Debug mode gates debug() and nothing else, so the error file reads identically in both modes.
		expect(await logFileOnceItContains('error-', 'Sync error')).toContain('[ERROR] Sync error: Ollama is not running');
		expect(await logFileOnceItContains('debug-', '[sync] duration')).not.toContain('[ERROR]');
	});
});
