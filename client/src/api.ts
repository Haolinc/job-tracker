import axios from 'axios';
import type { Application, NewApplication, Filters, SyncResult, SyncProgress } from './types';

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

export const getAuthStatus = (): Promise<{ connected: boolean }> =>
	api.get('/auth/status').then(r => r.data as { connected: boolean });

export const disconnectGmail = (): Promise<{ success: boolean }> =>
	api.post('/auth/disconnect').then(r => r.data as { success: boolean });

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
			const ev = JSON.parse(line) as { phase: string } & SyncResult & SyncProgress & { error?: string };
			if (ev.phase === 'done') final = { added: ev.added, updated: ev.updated, skipped: ev.skipped, failed: ev.failed, durationMs: ev.durationMs };
			else if (ev.phase === 'error') throw new Error(ev.error ?? 'Sync failed');
			else onProgress?.(ev);   // 'start' and 'progress'
		}
	}
	if (!final) throw new Error('Sync ended without a result');
	return final;
}
