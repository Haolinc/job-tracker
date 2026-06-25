// Turning a raw Gmail message payload into the clean text the classifier reads: MIME-part selection,
// HTML stripping, entity/zero-width/footer cleanup, and the Indeed special-case that lifts the employer
// out of the HTML part. Exposes buildBody; everything else is internal noise-removal detail.

import type { gmail_v1 } from 'googleapis';

const BODY_LIMIT = 800;

// ── Body extraction helpers ───────────────────────────────────────────────────

/** Recursively find the first part matching a given MIME type. */
function findPart(
	part: gmail_v1.Schema$MessagePart | undefined,
	mimeType: string,
): gmail_v1.Schema$MessagePart | null {
	if (!part) return null;
	if (part.mimeType === mimeType && part.body?.data) return part;
	for (const child of part.parts ?? []) {
		const found = findPart(child, mimeType);
		if (found) return found;
	}
	return null;
}

function decodePart(part: gmail_v1.Schema$MessagePart): string {
	return Buffer.from(part.body!.data!, 'base64url').toString('utf-8');
}

function stripHtml(html: string): string {
	return html
		.replace(/<style[\s\S]*?<\/style>/gi, '')
		.replace(/<script[\s\S]*?<\/script>/gi, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

// Signals that mark the start of boilerplate footers.
// Everything from the first match onward is discarded.
const FOOTER_RE = /please do not reply to this (email|message)|this is an auto(?:matically)? generated email|this message was sent to \S+@\S+|if you (don.t|no longer) want to receive|references\s+visible links|copyright \(c\) \d{4}|\ball rights reserved\b|this email was intended for \S+@\S+|sorry, replies to this message can.t be delivered|connect with .{1,40} on linkedin|facebook \| twitter|instagram \| linkedin|\*{10,}/i;

/**
 * Strip noise from a decoded email body before sending it to the classifier.
 *
 * Steps (in order):
 *  1. Re-run stripHtml if the "plain" part contains raw HTML markup (malformed emails).
 *  2. Decode residual HTML entities (&nbsp; &amp; &rsquo; &zwnj; …).
 *  3. Remove Unicode invisible / zero-width characters used as email spacers.
 *  4. Remove known artifact prefixes ("RTF Template", leading "96 ").
 *  5. Remove [N] link-reference numbers left by plain-text renderers.
 *  6. Remove all URLs — never needed for company/role/category extraction.
 *  7. Truncate at the first footer signal (unsubscribe notices, copyright, social links).
 *  8. Collapse whitespace.
 */
// HTML entities + Unicode invisible/zero-width characters (email tracking spacers): ZWSP, ZWNJ,
// ZWJ, LRM, RLM, LSEP, PSEP, SHY, BOM, NBSP. Shared by cleanBody and cleanLinkedInBody.
function decodeEntities(text: string): string {
	return text
		.replace(/&nbsp;/gi,   ' ')
		.replace(/&amp;/gi,    '&')
		.replace(/&lt;/gi,     '<')
		.replace(/&gt;/gi,     '>')
		.replace(/&#39;/gi,    "'")
		.replace(/&rsquo;/gi,  "'")
		.replace(/&lsquo;/gi,  "'")
		.replace(/&rdquo;/gi,  '"')
		.replace(/&ldquo;/gi,  '"')
		.replace(/&hellip;/gi, '...')
		.replace(/&zwnj;/gi,   '')
		.replace(/&#x0*27;/gi,    "'")    // hex apostrophe (&#x27;) \u2014 keep "don't" intact
		.replace(/&#x201[89];/gi, "'")    // hex curly single quotes (&#x2018; &#x2019;)
		.replace(/&#x201[cd];/gi, '"')    // hex curly double quotes (&#x201C; &#x201D;)
		.replace(/&#x[0-9a-f]+;/gi, ' ')  // any other hex entity \u2192 space (mirrors the decimal rule below)
		.replace(/&#\d+;/g,    ' ')
		.replace(/[\u00A0\u00AD\u200B-\u200F\u2028\u2029\uFEFF]/g, '');
}

function cleanBody(raw: string): string {
	let text = raw;

	// 1. Re-strip if plain-text part contains raw HTML (e.g. Precision Neuroscience).
	if (/<[a-z][\s\S]*?>/i.test(text)) text = stripHtml(text);

	// 2-3. HTML entities + invisible/zero-width characters.
	text = decodeEntities(text);

	// 4. Artifact prefixes.
	text = text.replace(/^\s*RTF Template\s*/i, '');  // Oracle/Workday HTML-to-text artifact
	text = text.replace(/^\s*96\s+/, '');              // HTML preheader number (Walmart, Amazon)

	// 5. [N] link-reference numbers from plain-text email renderers.
	text = text.replace(/\[\d+\]/g, '');

	// 6. URLs.
	text = text.replace(/https?:\/\/\S+/g, '');

	// 6b. Decorative divider runs ("*---*---*---*", "======", "- - - -") and do-not-reply notices.
	// These can appear ANYWHERE — including as the entire body of an unrendered template (City of
	// Scottsdale) — so they're removed in place rather than only via the trailing-footer truncation.
	text = text.replace(/(?:[*\-=_~+•]\s?){4,}/g, ' ');
	text = text.replace(/\b(?:please\s+)?do not (?:reply|respond) to this (?:email|message)\b[^.!?\n]*[.!?]?/gi, ' ');
	text = text.replace(/\bif you reply to this (?:email|message)\b[^.!?\n]*[.!?]?/gi, ' ');
	text = text.replace(/\breplies (?:to this (?:message|email) )?(?:are undeliverable|will not (?:be (?:read|delivered)|reach))\b[^.!?\n]*[.!?]?/gi, ' ');

	// 7. Footer truncation — discard everything from the first boilerplate signal.
	const footerIdx = text.search(FOOTER_RE);
	if (footerIdx > 0) text = text.slice(0, footerIdx);

	// 8. Collapse whitespace.
	return text.replace(/\s+/g, ' ').trim();
}

/**
 * LinkedIn "application sent" cleaner — UNLIKE cleanBody, it keeps line breaks, because the LinkedIn
 * extractor reads the card by position (role / company / location on consecutive lines). It drops the
 * "similar jobs" recommendations below the card so they can't be mistaken for the applied role, then
 * strips URLs and divider runs and normalizes each line.
 */
function cleanLinkedInBody(raw: string): string {
	let text = raw;
	if (/<[a-z][\s\S]*?>/i.test(text)) text = stripHtml(text);   // malformed plain part that's actually HTML
	text = decodeEntities(text);
	// Everything from "Now, take these next steps" / "View similar jobs" on is recommendations, not this application.
	text = text.split(/Now, take these next steps|View similar jobs you may/i)[0];
	text = text.replace(/https?:\/\/\S+/g, '');                  // "View job:" links
	text = text.replace(/(?:[*\-=_~+•]\s?){4,}/g, ' ');          // divider runs ("------", glued to the date)
	return text
		.split('\n')
		.map(l => l.replace(/[ \t]+/g, ' ').trim())
		.filter(l => l && !/^view job:?$/i.test(l))
		.join('\n');
}

// Markers of an UNRENDERED email template (ERB `<% %>`, Liquid/Handlebars `{{ }}`/`{% %}`, Rails
// `I18n.t`). Some senders (e.g. HackerRank) ship the raw template as text/plain while the text/html
// part is correctly rendered — so a plain part containing these is garbage, not the real content.
const TEMPLATE_MARKERS = /<%|\{\{|\{%|\bI18n\.t\b/;

/** Prefers text/plain — unless it's an unrendered template, in which case the rendered text/html wins. */
function extractBody(part: gmail_v1.Schema$MessagePart | undefined): string {
	const plain = findPart(part, 'text/plain');
	const plainText = plain ? decodePart(plain) : null;
	if (plainText && !TEMPLATE_MARKERS.test(plainText)) return plainText;
	const html = findPart(part, 'text/html');
	if (html) return stripHtml(decodePart(html));
	return plainText ?? '';
}

/**
 * Extracts and strips the HTML part only, ignoring text/plain.
 * Used for Indeed confirmation emails where the company is only in the HTML.
 */
function extractHtmlBody(part: gmail_v1.Schema$MessagePart | undefined): string {
	const html = findPart(part, 'text/html');
	return html ? stripHtml(decodePart(html)) : '';
}

/**
 * Build the body string passed to the parser/classifier. Most mail is flattened by cleanBody, but
 * two platforms need special handling:
 *  • LinkedIn — keep the card's line structure so the LinkedIn extractor can read it by position.
 *  • Indeed   — the company is only in the HTML part ("...sent to [Company]."), not the plain text,
 *               so lift it out and prepend "Employer: [Company]" for the Indeed extractor.
 */
export function buildBody(msg: gmail_v1.Schema$Message, from: string): string {
	const part = msg.payload ?? undefined;

	if (from.includes('jobs-noreply@linkedin.com')) {
		return cleanLinkedInBody(extractBody(part)).slice(0, BODY_LIMIT);
	}

	if (from.includes('indeedapply@indeed.com')) {
		const richBody = cleanBody(extractHtmlBody(part) || extractBody(part));
		const sentTo   = richBody.match(/sent to ([^.]+)\./i);
		const prefix   = sentTo ? `Employer: ${sentTo[1].trim()}\n\n` : '';
		return prefix + richBody.slice(0, prefix ? 1000 : 3000);
	}

	return cleanBody(extractBody(part)).slice(0, BODY_LIMIT);
}
