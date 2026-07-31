const pad = (value: number) => String(value).padStart(2, '0');

// Today's date as YYYY-MM-DD in the browser's LOCAL timezone. toISOString() formats in UTC, so in the
// evening in a timezone behind UTC it returns tomorrow's date — this keeps the user's actual calendar day.
export function todayLocalDate(): string {
	const now = new Date();
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// Local date + time as YYYY-MM-DD_HH-mm-ss — a filename-safe stamp (no colons, which Windows forbids) so
// each export lands on its own file and its name says exactly when it was taken. Local, same as above.
export function todayLocalDateTime(): string {
	const now = new Date();
	return `${todayLocalDate()}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}
