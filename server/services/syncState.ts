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
