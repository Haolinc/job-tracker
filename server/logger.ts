import fs from 'fs';
import path from 'path';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface LoggerOptions {
	/** Absolute path to the log file. Defaults to sync.log next to this module. */
	filePath?: string;
	/** true = append to existing file (default); false = overwrite on each start. */
	append?: boolean;
}

// ── Internal state ─────────────────────────────────────────────────────────────

// Capture originals at module load — before anyone patches them.
const _origLog   = console.log.bind(console);
const _origError = console.error.bind(console);

let stream:  fs.WriteStream | null = null;
let active = false;

// ── Helpers ────────────────────────────────────────────────────────────────────

const formatArg = (a: unknown): string =>
	typeof a === 'object' && a !== null ? JSON.stringify(a, null, 2) : String(a);

function writeLine(...args: unknown[]): void {
	stream?.write(args.map(formatArg).join(' ') + '\n');
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Turn file logging ON.
 *
 * Patches console.log and console.error so every call is teed to a file.
 * Idempotent — calling enable() twice has no extra effect.
 *
 * Controlled automatically by the LOG_TO_FILE env var:
 *   LOG_TO_FILE=true   → enable on server start
 *   LOG_TO_FILE=false  → skip (useful to silence logging in tests)
 *   (unset)            → defaults to enabled
 *
 * @example Turn on explicitly in a debug script
 *   enable({ append: false }); // fresh file each run
 *
 * @example Turn on from server entry point
 *   enable(); // reads LOG_TO_FILE from env, appends by default
 */
export function enable(options: LoggerOptions = {}): void {
	if (active) return;

	const filePath = options.filePath ?? path.join(__dirname, 'sync.log');
	const flags    = options.append === false ? 'w' : 'a';

	stream = fs.createWriteStream(filePath, { flags });
	stream.write(`\n--- Logging enabled ${new Date().toISOString()} ---\n`);

	console.log   = (...args: unknown[]) => { _origLog(...args);   writeLine(...args); };
	console.error = (...args: unknown[]) => { _origError(...args); writeLine('[ERROR]', ...args); };

	active = true;
}

/**
 * Turn file logging OFF.
 *
 * Restores the original console methods and closes the file stream.
 * Returns a Promise that resolves once the stream is fully flushed.
 *
 * @example Disable after a debug script finishes
 *   await disable();
 */
export function disable(): Promise<void> {
	if (!active) return Promise.resolve();

	console.log   = _origLog;
	console.error = _origError;
	active = false;

	return new Promise(resolve => {
		if (!stream) { resolve(); return; }
		const s = stream;
		stream = null;
		s.end(resolve);
	});
}

/** Whether file logging is currently active. */
export const isEnabled = (): boolean => active;

/**
 * Write a visible separator directly to the log (does not print to terminal).
 * Useful in debug scripts to mark phases without polluting stdout.
 *
 * @example
 *   mark('fetchJobEmails start');
 *   const emails = await fetchJobEmails(tokens);
 *   mark('fetchJobEmails done');
 */
export function mark(label: string): void {
	writeLine(`\n=== ${label} — ${new Date().toISOString()} ===`);
}
