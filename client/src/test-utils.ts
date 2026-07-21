import type { Application } from './types';

// Factory for a valid Application in tests — override only the fields a test cares about.
// Ids default to numeric strings, matching what SQLite actually hands out (the CSV import treats a
// non-numeric id as "no id", so realistic ids matter for round-trip tests).
let seq = 0;
export function makeApp(overrides: Partial<Application> = {}): Application {
	seq += 1;
	return {
		id: String(seq),
		company: 'Acme',
		role: 'Software Engineer',
		status: 'applied',
		interview_step: null,
		reached_interview: false,
		date_applied: '2026-01-01',
		last_activity: '2026-01-02',
		job_url: null,
		notes: null,
		source: 'gmail',
		gmail_thread_id: null,
		account: null,
		emails: [],
		created_at: '2026-01-01T00:00:00.000Z',
		updated_at: '2026-01-02T00:00:00.000Z',
		...overrides,
	};
}
