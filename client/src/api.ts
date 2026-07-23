import axios from 'axios';
import type { Application, NewApplication, EmailRef, Filters, SyncResult, SyncProgress } from './types';

const api = axios.create({ baseURL: '/api', withCredentials: true });

export const getApplications = (params?: Filters): Promise<Application[]> =>
	api.get('/applications', { params }).then(r => r.data as Application[]);

export const createApplication = (data: NewApplication): Promise<Application> =>
	api.post('/applications', data).then(r => r.data as Application);

export const updateApplication = (id: string, data: Partial<Application>): Promise<Application> =>
	api.patch(`/applications/${id}`, data).then(r => r.data as Application);

export const deleteApplication = (id: string): Promise<void> =>
	api.delete(`/applications/${id}`);

export const resetDatabase = (): Promise<{ applications: number; syncedEmails: number }> =>
	api.delete('/applications/all').then(r => r.data as { applications: number; syncedEmails: number });

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
	api.post('/applications/import', payload).then(r => r.data as ImportApplyResult);

export const getAuthStatus = (): Promise<{ connected: boolean }> =>
	api.get('/auth/status').then(r => r.data as { connected: boolean });

export const disconnectGmail = (): Promise<{ success: boolean }> =>
	api.post('/auth/disconnect').then(r => r.data as { success: boolean });

// A single snapshot of the server-side sync, polled by a reconnecting tab to restore its progress bar (the
// /sync stream only reaches the tab that started the run). `event` is the latest streamed event of any phase;
// callers pair it with `running` — a false `running` means any event is from a sync that already finished.
export interface SyncStatus {
	running: boolean;
	event: (SyncProgress & { phase?: string; failed?: number; durationMs?: number; error?: string }) | null;
}

export const getSyncStatus = (): Promise<SyncStatus> =>
	api.get('/gmail/sync/status').then(r => r.data as SyncStatus);

// Ask the server to stop the running sync. Resolves once the request is acknowledged; the sync itself ends
// a moment later as a 'cancelled' event on the progress stream / snapshot.
export const cancelGmailSync = (): Promise<{ cancelling: boolean }> =>
	api.post('/gmail/sync/cancel').then(r => r.data as { cancelling: boolean });

// Streams newline-delimited JSON progress events; calls onProgress for each, resolves with the final
// result. Uses fetch (not axios) so we can read the response body incrementally.
export async function syncGmail(days?: number, onProgress?: (p: SyncProgress) => void): Promise<SyncResult> {
	const res = await fetch('/api/gmail/sync', {
		method: 'POST',
		credentials: 'include',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(days ? { days } : {}),
	});
	if (!res.ok) {
		let msg = 'Sync failed';
		try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* non-JSON */ }
		throw new Error(msg);
	}
	if (!res.body) throw new Error('Sync failed: no response stream');

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let final: SyncResult | undefined;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let nl: number;
		while ((nl = buffer.indexOf('\n')) >= 0) {
			const line = buffer.slice(0, nl).trim();
			buffer = buffer.slice(nl + 1);
			if (!line) continue;
			const progressEvent = JSON.parse(line) as { phase: string } & SyncResult & SyncProgress & { error?: string };
			if (progressEvent.phase === 'done') final = { added: progressEvent.added, updated: progressEvent.updated, skipped: progressEvent.skipped, failed: progressEvent.failed, durationMs: progressEvent.durationMs };
			// A user-cancelled sync ends normally (not an error) carrying the partial counts it saved.
			else if (progressEvent.phase === 'cancelled') final = { added: progressEvent.added, updated: progressEvent.updated, skipped: progressEvent.skipped, failed: progressEvent.failed, durationMs: progressEvent.durationMs, cancelled: true };
			else if (progressEvent.phase === 'error') throw new Error(progressEvent.error ?? 'Sync failed');
			else onProgress?.(progressEvent);   // 'start' and 'progress'
		}
	}
	if (!final) throw new Error('Sync ended without a result');
	return final;
}
