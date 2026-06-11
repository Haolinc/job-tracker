import type { Application } from './types';

// Factory for a valid Application in tests — override only the fields a test cares about.
let seq = 0;
export function makeApp(overrides: Partial<Application> = {}): Application {
	seq += 1;
	return {
		id: `app-${seq}`,
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
		created_at: '2026-01-01T00:00:00.000Z',
		updated_at: '2026-01-02T00:00:00.000Z',
		...overrides,
	};
}
