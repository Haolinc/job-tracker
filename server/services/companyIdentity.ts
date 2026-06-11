// ── Company identity from an email sender ─────────────────────
// Extracts the employer (name/domain) and decides whether two company names are the same entity.

// ATS platforms and generic mail providers — never treat their domain as a company name.
const ATS_DOMAINS = new Set([
	'greenhouse.io', 'greenhouse-mail.io', 'lever.co', 'icims.com', 'taleo.net', 'bamboohr.com',
	'smartrecruiters.com', 'jobvite.com', 'jazz.co', 'breezy.hr',
	'workday.com', 'myworkday.com', 'successfactors.com', 'applytojob.com',
	'recruitingbypaycor.com', 'paylocity.com', 'adp.com', 'ultipro.com',
	'indeed.com', 'linkedin.com', 'glassdoor.com', 'ziprecruiter.com',
	'rippling.com', 'brassring.com', 'ashbyhq.com', 'applyresponse.com', 'workablemail.com', 'kula.ai',
	'candidatecare.com',   // iCIMS Candidate Care portal — a shared ATS host, never the employer's own domain
	'governmentjobs.com', 'clearcompany.com', 'gem.com', 'oracle.com', 'ns2cloud.com', 'applicantemails.com',
	// Coding-assessment platforms — they send "on behalf of" an employer; the platform is never the company.
	'hackerrank.com', 'hackerrankforwork.com', 'codility.com', 'codesignal.com', 'hackerearth.com',
    // Generic email providers — almost certainly not the employer's real domain
	'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com', 'icloud.com',
]);

// Brand labels of the ATS_DOMAINS above ("icims", "greenhouse", "workday"…). Lets us reject regional /
// alternate TLDs of the same host that aren't listed explicitly — e.g. "talent.icims.eu" → "icims" → ATS,
// even though only "icims.com" is in the set. Without this, a shared ATS host would be mistaken for a
// company domain and wrongly merge different employers (Publicis Re:Sources Global vs Digital Experience).
const ATS_BRANDS = new Set([...ATS_DOMAINS].map(d => d.split('.')[0]));

// Strips trailing legal suffixes so e.g. "Sun West Mortgage Company" and
// "Sun West Mortgage" resolve to the same dedup key.
// The lookbehind (?<=\w) prevents matching " Co." in "Foo & Co." (which would
// leave a broken trailing "&") — only strip when preceded by a word character.
const COMPANY_SUFFIX_RE = /(?<=\w)[,.]?\s+(?:company|incorporated|inc\.?|llc|ltd\.?|corp\.?|corporation|co\.)$/i;

// LinkedIn company-page qualifiers appended after a spaced dash ("CLEAR - Corporate" → "CLEAR").
const LINKEDIN_QUALIFIER_RE = /\s+[-–]\s+(?:Corporate|Corp|HQ|Headquarters|Global|US|USA|U\.S\.A?\.?|North America|EMEA|APAC|Worldwide)\.?$/i;

export function normalizeCompany(name: string): string {
	// "X dba Y" / "X d/b/a Y" → Y, the trade name people actually use ("CP Payroll, LLC dba ConnectPay" → "ConnectPay").
	name = name.replace(/^.*?\bd\/?b\/?a\b\s*/i, '').trim();
	name = name.replace(LINKEDIN_QUALIFIER_RE, '').trim();
	return name.replace(COMPANY_SUFFIX_RE, '').trim();
}

// Generic local-part prefixes that identify the ATS or HR function, not the employer.
// "globalhr" is RTX's shared HR Workday address — not a company slug.
const GENERIC_LOCAL = /^(no.?reply|noreply|donotreply|workday|notifications?|info|support|careers|talent|hr|recruiting|jobs?|globalhr)$/i;

/**
 * Last-resort fallback: parse the employer name from the sender domain.
 * e.g. "noreply@walmart.com" → "Walmart", "careers@stripe.com" → "Stripe".
 * Returns null for ATS platforms, generic providers, and unrecognised senders.
 *
 * Special case: Workday branded subdomains use the local part as the company
 * slug (e.g. "cableone@myworkday.com" → "CableONE"). The LLM already knows
 * this rule but fails when the email body contains no company name.
 */
