import { useState, useCallback } from 'react';
import { getAuthStatus, disconnectGmail, syncGmail } from '../api';
import type { SyncResult, SyncProgress } from '../types';

export function useGmailSync() {
	const [connected, setConnected] = useState(false);
	const [syncing, setSyncing] = useState(false);
	const [progress, setProgress] = useState<SyncProgress | null>(null);
	const [lastResult, setLastResult] = useState<SyncResult | null>(null);
	const [error, setError] = useState<string | null>(null);

	// useCallback required — used in a useEffect dep array in App.tsx
	const checkStatus = useCallback(async () => {
		try {
			const { connected: connectedNow } = await getAuthStatus();
			setConnected(connectedNow);
		} catch { /* silently ignore */ }
	}, []);

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
			throw caughtError;
		} finally {
			setSyncing(false);
			setProgress(null);
		}
	}, []);

	return { connected, syncing, progress, lastResult, error, checkStatus, disconnect, sync };
}
