import 'express-session';
import type { Credentials } from 'google-auth-library';

declare module 'express-session' {
	interface SessionData {
		tokens: Credentials | null;
	}
}

export type Status = 'applied' | 'interview' | 'offer' | 'rejected';
export type InterviewStep = 'phone_screen' | 'technical' | 'onsite' | 'final';
export type Source = 'manual' | 'gmail';
export type Category = 'applied' | 'interview' | 'offer' | 'rejected' | 'ignored';

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

export interface Classification {
	category: Category;
	company: string | null;
	role: string | null;
}

export interface EmailResult {
	threadId: string;
	messageId: string;
	subject: string;
	from: string;
	body: string;
	lastMessageDate: string;
}

export interface CreateApplicationData {
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
}

export interface MarkSyncedData {
	thread_id: string;
	message_id: string;
	classified_as: Category;
}
