const pad = (n: number) => String(n).padStart(2, '0');

// Today's date as YYYY-MM-DD in the browser's LOCAL timezone. toISOString() formats in UTC, so in the
// evening in a timezone behind UTC it returns tomorrow's date — this keeps the user's actual calendar day.
export function todayLocalDate(): string {
	const d = new Date();
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Local date + time as YYYY-MM-DD_HH-mm-ss — a filename-safe stamp (no colons, which Windows forbids) so
// each export lands on its own file and its name says exactly when it was taken. Local, same as above.
export function todayLocalDateTime(): string {
	const d = new Date();
	return `${todayLocalDate()}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}
