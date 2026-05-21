export type Status = 'applied' | 'interview' | 'offer' | 'rejected';
export type InterviewStep = 'phone_screen' | 'technical' | 'onsite' | 'final';
export type Source = 'manual' | 'gmail';

export interface Application {
	id: string;
	company: string;
	role: string;
	status: Status;
	interview_step: InterviewStep | null;
	date_applied: string | null;
	last_activity: string | null;
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

export interface Filters {
	search: string;
}

export interface ApplicationFormData {
	id?: string;
	company: string;
	role: string;
	status: Status;
	interview_step: InterviewStep | '';
	date_applied: string;
	last_activity: string;
	job_url: string;
	notes: string;
}
