// Output channels — callers declare intent, consumers never filter:
//   debug()               → debug log only (per-email trace detail)
//   guiLine()             → stdout only (machine lines for the desktop launcher)
//   console.log           → terminal + debug log (sparse one-time info)
//   console.error / .warn → terminal + debug log + error log
//
// One file pair per LOCAL date under logs/: debug-YYYY-MM-DD.log holds the full record, error-YYYY-MM-DD.log
// only warnings/errors (created lazily — a clean day leaves no error file). Streams rotate on date change,
// since the server can run for days under the launcher.

import fs from 'fs';
import path from 'path';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface LoggerOptions {
	/** Absolute path of the folder the dated log files go in. Defaults to logs/ next to this module. */
	directory?: string;
}

// ── Internal state ─────────────────────────────────────────────────────────────

// Capture originals at module load — before anyone patches them.
const _origLog   = console.log.bind(console);
const _origError = console.error.bind(console);
const _origWarn  = console.warn.bind(console);

let logsDirectory: string | null = null;
/** The local date the open streams were created for — a mismatch on write triggers rotation. */
let openStreamsDate: string | null = null;
let debugStream: fs.WriteStream | null = null;
/** Opened lazily on the first warning/error of the day, so clean days leave no error file. */
let errorStream: fs.WriteStream | null = null;
let active = false;

// ── Helpers ────────────────────────────────────────────────────────────────────

const formatArg = (a: unknown): string =>
	typeof a === 'object' && a !== null ? JSON.stringify(a, null, 2) : String(a);

/** Today as YYYY-MM-DD in LOCAL time — log days should match the user's calendar, not UTC's. */
function localDateStamp(): string {
	const now = new Date();
	const month = String(now.getMonth() + 1).padStart(2, '0');
	const day   = String(now.getDate()).padStart(2, '0');
	return `${now.getFullYear()}-${month}-${day}`;
}

function closeStreams(): void {
	debugStream?.end();
	errorStream?.end();
	debugStream = null;
	errorStream = null;
}

/** Close both streams when the date has changed, so the next write reopens them under the new day's files. */
function rotateOnDateChange(): void {
	const today = localDateStamp();
	if (today === openStreamsDate) return;
	closeStreams();
	openStreamsDate = today;
}

function currentDebugStream(): fs.WriteStream | null {
	if (!logsDirectory) return null;
	rotateOnDateChange();
	if (!debugStream) {
		debugStream = fs.createWriteStream(path.join(logsDirectory, `debug-${openStreamsDate}.log`), { flags: 'a' });
		debugStream.write(`\n--- Logging enabled ${new Date().toISOString()} ---\n`);
	}
	return debugStream;
}

function currentErrorStream(): fs.WriteStream | null {
	if (!logsDirectory) return null;
	rotateOnDateChange();
	if (!errorStream) {
		errorStream = fs.createWriteStream(path.join(logsDirectory, `error-${openStreamsDate}.log`), { flags: 'a' });
	}
	return errorStream;
}

function writeDebugLine(...args: unknown[]): void {
	currentDebugStream()?.write(args.map(formatArg).join(' ') + '\n');
}

/** Warnings/errors go to BOTH files: the error log for a quick scan, the debug log for full context. */
function writeErrorLine(severityTag: string, ...args: unknown[]): void {
	const line = [severityTag, ...args.map(formatArg)].join(' ') + '\n';
	currentDebugStream()?.write(line);
	currentErrorStream()?.write(line);
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Turn file logging ON.
 *
 * Patches console.log/warn/error so every call is teed to the day's log files.
 * Idempotent — calling enable() twice has no extra effect.
 *
 * Controlled automatically by the LOG_TO_FILE env var:
 *   LOG_TO_FILE=true   → enable on server start
 *   LOG_TO_FILE=false  → skip (useful to silence logging in tests)
 *   (unset)            → defaults to enabled
 *
 * @example Turn on from server entry point
 *   enable(); // reads LOG_TO_FILE from env, LOG_DIR picks the folder
 */
export function enable(options: LoggerOptions = {}): void {
	if (active) return;

	logsDirectory = options.directory ?? path.join(__dirname, 'logs');
	fs.mkdirSync(logsDirectory, { recursive: true });

	console.log   = (...args: unknown[]) => { _origLog(...args);   writeDebugLine(...args); };
	console.error = (...args: unknown[]) => { _origError(...args); writeErrorLine('[ERROR]', ...args); };
	console.warn  = (...args: unknown[]) => { _origWarn(...args);  writeErrorLine('[WARN]', ...args); };

	active = true;
}

/**
 * Per-email trace detail — debug log only, never the terminal or launcher panel.
 * Falls back to the terminal when file logging is off (LOG_TO_FILE=false), so it isn't lost.
 */
export function debug(...args: unknown[]): void {
	if (active) writeDebugLine(...args);
	else _origLog(...args);
}

/** A machine line for the desktop launcher (e.g. "@sync-progress@ {json}") — stdout only, never the logs. */
export function guiLine(line: string): void {
	process.stdout.write(line + '\n');
}

/**
 * Turn file logging OFF.
 *
 * Restores the original console methods and closes the file streams.
 * Returns a Promise that resolves once both streams are fully flushed.
 *
 * @example Disable after a debug script finishes
 *   await disable();
 */
export function disable(): Promise<void> {
	if (!active) return Promise.resolve();

	console.log   = _origLog;
	console.error = _origError;
	console.warn  = _origWarn;
	active = false;

	const streamsToFlush = [debugStream, errorStream].filter((s): s is fs.WriteStream => s !== null);
	debugStream = null;
	errorStream = null;
	logsDirectory = null;
	openStreamsDate = null;

	return Promise.all(
		streamsToFlush.map(streamToFlush => new Promise<void>(resolve => streamToFlush.end(() => resolve()))),
	).then(() => undefined);
}

/** Whether file logging is currently active. */
export const isEnabled = (): boolean => active;

/**
 * Write a visible separator directly to the debug log (does not print to terminal).
 * Useful in debug scripts to mark phases without polluting stdout.
 *
 * @example
 *   mark('fetchJobEmails start');
 *   const emails = await fetchJobEmails(tokens);
 *   mark('fetchJobEmails done');
 */
export function mark(label: string): void {
	writeDebugLine(`\n=== ${label} — ${new Date().toISOString()} ===`);
}
