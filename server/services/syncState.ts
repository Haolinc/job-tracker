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
