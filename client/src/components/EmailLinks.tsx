import type { EmailRef } from '../types';
import { STATUS_LABELS, STATUS_COLORS } from '../constants';
import { gmailUrl } from '../utils/gmailUrl';

interface Props {
	emails: EmailRef[];
	account?: string | null;   // the Gmail account these emails live in — drives every link (one per application)
}

/**
 * Renders one "open in Gmail" link per tracked email, colour-coded by stage, in the order they are STORED
 * on the application — never re-sorted, because that order is the one the user arranges in the edit modal
 * (a sync appends new emails to the end, so a hand-picked order survives later syncs). Lets the user jump
 * straight to the actual message behind each status change. Renders nothing when there are no tracked
 * emails (manual/CSV entries).
 */
export default function EmailLinks({ emails, account }: Props) {
	if (emails.length === 0) return null;
	return (
		<div data-testid="email-links" className="mt-2 flex flex-wrap gap-1">
			{emails.map(emailRef => (
				<a
					key={emailRef.messageId}
					data-testid="email-link"
					href={gmailUrl(emailRef.messageId, account)}
					target="_blank"
					rel="noopener noreferrer"
					title={emailRef.fast_apply
						? `Open the LinkedIn/Indeed fast-apply email in Gmail${emailRef.date ? ` (${emailRef.date})` : ''}`
						: `Open the ${STATUS_LABELS[emailRef.category]} email in Gmail${emailRef.date ? ` (${emailRef.date})` : ''}`}
					className={`inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded-full hover:underline ${STATUS_COLORS[emailRef.category]}`}
				>
					{emailRef.fast_apply ? `⚡ Fast Applied` : `✉ ${STATUS_LABELS[emailRef.category]}`}
				</a>
			))}
		</div>
	);
}
