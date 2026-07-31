/** A millisecond duration as compact h/m/s ("5m 41s", "1h 2m", "8s"). Zero-value units are dropped. */
export function formatDuration(ms: number): string {
	const totalSeconds = Math.round(ms / 1000);
	const hours   = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	const parts: string[] = [];
	if (hours) parts.push(`${hours}h`);
	if (minutes) parts.push(`${minutes}m`);
	if (seconds || !parts.length) parts.push(`${seconds}s`);
	return parts.join(' ');
}
