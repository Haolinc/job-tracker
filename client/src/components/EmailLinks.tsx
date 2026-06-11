import type { EmailRef } from '../types';
import { STATUS_LABELS, STATUS_COLORS } from '../constants';
import { gmailUrl } from '../utils/gmailUrl';

interface Props {
	emails: EmailRef[];
	account?: string | null;   // the Gmail account these emails live in — drives every link (one per application)
}

/**
 * Renders one "open in Gmail" link per tracked email, chronological, colour-coded by stage. Lets the
 * user jump straight to the actual message behind each status change. Renders nothing when there are
 * no tracked emails (manual/CSV entries).
 */
export default function EmailLinks({ emails, account }: Props) {
	if (emails.length === 0) return null;
	const ordered = [...emails].sort((a, b) => a.date.localeCompare(b.date));

	return (
		<div data-testid="email-links" className="mt-2 flex flex-wrap gap-1">
			{ordered.map(e => (
				<a
					key={e.messageId}
					data-testid="email-link"
					href={gmailUrl(e.messageId, account)}
					target="_blank"
					rel="noopener noreferrer"
					title={`Open the ${STATUS_LABELS[e.category]} email in Gmail${e.date ? ` (${e.date})` : ''}`}
					className={`inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded-full hover:underline ${STATUS_COLORS[e.category]}`}
				>
					✉ {STATUS_LABELS[e.category]}
				</a>
			))}
		</div>
	);
}
