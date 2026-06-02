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
// Who last wrote `notes`. 'manual' notes are user-authored and never overwritten by a sync;
// 'auto' notes are sync-generated and always re-pinned to the oldest (application) email.
export type NoteSource = 'auto' | 'manual';
export type Category = 'applied' | 'interview' | 'offer' | 'rejected' | 'ignored';

export interface Application {
	id: string;
	company: string;
	role: string;
	lookup_key: string | null;
	status: Status;
	interview_step: InterviewStep | null;
	date_applied: string | null;
	last_activity: string | null;
	job_url: string | null;
	notes: string | null;
	notes_source: NoteSource;
	source: Source;
	gmail_thread_id: string | null;
	created_at: string;
	updated_at: string;
}

export interface Classification {
	category: Category;
	company: string | null;
	role: string | null;
    classifier_code?: string; // Optional field to store which parser/classifier was used
}

export interface EmailResult {
	threadId: string;
	messageId: string;
	subject: string;
	from: string;
	body: string;
	lastMessageDate: string;   // "YYYY-MM-DD" — display / date_applied
	internalDate: number;      // epoch ms — precise sort key (lastMessageDate alone ties same-day emails)
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
	notes_source?: NoteSource;   // defaults to 'auto' when omitted
	source: Source;
	gmail_thread_id: string | null;
}

export interface MarkSyncedData {
	thread_id: string;
	message_id: string;
	classified_as: Category;
}
