import type { Status, InterviewStep, Source, EmailOrigin } from './types';

export const STATUS_LABELS: Record<Status, string> = {
	applied:   'Applied',
	interview: 'Interview',
	offer:     'Offer',
	rejected:  'Rejected',
};

export const STATUS_COLORS: Record<Status, string> = {
	applied:   'bg-blue-100 text-blue-700',
	interview: 'bg-yellow-100 text-yellow-700',
	offer:     'bg-green-100 text-green-700',
	rejected:  'bg-red-100 text-red-700',
};

export const STEP_LABELS: Record<InterviewStep, string> = {
	phone_screen: 'Phone Screen',
	technical:    'Technical',
	onsite:       'Onsite',
	final:        'Final Round',
};

/** An application whose role couldn't be auto-detected — surfaced with a warning and sorted first. */
export const isUnknownRole = (role: string | null): boolean => !role || role.trim() === '' || role === 'Unknown Role';

// A small pill describing where a card's data came from.
interface ProvenanceBadge { label: string; cls: string; title: string }

// Auto-detection badges — distinguish the rule-based parser from the AI classifier, for debugging.
type Detection = 'parser' | 'llm';
export const DETECTION_BADGE: Record<Detection, ProvenanceBadge> = {
	parser: { label: '⚙️ Detected by Parser', cls: 'bg-emerald-50 text-emerald-700', title: 'Detected by the rule-based parser' },
	llm:    { label: '🤖 Detected by AI',     cls: 'bg-violet-50 text-violet-700',   title: 'Detected by the AI classifier' },
};

const IMPORT_BADGE: ProvenanceBadge = {
	label: '📄 Imported',
	cls:   'bg-sky-50 text-sky-700',
	title: 'Imported from a CSV file',
};

/** Which detection badge to show, or null when there's none (manual entry, or the user has edited it). */
export const detectionBadge = (app: { detected_by?: Detection | null; edited?: boolean }): Detection | null =>
	app.edited ? null : (app.detected_by ?? null);

/**
 * The provenance pills to show on a card/row — two independent axes, either/both/neither:
 *  • a CSV import keeps a permanent "Imported" pill (origin; `source` is sticky across merges);
 *  • a parser/AI pill shows HOW the latest email update was classified, and clears once the user
 *    edits the card to confirm it.
 * So an imported card whose status a sync later updated reads e.g. "📄 Imported  ⚙️ Parser".
 */
export const provenanceBadges = (app: { detected_by?: Detection | null; edited?: boolean; source: Source }): ProvenanceBadge[] => {
	const badges: ProvenanceBadge[] = [];
	if (app.source === 'csv') badges.push(IMPORT_BADGE);
	const d = detectionBadge(app);
	if (d) badges.push({ ...DETECTION_BADGE[d], title: `${DETECTION_BADGE[d].title} — edit to confirm and clear the tag` });
	return badges;
};

// Per-email origin badges, shown ONLY in the edit modal's rows — the board and table are scanning surfaces,
// where per-email provenance would be permanent cost for rarely-wanted detail. Sky reuses IMPORT_BADGE's
// tint since it means the same thing one level down. An untagged ref badges as a muted 'Unknown' rather than
// nothing, so the row reads "we don't know" instead of looking like the badge failed to render.
const EMAIL_ORIGIN_BADGE: Record<EmailOrigin | 'unknown', ProvenanceBadge> = {
	synced:   { label: 'Synced',   cls: 'bg-emerald-50 text-emerald-700', title: 'Found by a Gmail sync' },
	imported: { label: 'Imported', cls: 'bg-sky-50 text-sky-700',         title: 'First seen in a CSV import' },
	manual:   { label: 'Manual',   cls: 'bg-amber-50 text-amber-700',     title: 'Attached by hand in this window' },
	unknown:  { label: 'Unknown',  cls: 'bg-gray-100 text-gray-500',      title: 'Attached before origins were tracked — no way to tell now' },
};

/** The badge for one ref: its origin, or the unknown badge when it predates the field. */
export const emailOriginBadge = (emailRef: { origin?: EmailOrigin }): ProvenanceBadge =>
	EMAIL_ORIGIN_BADGE[emailRef.origin ?? 'unknown'];
