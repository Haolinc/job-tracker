/** A millisecond duration as compact h/m/s ("5m 41s", "1h 2m", "8s"). Zero-value units are dropped. */
export function formatDuration(ms: number): string {
	const total = Math.round(ms / 1000);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const parts: string[] = [];
	if (h) parts.push(`${h}h`);
	if (m) parts.push(`${m}m`);
	if (s || !parts.length) parts.push(`${s}s`);
	return parts.join(' ');
}
