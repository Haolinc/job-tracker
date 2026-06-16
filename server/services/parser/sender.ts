// ── Sender helper ───────────────────────────────────────────────────────────
// The lowercased email address out of a "Display Name <addr>" From header. Shared by the
// platform extractors (LinkedIn, Indeed, …) so each can gate on its own sending domain.

export function senderEmail(from: string): string {
	return (from.match(/<([^>]+)>/)?.[1] ?? from.match(/\S+@\S+/)?.[0] ?? '').toLowerCase();
}
