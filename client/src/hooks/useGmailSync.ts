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
			const { connected: c } = await getAuthStatus();
			setConnected(c);
		} catch { /* silently ignore */ }
	}, []);

	const disconnect = useCallback(async () => {
		try {
			await disconnectGmail();
			setConnected(false);
			setLastResult(null);
			setError(null);
		} catch {
			setError('Failed to disconnect');
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
		} catch (e) {
			const msg = (e as { response?: { data?: { error?: string } }; message?: string })
				?.response?.data?.error ?? (e instanceof Error ? e.message : 'Sync failed');
			setError(msg);
			throw e;
		} finally {
			setSyncing(false);
			setProgress(null);
		}
	}, []);

	return { connected, syncing, progress, lastResult, error, checkStatus, disconnect, sync };
}
