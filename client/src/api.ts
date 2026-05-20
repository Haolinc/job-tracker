import axios from 'axios';
import type { Application, SyncResult, SyncRecord } from './types';

const api = axios.create({ baseURL: '/api', withCredentials: true });

export const getApplications = (params?: Record<string, string>): Promise<Application[]> =>
	api.get('/applications', { params }).then(r => r.data as Application[]);

export const createApplication = (data: Omit<Application, 'id' | 'created_at' | 'updated_at'>): Promise<Application> =>
	api.post('/applications', data).then(r => r.data as Application);

export const updateApplication = (id: number, data: Partial<Application>): Promise<Application> =>
	api.patch(`/applications/${id}`, data).then(r => r.data as Application);

export const deleteApplication = (id: number): Promise<void> =>
	api.delete(`/applications/${id}`);

export const getAuthStatus = (): Promise<{ connected: boolean }> =>
	api.get('/auth/status').then(r => r.data as { connected: boolean });

export const disconnectGmail = (): Promise<{ success: boolean }> =>
	api.post('/auth/disconnect').then(r => r.data as { success: boolean });

export const syncGmail = (): Promise<SyncResult> =>
	api.post('/gmail/sync').then(r => r.data as SyncResult);

export const getSyncHistory = (): Promise<SyncRecord[]> =>
	api.get('/gmail/sync/history').then(r => r.data as SyncRecord[]);
