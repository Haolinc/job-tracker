export type Status = 'applied' | 'interview' | 'offer' | 'rejected';
export type InterviewStep = 'phone_screen' | 'technical' | 'onsite' | 'final';
export type Source = 'manual' | 'gmail' | 'csv';

// A Gmail message that drove this application to a given stage — lets the user open the actual email.
// The inbox it lives in is the application-level `account` (one account per application), not stored per ref.
export interface EmailRef {
	messageId: string;       // Gmail message id → deep-link with gmailUrl()
	category: Status;        // which stage this email represents (applied/interview/offer/rejected)
	date: string;            // 'YYYY-MM-DD' of the email
}

export interface Application {
	id: string;
	company: string;
	role: string;
	status: Status;
	interview_step: InterviewStep | null;
	reached_interview: boolean;          // sticky: ever reached interview/offer
	date_applied: string | null;
	last_activity: string | null;
	job_url: string | null;
	notes: string | null;
	notes_source?: 'auto' | 'manual';   // server-managed: 'manual' notes survive syncs
	external_id?: string | null;         // server-managed: ATS req/job number
	company_domain?: string | null;      // server-managed: real employer domain (null for ATS/manual)
	edited?: boolean;                    // server-managed: true once the user edits the details
	detected_by?: 'parser' | 'llm' | null;   // server-managed: how the email was classified
	source: Source;
	gmail_thread_id: string | null;
	// The Gmail account this application's emails live in — drives every "open in Gmail" link. Set from
	// the synced mailbox (or entered manually); null when unknown (links fall back to the browser's u/0).
	account: string | null;
	emails: EmailRef[];                  // every Gmail message tracked for this application, by stage
	created_at: string;
	updated_at: string;
}

// The payload accepted when creating an application — an Application minus the fields the server always
// assigns itself (id + timestamps). One place to edit when a server-only field is added.
export type NewApplication = Omit<Application, 'id' | 'created_at' | 'updated_at'>;

export interface SyncResult {
	added: number;
	updated: number;
	skipped: number;
	failed: number;   // emails that errored on fetch this run; not synced, retried next sync
	durationMs: number;   // wall-clock time the sync took
}

export interface SyncProgress {
	processed: number;   // emails fetched + processed so far
	total: number;       // emails to process this run
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
	reached_interview: boolean;
	date_applied: string;
	last_activity: string;
	job_url: string;
	external_id: string;
	notes: string;
	account: string;          // Gmail account this application's emails live in (drives every link)
	emails: EmailRef[];       // tracked emails (sync-added or manually attached)
}
