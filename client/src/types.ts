export type Status = 'wishlist' | 'applied' | 'interview' | 'offer' | 'rejected';
export type Priority = 'high' | 'medium' | 'low';
export type Source = 'manual' | 'gmail';

export interface Application {
	id: number;
	company: string;
	role: string;
	status: Status;
	priority: Priority;
	date_applied: string | null;
	job_url: string | null;
	notes: string | null;
	source: Source;
	gmail_thread_id: string | null;
	created_at: string;
	updated_at: string;
}

export interface SyncResult {
	added: number;
	updated: number;
	skipped: number;
}

export interface SyncRecord {
	id: number;
	added: number;
	updated: number;
	skipped: number;
	synced_at: string;
}

export interface Filters {
	search: string;
	priority: string;
	[key: string]: string;
}

export interface ApplicationFormData {
	id?: number;
	company: string;
	role: string;
	status: Status;
	priority: Priority;
	date_applied: string;
	job_url: string;
	notes: string;
}
