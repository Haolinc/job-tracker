import { useState, useCallback, useEffect, useRef } from 'react';
import { getAuthStatus, disconnectGmail, syncGmail, getSyncStatus, cancelGmailSync, type SyncStatus } from '../api';
import type { SyncResult, SyncProgress } from '../types';

// How often a tab that didn't start the sync re-polls the server-side snapshot to follow it to the end.
// The tab that started a sync gets real-time updates from the /sync stream; a reopened tab only has this.
const RESUME_POLL_INTERVAL_MS = 800;

// Shape a raw status event into the SyncProgress the bar renders (a 'warming' event has no counts yet).
function progressFromEvent(event: NonNullable<SyncStatus['event']>): SyncProgress {
	return {
		phase: event.phase,
		processed: event.processed ?? 0,
		total: event.total ?? 0,
		added: event.added ?? 0,
		updated: event.updated ?? 0,
		skipped: event.skipped ?? 0,
	};
}

// `onBackgroundSyncSettled` fires when a sync THIS tab didn't start — one already running when the tab
// loaded — finishes, so the caller can refresh the board. The tab that starts a sync refreshes in its own handler.
export function useGmailSync(onBackgroundSyncSettled?: () => void) {
	const [connected, setConnected] = useState(false);
	const [syncing, setSyncing] = useState(false);
	// True from the moment the user asks to cancel until the sync actually ends — drives the "Cancelling…" label
	// and stops a second cancel click. Reset whenever a sync starts or settles.
	const [cancelling, setCancelling] = useState(false);
	const [progress, setProgress] = useState<SyncProgress | null>(null);
	const [lastResult, setLastResult] = useState<SyncResult | null>(null);
	const [error, setError] = useState<string | null>(null);

	// Always invoke the LATEST callback (App recreates it as filters change) without restarting the poll loop.
	// Refreshed in an effect rather than during render — a render can be discarded, and the only reader is the
	// poll timer's callback, which never runs until after commit.
	const onSettledRef = useRef(onBackgroundSyncSettled);
	useEffect(() => { onSettledRef.current = onBackgroundSyncSettled; }, [onBackgroundSyncSettled]);
	const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const stopPolling = useCallback(() => {
		if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
	}, []);

	// Follow a sync that's already running on the server (this tab didn't start it, so it has no stream) by
	// polling the snapshot until it finishes, then settle the result/error and let the caller refresh the board.
	const followServerSync = useCallback(() => {
		if (pollTimerRef.current) return;   // already following
		pollTimerRef.current = setInterval(async () => {
			let status: SyncStatus;
			try { status = await getSyncStatus(); } catch { return; }   // momentary blip — the next tick retries
			if (status.running) {
				if (status.event) setProgress(progressFromEvent(status.event));   // still going — reflect live progress
				return;
			}
			stopPolling();   // finished (perhaps while this tab was away) — settle and stop polling
			setSyncing(false);
			setCancelling(false);
			setProgress(null);
			const event = status.event;
			if (event?.phase === 'error') {
				setError(event.error ?? 'Sync failed');
			} else if (event?.phase === 'done' || event?.phase === 'cancelled') {
				setLastResult({
					added: event.added ?? 0,
					updated: event.updated ?? 0,
					skipped: event.skipped ?? 0,
					failed: event.failed ?? 0,
					durationMs: event.durationMs ?? 0,
					cancelled: event.phase === 'cancelled',
				});
			}
			onSettledRef.current?.();
		}, RESUME_POLL_INTERVAL_MS);
	}, [stopPolling]);

	// The single startup check (App runs it on mount): learn whether Gmail is connected AND whether a sync is
	// already in flight. If one is, this tab opened mid-sync — show its progress and follow it to completion
	// rather than offering a fresh "Sync" the user would only collide with (the button disables while syncing).
	const checkStatus = useCallback(async () => {
		try {
			const [{ connected: connectedNow }, syncStatus] = await Promise.all([getAuthStatus(), getSyncStatus()]);
			setConnected(connectedNow);
			if (syncStatus.running) {
				setSyncing(true);
				setError(null);
				if (syncStatus.event) setProgress(progressFromEvent(syncStatus.event));
				followServerSync();
			}
		} catch { /* silently ignore — the UI just shows disconnected */ }
	}, [followServerSync]);

	useEffect(() => stopPolling, [stopPolling]);   // stop polling when the app unmounts

	const disconnect = useCallback(async () => {
		try {
			await disconnectGmail();
			setConnected(false);
			setLastResult(null);
			setError(null);
		} catch (caughtError) {
			// Surface the server's reason when it gives one — e.g. the 409 for "a sync is in progress".
			const serverReason = (caughtError as { response?: { data?: { error?: string } } })?.response?.data?.error;
			setError(serverReason ?? 'Failed to disconnect');
		}
	}, []);

	const sync = useCallback(async (days?: number): Promise<SyncResult> => {
		setSyncing(true);
		setCancelling(false);
		setError(null);
		setProgress(null);
		try {
			const result = await syncGmail(days, setProgress);
			setLastResult(result);
			return result;
		} catch (caughtError) {
			const errorMessage = (caughtError as { response?: { data?: { error?: string } } })
				?.response?.data?.error ?? (caughtError instanceof Error ? caughtError.message : 'Sync failed');
			setError(errorMessage);
			// The server drops the Gmail tokens when Google rejects them, so re-read the connection state
			// rather than trust a stale flag — otherwise the UI keeps offering a Sync that can only fail
			// again. Unconditional: it also catches any other cause of a dropped session.
			void checkStatus();
			throw caughtError;
		} finally {
			setSyncing(false);
			setCancelling(false);
			setProgress(null);
		}
	}, [checkStatus]);

	// Ask the server to stop the running sync. The sync ends cooperatively a moment later — the stream (this
	// tab) or the poll (a reopened tab) delivers the 'cancelled' result, which flips syncing off. A failure
	// here (e.g. the sync just finished on its own) is ignored: that same terminal event still settles the UI.
	const cancel = useCallback(async () => {
		setCancelling(true);
		try { await cancelGmailSync(); } catch { /* already ending — the terminal event settles it */ }
	}, []);

	return { connected, syncing, cancelling, progress, lastResult, error, checkStatus, disconnect, sync, cancel };
}
