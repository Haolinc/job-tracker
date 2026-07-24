// Whether a Gmail sync is currently streaming. Lets other routes refuse actions that would break a
// running sync — /auth/disconnect revoking the very tokens the sync is using — and lets /sync itself
// reject a concurrent run (which also keeps this flag a plain boolean: one sync owns it at a time).

let syncRunning = false;

export function isSyncRunning(): boolean {
	return syncRunning;
}

export function setSyncRunning(running: boolean): void {
	syncRunning = running;
}

// The most recent sync progress event (start / warming / progress / done / error), kept so a browser that
// reconnects mid-sync — a tab closed and reopened — can restore its progress bar. The /sync progress stream
// is tied to the single request that started the sync, so a fresh page load has no other way to observe a
// run already in flight; it polls /sync/status, which serves this snapshot. Readers pair it with
// isSyncRunning() to tell a live run from one that already finished. Cleared at the start of each new sync.
let lastSyncEvent: Record<string, unknown> | null = null;

export function getLastSyncEvent(): Record<string, unknown> | null {
	return lastSyncEvent;
}

export function setLastSyncEvent(event: Record<string, unknown> | null): void {
	lastSyncEvent = event;
}

// Set by POST /sync/cancel to ask the running sync to stop at its next safe checkpoint. The sync loop
// checks it between emails and exits cooperatively, keeping every email it already committed (the rest stay
// unsynced and are picked up by the next sync). Cleared at the start AND end of each run so a cancel can
// never leak into the following sync.
let syncCancelRequested = false;

export function isSyncCancelRequested(): boolean {
	return syncCancelRequested;
}

export function requestSyncCancel(): void {
	syncCancelRequested = true;
}

export function clearSyncCancel(): void {
	syncCancelRequested = false;
}

// Whether a CSV import plan is being applied. Sync and import are mutually exclusive: a sync running
// mid-import would read half-applied state, and an import applied mid-sync would invalidate the plan
// the user just confirmed. The import transaction is short, so the window this flag is set is tiny.

let importRunning = false;

export function isImportRunning(): boolean {
	return importRunning;
}

export function setImportRunning(running: boolean): void {
	importRunning = running;
}
