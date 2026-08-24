import axios from 'axios';
import type { Application, NewApplication, EmailRef, Filters, SyncResult, SyncProgress } from './types';

const api = axios.create({ baseURL: '/api', withCredentials: true });

export const getApplications = (params?: Filters): Promise<Application[]> =>
	api.get('/applications', { params }).then(response => response.data as Application[]);

export const createApplication = (data: NewApplication): Promise<Application> =>
	api.post('/applications', data).then(response => response.data as Application);

export const updateApplication = (id: string, data: Partial<Application>): Promise<Application> =>
	api.patch(`/applications/${id}`, data).then(response => response.data as Application);

export const deleteApplication = (id: string): Promise<void> =>
	api.delete(`/applications/${id}`);

export const resetDatabase = (): Promise<{ applications: number; syncedEmails: number }> =>
	api.delete('/applications/all').then(response => response.data as { applications: number; syncedEmails: number });

// A reconciled CSV import plan (see utils/importCsv buildImportPlan) — applied server-side in one transaction.
export interface ImportApplyPayload {
	creates: { preservedId: string | null; data: NewApplication }[];
	updates: { id: string; changes: Partial<Application>; adoptId: string | null }[];
	strips: { id: string; messageIds: string[] }[];   // email-uniqueness strips off unmatched applications
	deletes: string[];                                // applications merged away (every email moved off them)
	syncEmails: EmailRef[];                           // every email ref in the file → synced-email skip list
}

export interface ImportApplyResult {
	added: number;
	updated: number;
	deleted: number;
	staleSkipped: number;   // plan entries whose target no longer matched the board
	createdIds: string[];
	updatedIds: string[];
}

export const importApplications = (payload: ImportApplyPayload): Promise<ImportApplyResult> =>
	api.post('/applications/import', payload).then(response => response.data as ImportApplyResult);

export interface AuthStatus {
	connected: boolean;
	// The signed-in Gmail address, for the account badge. Optional: null when disconnected, and absent from
	// the response of a server older than the field — the badge just falls back to a generic avatar.
	email?: string | null;
}

export const getAuthStatus = (): Promise<AuthStatus> =>
	api.get('/auth/status').then(response => response.data as AuthStatus);

export const disconnectGmail = (): Promise<{ success: boolean }> =>
	api.post('/auth/disconnect').then(response => response.data as { success: boolean });

// A single snapshot of the server-side sync, polled by a reconnecting tab to restore its progress bar (the
// /sync stream only reaches the tab that started the run). `event` is the latest streamed event of any phase;
// callers pair it with `running` — a false `running` means any event is from a sync that already finished.
export interface SyncStatus {
	running: boolean;
	event: (SyncProgress & { phase?: string; failed?: number; durationMs?: number; error?: string }) | null;
}

export const getSyncStatus = (): Promise<SyncStatus> =>
	api.get('/gmail/sync/status').then(response => response.data as SyncStatus);

// Ask the server to stop the running sync. Resolves once the request is acknowledged; the sync itself ends
// a moment later as a 'cancelled' event on the progress stream / snapshot.
export const cancelGmailSync = (): Promise<{ cancelling: boolean }> =>
	api.post('/gmail/sync/cancel').then(response => response.data as { cancelling: boolean });

// Streams newline-delimited JSON progress events; calls onProgress for each, resolves with the final
// result. Uses fetch (not axios) so we can read the response body incrementally.
export async function syncGmail(days?: number, onProgress?: (progress: SyncProgress) => void): Promise<SyncResult> {
	const response = await fetch('/api/gmail/sync', {
		method: 'POST',
		credentials: 'include',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(days ? { days } : {}),
	});
	if (!response.ok) {
		let failureMessage = 'Sync failed';
		try { failureMessage = ((await response.json()) as { error?: string }).error ?? failureMessage; } catch { /* non-JSON */ }
		throw new Error(failureMessage);
	}
	if (!response.body) throw new Error('Sync failed: no response stream');

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let finalResult: SyncResult | undefined;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		// Events are newline-delimited, and a chunk can split one mid-line — drain only the COMPLETE lines
		// and leave the remainder in the buffer for the next chunk to finish.
		let newlineIndex: number;
		while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
			const line = buffer.slice(0, newlineIndex).trim();
			buffer = buffer.slice(newlineIndex + 1);
			if (!line) continue;
			const progressEvent = JSON.parse(line) as { phase: string } & SyncResult & SyncProgress & { error?: string };
			if (progressEvent.phase === 'done') finalResult = { added: progressEvent.added, updated: progressEvent.updated, skipped: progressEvent.skipped, failed: progressEvent.failed, durationMs: progressEvent.durationMs };
			// A user-cancelled sync ends normally (not an error) carrying the partial counts it saved.
			else if (progressEvent.phase === 'cancelled') finalResult = { added: progressEvent.added, updated: progressEvent.updated, skipped: progressEvent.skipped, failed: progressEvent.failed, durationMs: progressEvent.durationMs, cancelled: true };
			else if (progressEvent.phase === 'error') throw new Error(progressEvent.error ?? 'Sync failed');
			else onProgress?.(progressEvent);   // 'start' and 'progress'
		}
	}
	if (!finalResult) throw new Error('Sync ended without a result');
	return finalResult;
}
