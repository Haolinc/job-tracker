import type { EmailRef, Status } from '../types';

const STATUSES = new Set<Status>(['applied', 'interview', 'offer', 'rejected']);

// CSV cell encoding for the tracked-emails array. One entry per email as `category|messageId|date`, with
// an optional 4th field `fast` flagging a LinkedIn/Indeed fast-apply notice. Entries are separated by
// " ; ". Fields never contain `|` or `;` (ids/dates/status words), so the split is unambiguous and the
// cell stays comma-free (no CSV quoting needed). The account lives in its own column.
const FIELD_SEP = '|';
const ENTRY_SEP = ' ; ';
const FAST_FLAG = 'fast';

export function serializeEmails(emails: EmailRef[]): string {
	return emails
		.map(emailRef => {
			const fields = [emailRef.category, emailRef.messageId, emailRef.date];
			if (emailRef.fast_apply) fields.push(FAST_FLAG);   // omitted for normal emails → unchanged encoding
			return fields.join(FIELD_SEP);
		})
		.join(ENTRY_SEP);
}

export function parseEmails(cell: string): EmailRef[] {
	return cell
		.split(';')
		.map(entry => entry.trim())
		.filter(Boolean)
		.flatMap((entry): EmailRef[] => {
			const [category, messageId, date = '', flag] = entry.split(FIELD_SEP).map(field => field.trim());
			if (!messageId || !STATUSES.has(category as Status)) return [];   // drop malformed entries
			const emailRef: EmailRef = { messageId, category: category as Status, date };
			if (flag === FAST_FLAG) emailRef.fast_apply = true;   // a legacy 4th field (account) never equals "fast"
			return [emailRef];
		});
}

/**
 * Pull a Gmail message id from whatever the user pastes — a full Gmail deep-link (…#all/<id>,
 * …#inbox/<id>, …#search/q/<id>) or a bare id. Returns null when nothing id-like is found, so the
 * user can copy a whole Gmail URL and we extract the id for them.
 */
export function extractMessageId(input: string): string | null {
	const pasted = input.trim();
	if (!pasted) return null;
	const candidate = pasted.includes('#')
		? (pasted.split('#').pop() ?? '').split('/').pop()?.split('?')[0]?.trim() ?? ''
		: pasted;
	return /^[A-Za-z0-9_-]+$/.test(candidate) ? candidate : null;
}
