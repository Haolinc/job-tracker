import type { EmailRef, Status } from '../types';

const STATUSES = new Set<Status>(['applied', 'interview', 'offer', 'rejected']);

// CSV cell encoding for the tracked-emails array. One entry per email as `category|messageId|date`,
// entries separated by " ; ". Fields never contain `|` or `;` (ids/dates/status words), so the split is
// unambiguous and the cell stays comma-free (no CSV quoting needed). The account lives in its own column.
const FIELD_SEP = '|';
const ENTRY_SEP = ' ; ';

export function serializeEmails(emails: EmailRef[]): string {
	return emails.map(e => [e.category, e.messageId, e.date].join(FIELD_SEP)).join(ENTRY_SEP);
}

export function parseEmails(cell: string): EmailRef[] {
	return cell
		.split(';')
		.map(s => s.trim())
		.filter(Boolean)
		.flatMap((entry): EmailRef[] => {
			const [category, messageId, date = ''] = entry.split(FIELD_SEP).map(p => p.trim());
			if (!messageId || !STATUSES.has(category as Status)) return [];   // drop malformed entries
			return [{ messageId, category: category as Status, date }];
		});
}

/**
 * Pull a Gmail message id from whatever the user pastes — a full Gmail deep-link (…#all/<id>,
 * …#inbox/<id>, …#search/q/<id>) or a bare id. Returns null when nothing id-like is found, so the
 * user can copy a whole Gmail URL and we extract the id for them.
 */
export function extractMessageId(input: string): string | null {
	const s = input.trim();
	if (!s) return null;
	const candidate = s.includes('#')
		? (s.split('#').pop() ?? '').split('/').pop()?.split('?')[0]?.trim() ?? ''
		: s;
	return /^[A-Za-z0-9_-]+$/.test(candidate) ? candidate : null;
}
