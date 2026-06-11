// ── ATS requisition / job-number extraction + canonicalisation ──────────────
// A req number is a stable per-posting key shared by a confirmation and its later status emails,
// so they match even when the company name is spelled differently.

/**
 * Pull the ATS requisition / job number from an email (subject or body) when it is explicitly
 * labelled — e.g. "Job Number: 210715977", "Job number: 210705462", "Req ID: 210705462",
 * "Requisition 123456". This is a stable unique key for one posting: the application confirmation
 * and the later status/rejection email for the same job both carry it, so it matches them reliably
 * even when the company name is written differently ("JPMorganChase" vs "JPMorgan Chase & Co.").
 * Returns the digits only, or null when no number is present.
 */
export function extractJobNumber(subject: string, body: string): string | null {
	const text = `${subject}\n${body}`;
	// Any candidate must carry ≥5 digits so a bare year ("2026"), level ("L3"), or short count isn't taken.
	const enoughDigits = (s: string) => (s.match(/[0-9]/g)?.length ?? 0) >= 5;
	// A requisition is kept AS WRITTEN — its short letter prefix/suffix and internal hyphens are the
	// company's own format ("2026-0013799", "722493BR", "R0859802"), so the confirmation and the later
	// status/rejection email for one posting carry the identical string and still match exactly.
	const TOKEN = '[A-Za-z]{0,3}[0-9][0-9A-Za-z]*(?:-[0-9][0-9A-Za-z]*)*';

	// 1. LABELLED ("Job ID# 2026-0013799", "Req ID: 210705462", "Requisition 123456", "Job Number: 210715977").
	// A SEPARATOR (space / colon / #) between the label and the number is required, so a label GLUED to the
	// digits ("REQ352476") is left for rule 2 to keep WHOLE — there the "REQ" is the company's code prefix,
	// not a label to strip.
	const labeled = text.match(
		new RegExp(`\\b(?:job\\s*(?:number|id|no\\.?|#)|req(?:uisition)?(?:\\s*(?:id|number|no\\.?|#))?|requisition)[\\s:#]+(${TOKEN})`, 'i'),
	);
	if (labeled && enoughDigits(labeled[1])) return labeled[1];
	// 1b. A bare "ID: 3092179" — the colon makes it an explicit label (not a stray "id" in prose). Amazon
	// posts the job id this way: "...your interest in Software Engineer (ID: 3092179)".
	const idLabel = text.match(new RegExp(`\\bID\\s*[:#]\\s*(${TOKEN})`, 'i'));
	if (idLabel && enoughDigits(idLabel[1])) return idLabel[1];
	// 2. An UNLABELLED but unmistakably req-shaped alphanumeric token: a 1-3 letter prefix + 5+ digits
	// ("R0859802") or 5+ digits + a 1-3 letter suffix ("722493BR", "124432BR"). This mixed letter/digit
	// shape doesn't occur in phone numbers, dates, or money, so it's safe to read without a label.
	const alnum = text.match(/\b([A-Za-z]{1,3}[0-9]{5,}|[0-9]{5,}[A-Za-z]{1,3})\b/);
	if (alnum) return alnum[1];
	// 3. A dash-set-off id in the SUBJECT ("...Software Engineer I – 31143106", "... – 2026-0013799").
	// Subject-only because phone numbers in body footers are also dash-separated digit runs.
	const dashed = subject.match(/[-–]\s*([0-9]{4,}(?:-[0-9]{2,})?|[0-9]{6,})\b/);
	if (dashed && enoughDigits(dashed[1])) return dashed[1];
	return null;
}

/**
 * Canonicalise a requisition id that came from the LLM (which is looser than the parser): drop a leading
 * "#" and a SPACED/punctuated "Req" / "Requisition" / "Job Req" LABEL the model sometimes prepends
 * (e.g. "Req 93091" → "93091", "Job Req 57663" → "57663"), then validate. A label GLUED straight to the
 * digits is kept — it is the company's code prefix, not a label ("REQ352476" stays "REQ352476", same as the
 * parser reads it). A requisition is ONE token of letters/digits and . _ - carrying ≥5 digits; prose,
 * label-only text, and non-numeric codes ("HREMOTE-US-Telework" → 0 digits) degrade to null. Underscores/
 * periods are kept so real ATS ids survive ("R_336139", "R.0056062").
 */
export function canonicalReqId(raw: string | null | undefined): string | null {
	if (raw == null) return null;
	const s = String(raw).trim()
		.replace(/^#\s*/, '')
		// A run of label words ("Req", "Job Number", "Requisition", "Job ID") each followed by a SEPARATOR;
		// a label glued straight to the digits ("REQ352476") has no separator and is left whole.
		.replace(/^(?:(?:job|req(?:uisition)?|ref(?:erence)?|number|no|id)[\s.:#-]+)+(?=[0-9A-Za-z])/i, '')
		.trim();
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s)) return null;
	if ((s.match(/[0-9]/g)?.length ?? 0) < 5) return null;
	return s;
}