export function extractCompanyFromSender(from: string): string | null {
	const rawEmail = from.match(/<([^>]+)>/)?.[1] ?? from.match(/\S+@\S+/)?.[0];
	if (!rawEmail) return null;
	const [localPart, domain] = rawEmail.toLowerCase().split('@');
	if (!domain) return null;

	// Workday branded subdomains: "cableone@myworkday.com" → company slug is "cableone".
	// Slugs ≤ 2 chars (e.g. "ms" for Morgan Stanley) are abbreviations the fallback
	// can't meaningfully expand — return null and let the LLM extract from the body.
	if (domain === 'myworkday.com') {
		if (!localPart || GENERIC_LOCAL.test(localPart) || localPart.length <= 2) return null;
		return localPart.charAt(0).toUpperCase() + localPart.slice(1);
	}

	if (ATS_DOMAINS.has(domain)) return null;
	// Also check parent domain for subdomained ATS hosts (e.g. "us.greenhouse-mail.io").
	const labels = domain.split('.');
	if (labels.length >= 3 && ATS_DOMAINS.has(labels.slice(1).join('.'))) return null;

	// "careers.walmart.com" → "walmart";  "walmart.com" → "walmart"
	const companySlug = labels.length >= 3 ? labels[labels.length - 2] : labels[0];
	return companySlug.charAt(0).toUpperCase() + companySlug.slice(1);
}

// HR/ATS-function words that get appended to a corporate sender's display name. Their presence is the
// signal that the display name is a COMPANY (not a person), so we only trust the name when one strips off.
const SENDER_NAME_SUFFIX = /[\s,]*(?:[-–|]\s*)?(?:(?:p&o|people(?:\s*&\s*organization)?)\s+)?(?:workday\s+)?(?:talent acquisition(?:\s+team)?|talent team|career opportunities|careers|recruit(?:ing|ment)(?:\s+team)?|human resources|hiring(?:\s+team)?|notifications?)\s*$/i;

/**
 * Fallback for ATS senders whose body omits the company: recover it from the sender DISPLAY NAME.
 * Only trusted when the name (a) carries an HR/ATS suffix we can strip ("RTX Workday Notifications" →
 * "RTX", "Siemens P&O Talent Acquisition" → "Siemens") or (b) uses the icims " @ " form ("Charles
 * Schwab Corporation @ icims" → "Charles Schwab Corporation"). A plain personal/company name with no
 * such marker is ignored — it's as likely to be a recruiter's name as an employer.
 */
