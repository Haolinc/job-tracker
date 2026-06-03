import type { Status, InterviewStep } from './types';

export const STATUS_LABELS: Record<Status, string> = {
	applied:   'Applied',
	interview: 'Interview',
	offer:     'Offer',
	rejected:  'Rejected',
};

export const STATUS_COLORS: Record<Status, string> = {
	applied:   'bg-blue-100 text-blue-700',
	interview: 'bg-yellow-100 text-yellow-700',
	offer:     'bg-green-100 text-green-700',
	rejected:  'bg-red-100 text-red-700',
};

export const STEP_LABELS: Record<InterviewStep, string> = {
	phone_screen: 'Phone Screen',
	technical:    'Technical',
	onsite:       'Onsite',
	final:        'Final Round',
};

/** An application whose role couldn't be auto-detected — surfaced with a warning and sorted first. */
export const isUnknownRole = (role: string | null): boolean => !role || role.trim() === '' || role === 'Unknown Role';
