import { useState, useCallback } from 'react';
import { getAuthStatus, disconnectGmail, syncGmail, getSyncHistory } from '../api';
import type { SyncResult, SyncRecord } from '../types';

export function useGmailSync() {
	const [connected, setConnected] = useState(false);
	const [syncing, setSyncing] = useState(false);
	const [lastResult, setLastResult] = useState<SyncResult | null>(null);
	const [history, setHistory] = useState<SyncRecord[]>([]);
	const [error, setError] = useState<string | null>(null);

	const checkStatus = useCallback(async () => {
		try {
			const { connected: c } = await getAuthStatus();
			setConnected(c);
		} catch { /* silently ignore */ }
	}, []);

	const disconnect = useCallback(async () => {
		await disconnectGmail();
		setConnected(false);
	}, []);

	const sync = useCallback(async (): Promise<SyncResult> => {
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
	}, []);

	const fetchHistory = useCallback(async () => {
		const data = await getSyncHistory();
		setHistory(data);
	}, []);

	return { connected, syncing, lastResult, history, error, checkStatus, disconnect, sync, fetchHistory };
}