export function extractCompanyFromSenderName(from: string): string | null {
	const name = (from.split('<')[0] ?? '').trim().replace(/^["']|["']$/g, '').trim();
	if (!name) return null;

	// icims form: "<Company> @ icims" — the part after " @ " is the ATS, not the company.
	const atIdx = name.indexOf(' @ ');
	if (atIdx > 0) return name.slice(0, atIdx).trim() || null;
	if (name.includes('@')) return null;   // a raw address slipped through — no usable display name

	// Strip one or more trailing HR/ATS suffix runs ("Siemens P&O Talent Acquisition" → "Siemens").
	let stripped = name;
	for (let prev = ''; prev !== stripped; ) { prev = stripped; stripped = stripped.replace(SENDER_NAME_SUFFIX, '').trim(); }
	if (stripped === name || stripped.length < 2) return null;   // nothing stripped → likely a person, not a company
	return stripped;
}

// Generic corporate/industry descriptors. A longer company name that only ADDS these to a shorter one
// is the same entity under a fuller name ("SS&C" → "SS&C Technologies"). A non-descriptor extra word
// ("Epic" → "Epic Kids") signals a DIFFERENT company that merely shares a first word.
const COMPANY_DESCRIPTOR = new Set([
	// corporate structure / generic
	'group', 'holdings', 'capital', 'partners', 'ventures', 'international', 'global', 'worldwide',
	'industries', 'enterprises', 'company', 'brands', 'labs', 'studios', 'inc', 'llc', 'ltd', 'plc',
	'corp', 'corporation', 'co', 'management', 'advisors', 'advisory', 'asset', 'investments',
	// tech / functional descriptors
	'technologies', 'technology', 'tech', 'sciences', 'science', 'systems', 'solutions', 'software',
	'hardware', 'digital', 'services', 'consulting', 'networks', 'communications', 'analytics',
	'security', 'cloud', 'data', 'robotics', 'semiconductor', 'semiconductors', 'electronics',
	// industry sectors — "Fora Travel" is the same company as "Fora"; "Travel" is its sector, not a new brand
	'financial', 'finance', 'trust', 'health', 'healthcare', 'bank', 'media', 'pharmaceuticals', 'pharma',
	'bio', 'biosciences', 'therapeutics', 'diagnostics', 'energy', 'power', 'retail', 'foods', 'food',
	'motors', 'automotive', 'aerospace', 'travel', 'hospitality', 'insurance', 'mortgage', 'realty',
	'logistics', 'transport', 'transportation', 'education', 'learning', 'payments', 'lending',
	'entertainment', 'games', 'gaming', 'sports', 'fitness', 'apparel', 'beverages', 'restaurants',
	'hotels', 'airlines', 'telecom', 'telecommunications', 'mobility', 'space', 'defense', 'materials',
]);

/**
 * The sender's real company domain, or null. Returns null for ATS / job-board / generic-provider
 * senders (LinkedIn, Indeed, Workday, Greenhouse, gmail.com…) so only a genuine company talent-team
 * address ("careers@epic.com" → "epic.com") is kept. Stored on the application and used to
 * disambiguate companies that share a first word during matching.
 */
export function companyDomainFromSender(from: string): string | null {
	const rawEmail = from.match(/<([^>]+)>/)?.[1] ?? from.match(/\S+@\S+/)?.[0];
	const domain = rawEmail?.toLowerCase().split('@')[1];
	if (!domain) return null;
	if (ATS_DOMAINS.has(domain)) return null;
	const labels = domain.split('.');
	// registrable domain ≈ last two labels ("careers.epic.com" → "epic.com"), but last THREE for multi-part
	// TLDs ("careers.acme.co.uk" → "acme.co.uk", not the shared "co.uk").
	let registrable = labels.length >= 2 ? labels.slice(-2).join('.') : domain;
	if (labels.length >= 3 && /^(?:co|com|org|net|gov|edu|ac|or|ne|go)\.[a-z]{2}$/.test(registrable)) {
		registrable = labels.slice(-3).join('.');
	}
	if (ATS_DOMAINS.has(registrable)) return null;            // subdomained ATS host ("us.greenhouse-mail.io")
	if (ATS_BRANDS.has(registrable.split('.')[0])) return null;   // regional/alternate TLD of a known ATS ("icims.eu")
	return registrable;
}

const companyWords = (s: string) => s.toLowerCase().split(/\s+/).map(w => w.replace(/[^a-z0-9]/g, '')).filter(Boolean);

/**
 * LOOSE name match — one name's words are a leading prefix of the other's ("Epic" ⊂ "Epic Kids",
 * "Lila" ⊂ "Lila Sciences"). Used only to GATHER candidates cheaply; findExisting then confirms the
 * real employer with the sender domain and companiesSameEntity. Keeps "Morgan Stanley" vs "Morgan
 * Lewis" apart (second word differs) and "Lila" vs "Lilac" apart (different first word).
 */
function companiesCompatible(a: string, b: string): boolean {
	const wa = companyWords(a), wb = companyWords(b);
	if (!wa.length || !wb.length) return false;
	const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
	return short.every((w, i) => w === long[i]);
}

/**
 * STRICT same-employer check — a prefix match where the longer name only ADDS generic
 * corporate/industry descriptors ("SS&C" ↔ "SS&C Technologies", "Fora" ↔ "Fora Travel"). A distinct
 * proper noun in the extra words means a DIFFERENT company sharing a first word ("Epic" ✗ "Epic Kids").
 * This is the fallback when the sender domain can't decide (e.g. both records came from ATS senders).
 */
export function companiesSameEntity(a: string, b: string): boolean {
	if (!companiesCompatible(a, b)) return false;
	const wa = companyWords(a), wb = companyWords(b);
	const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
	return long.slice(short.length).every(w => COMPANY_DESCRIPTOR.has(w));
}
