// Output channels — callers declare intent, consumers never filter:
//   debug()               → debug log only, and ONLY in debug mode (per-email trace detail)
//   info()                → debug log only, always (a handful of run milestones)
//   guiLine()             → stdout only (machine lines for the desktop launcher)
//   console.log           → terminal + debug log (sparse one-time info)
//   console.error / .warn → terminal + error log (NEVER the debug log)
//
// debug() is the whole volume: per-email traces are ~99.9% of a sync's log bytes, and three quarters of that
// is raw email text written twice per email. Off (the default) a sync leaves milestones only.
//
// Debug mode gates debug() and nothing else. A warning or error is written in either mode — the one file that
// must never depend on a setting the user forgot to tick is the one recording what went wrong.
//
// One file pair per LOCAL date under logs/: debug-YYYY-MM-DD.log is the run record, error-YYYY-MM-DD.log the
// warnings and errors, each kept to its own file so neither has to be read around the other (created lazily —
// a clean day leaves no error file). Streams rotate on date change, since the server can run for days under
// the launcher.

import fs from 'fs';
import path from 'path';
import { localDateString, localTimestamp } from './utils';

// ── Types ──────────────────────────────────────────────────────────────────────

interface LoggerOptions {
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
/** Debug mode. Off by default so a build that never calls setDebugLogging stays quiet. */
let debugLoggingEnabled = false;

// ── Helpers ────────────────────────────────────────────────────────────────────

const formatArg = (a: unknown): string =>
	typeof a === 'object' && a !== null ? JSON.stringify(a, null, 2) : String(a);

function closeStreams(): void {
	debugStream?.end();
	errorStream?.end();
	debugStream = null;
	errorStream = null;
}

/** Close both streams when the date has changed, so the next write reopens them under the new day's files. */
function rotateOnDateChange(): void {
	const today = localDateString();
	if (today === openStreamsDate) return;
	closeStreams();
	openStreamsDate = today;
}

// Throttle for the deleted-file check below — a busy debug log must not stat the disk on every line.
let lastLogFileCheckMs = 0;
const LOG_FILE_CHECK_INTERVAL_MS = 2000;

/**
 * A WriteStream keeps writing into its open handle even after the file is deleted from disk, so a user who
 * removes debug-YYYY-MM-DD.log mid-run would otherwise never see a new one appear. Periodically confirm the
 * open files still exist and drop any stream whose file is gone, so the next write recreates it. Throttled so
 * high-volume logging doesn't touch the filesystem on every write.
 */
function dropStreamsWhoseFileWasDeleted(): void {
	if (!logsDirectory) return;
	const now = Date.now();
	if (now - lastLogFileCheckMs < LOG_FILE_CHECK_INTERVAL_MS) return;
	lastLogFileCheckMs = now;
	if (debugStream && !fs.existsSync(path.join(logsDirectory, `debug-${openStreamsDate}.log`))) {
		debugStream.end();
		debugStream = null;
	}
	if (errorStream && !fs.existsSync(path.join(logsDirectory, `error-${openStreamsDate}.log`))) {
		errorStream.end();
		errorStream = null;
	}
}

/** Open a dated append stream, recreating the logs folder if it too was deleted and guarding against a
 *  stream error (a deleted-file write can surface as one) taking the server down — drop it so it reopens. */
function openLogStream(filePrefix: string): fs.WriteStream {
	fs.mkdirSync(logsDirectory!, { recursive: true });
	const stream = fs.createWriteStream(path.join(logsDirectory!, `${filePrefix}-${openStreamsDate}.log`), { flags: 'a' });
	stream.on('error', () => {
		if (debugStream === stream) debugStream = null;
		if (errorStream === stream) errorStream = null;
	});
	return stream;
}

function currentDebugStream(): fs.WriteStream | null {
	if (!logsDirectory) return null;
	rotateOnDateChange();
	dropStreamsWhoseFileWasDeleted();
	if (!debugStream) {
		debugStream = openLogStream('debug');
		debugStream.write(`\n--- Logging enabled ${localTimestamp()} ---\n`);
	}
	return debugStream;
}

function currentErrorStream(): fs.WriteStream | null {
	if (!logsDirectory) return null;
	rotateOnDateChange();
	dropStreamsWhoseFileWasDeleted();
	if (!errorStream) {
		errorStream = openLogStream('error');
	}
	return errorStream;
}

function writeDebugLine(...args: unknown[]): void {
	currentDebugStream()?.write(args.map(formatArg).join(' ') + '\n');
}

/** Warnings/errors go to the error log ALONE — never mirrored into the debug log, and never gated by debug
 *  mode, so the record of what broke is one short file that reads the same however the server was configured. */
function writeErrorLine(severityTag: string, ...args: unknown[]): void {
	currentErrorStream()?.write([severityTag, ...args.map(formatArg)].join(' ') + '\n');
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Turn file logging ON: patch console.log/warn/error so every call is teed to the day's log files.
 * Idempotent — a second call has no extra effect. The caller (index.ts) decides whether to call it,
 * from LOG_TO_FILE: 'false' silences file logging (used by tests), anything else enables it.
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
 * Turn debug mode on or off. Separate from enable() because the two are independent questions — WHERE output
 * goes vs HOW MUCH of it there is — and index.ts answers them from different env vars.
 */
export function setDebugLogging(enabled: boolean): void {
	debugLoggingEnabled = enabled;
}

/**
 * Per-email trace detail — debug log only, never the terminal or launcher panel, and only in debug mode.
 * Falls back to the terminal when file logging is off (LOG_TO_FILE=false), so it isn't lost.
 */
export function debug(...args: unknown[]): void {
	if (!debugLoggingEnabled) return;
	if (active) writeDebugLine(...args);
	else _origLog(...args);
}

/**
 * A run milestone — debug log only, in every mode. Reserved for the few lines that answer "did it run, how
 * long did it take, what did it do": the sync's window, its counts, its duration. Never per-email, never
 * email content, so the minimal log stays a handful of lines per sync.
 */
export function info(...args: unknown[]): void {
	if (active) writeDebugLine(...args);
	else _origLog(...args);
}

/** A machine line for the desktop launcher (e.g. "@sync-progress@ {json}") — stdout only, never the logs. */
export function guiLine(line: string): void {
	process.stdout.write(line + '\n');
}
