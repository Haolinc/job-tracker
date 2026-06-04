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
// How a Gmail-sourced classification was produced — for debugging which path handled an email:
// 'parser' = the deterministic regex parser, 'llm' = the AI classifier. null for manual entries.
export type DetectedBy = 'parser' | 'llm';
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
	// Sticky: true once the application ever reached interview/offer, even if later rejected.
	// Set by sync (any interview/offer email) or manually; never auto-cleared.
	reached_interview: boolean;
	date_applied: string | null;
	last_activity: string | null;
	// Precise epoch (ms) of the email behind last_activity — the exact ordering key for "newest wins"
	// (the day-string last_activity ties same-day emails). 0 when unknown.
	last_activity_ts: number;
	job_url: string | null;
	notes: string | null;
	notes_source: NoteSource;
	// ATS requisition/job number when the email carries one. A stable unique key for a posting:
	// the confirmation and its later status email share it, so they match even across company-name
	// spellings. Null when no labelled number was found.
	external_id: string | null;
	// True once the user has edited the application's details — used to drop the "auto-detected" tag.
	edited: boolean;
	// Which path classified the email that last drove this record (parser vs LLM); null for manual.
	detected_by: DetectedBy | null;
	// Registrable domain of the sender when the email came from a REAL company address ("epic.com").
	// Null for ATS / job-board senders (LinkedIn, Indeed, Workday, Greenhouse…) and manual entries.
	// Used to disambiguate companies that merely share a first word ("Epic" vs "Epic Kids") when matching.
	company_domain: string | null;
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
	reached_interview?: boolean;   // defaults to false when omitted
	date_applied: string | null;
	last_activity: string | null;
	last_activity_ts?: number;     // defaults to 0 when omitted
	job_url: string | null;
	notes: string | null;
	notes_source?: NoteSource;   // defaults to 'auto' when omitted
	external_id?: string | null;   // ATS req/job number, when present
	edited?: boolean;              // defaults to false when omitted
	detected_by?: DetectedBy | null;   // 'parser' | 'llm'; null for manual
	company_domain?: string | null;    // real company domain of the sender; null for ATS/job-board/manual
	source: Source;
	gmail_thread_id: string | null;
}

export interface MarkSyncedData {
	thread_id: string;
	message_id: string;
	classified_as: Category;
}
