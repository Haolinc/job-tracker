import { useState, useCallback } from 'react';
import { getAuthStatus, disconnectGmail, syncGmail } from '../api';
import type { SyncResult } from '../types';

export function useGmailSync() {
	const [connected, setConnected] = useState(false);
	const [syncing, setSyncing] = useState(false);
	const [lastResult, setLastResult] = useState<SyncResult | null>(null);
	const [error, setError] = useState<string | null>(null);

	// useCallback required — used in a useEffect dep array in App.tsx
	const checkStatus = useCallback(async () => {
		try {
			const { connected: c } = await getAuthStatus();
			setConnected(c);
		} catch { /* silently ignore */ }
	}, []);

	const disconnect = async () => {
		try {
			await disconnectGmail();
			setConnected(false);
		} catch {
			setError('Failed to disconnect');
		}
	};

	const sync = async (): Promise<SyncResult> => {
		setSyncing(true);
		setError(null);
		try {
			const result = await syncGmail();
			setLastResult(result);
			return result;
		} catch (e) {
			const msg = (e as { response?: { data?: { error?: string } }; message?: string })
				?.response?.data?.error ?? (e instanceof Error ? e.message : 'Sync failed');
			setError(msg);
			throw e;
		} finally {
			setSyncing(false);
		}
	};

	return { connected, syncing, lastResult, error, checkStatus, disconnect, sync };
}
