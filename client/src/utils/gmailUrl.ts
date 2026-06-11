// Deep-link to a single Gmail message. The `#all/<id>` anchor opens the message regardless of which
// label/folder it lives in, so it works for archived mail too.
//
// Account disambiguation uses the `authuser=<address>` QUERY param — Google's supported way to pick the
// account by email and redirect to its correct u/<index>. (Putting the email in the path, /u/<address>/,
// is NOT supported by Gmail and shows an "account temporarily unavailable" page.) Without an account we
// omit authuser and fall back to u/0 — the browser's primary account.
export const gmailUrl = (messageId: string, account?: string | null): string => {
	const auth = account ? `?authuser=${encodeURIComponent(account)}` : '';
	return `https://mail.google.com/mail/u/0/${auth}#all/${encodeURIComponent(messageId)}`;
};
