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

// Block-level / line-break tags whose boundaries are actual line breaks in the rendered email. HTML has no
// hard-wraps — the browser wraps visually — so every one of these boundaries is a real break the reader sees,
// unlike a lone newline in plain text. We turn them into a blank-line paragraph break (not a space) so the
// downstream whitespace collapse keeps them as "\n" boundaries, and a company name in one block can't run
// into the text of the next ("…applying to Meta" sits in its own block, ABOVE the "Hi Hao Lin" greeting, so
// it must not flatten to "applying to Meta Hi Hao Lin"). Everything else — inline tags: span, a, b, strong,
// em, font, img — is dropped to a single space so words on the same rendered line stay on it.
const HTML_BLOCK_BOUNDARY = /<\/?(?:p|div|br|hr|tr|li|ul|ol|table|blockquote|h[1-6])\b[^>]*>/gi;

function stripHtml(html: string): string {
	return html
		.replace(/<style[\s\S]*?<\/style>/gi, '')
		.replace(/<script[\s\S]*?<\/script>/gi, '')
		.replace(HTML_BLOCK_BOUNDARY, '\n\n')   // block/line-break boundary -> paragraph break (survives the collapse as a boundary)
		.replace(/<[^>]+>/g, ' ')               // remaining inline tags -> space, keeping same-line words together
		.replace(/[^\S\n]+/g, ' ')              // collapse runs of spaces/tabs, leaving newlines intact
		.replace(/ *\n */g, '\n')               // drop spaces hugging a newline
		.replace(/\n{2,}/g, '\n\n')             // cap consecutive breaks at a single blank line
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
// HTML entities + the invisible characters senders pad email with. The last three rules split those by
// what they ARE: deleting one that occupies width joins the words around it. Shared with cleanLinkedInBody.
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
		.replace(/[\u00AD\u200B-\u200F\uFEFF]/g, '')   // zero-width: renders as nothing, so leave nothing
		.replace(/\u00A0/g, ' ')                       // NBSP is a SPACE \u2014 deleting it glued "Inc..Unfortunately"
		.replace(/[\u2028\u2029]/g, '\n');             // line/paragraph separators are breaks, not spacers
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

	// 8. Collapse whitespace, KEEPING paragraph breaks as boundaries.
	return collapseWhitespaceKeepingParagraphs(text);
}

/**
 * Collapse whitespace but preserve a paragraph break as a single "\n" boundary. Plain-text senders separate
 * paragraphs with a blank line — the reliable boundary between "…at the MTA" and the "Dear Hao Lin" greeting —
 * but ALSO hard-wrap long sentences with a lone newline ("We have\nreceived your application"). The old
 * blanket `\s+ -> " "` erased the paragraph boundary, so a company capture ran straight through the greeting
 * ("MTA Dear Hao Lin Thank"); keeping EVERY newline would instead split hard-wrapped sentences. So: a
 * blank-line paragraph break becomes one "\n" (which the parser's `[^.!?\n]` patterns stop at), while a lone
 * hard-wrap newline collapses to a space. HTML bodies have no newlines by this point, so they are unaffected.
 */
function collapseWhitespaceKeepingParagraphs(text: string): string {
	const PARAGRAPH_BOUNDARY = String.fromCharCode(1);   // transient SOH sentinel; never occurs in email text
	return text
		.replace(/\r\n?/g, '\n')                           // normalize CRLF / lone CR to LF
		.replace(/[^\S\n]+/g, ' ')                         // collapse runs of spaces/tabs, leave newlines
		.replace(/ *\n[ \t]*\n\s*/g, PARAGRAPH_BOUNDARY)   // blank-line paragraph break -> boundary marker
		.replace(/ *\n */g, ' ')                           // remaining lone (hard-wrap) newline -> space
		.split(PARAGRAPH_BOUNDARY).join('\n')              // marker -> single boundary newline
		.trim();
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
		.map(line => line.replace(/[ \t]+/g, ' ').trim())
		.filter(line => line && !/^view job:?$/i.test(line))
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
		// Indeed writes "The following items were sent to [Company]. Good luck!" — read the name between the
		// template's own words so a period inside it survives ("BuildingReports.com", "Epic Kids Inc.").
		// Bounding one side only failed both ways: [^.]+ cut at the first period, line-end swallowed the tail.
		// No match means no Employer line, so parseIndeed bails to the LLM rather than invent a company.
		const employer = richBody.match(/sent to (.+?)\.\s*Good luck!/i)?.[1]?.trim();
		const prefix   = employer ? `Employer: ${employer}\n\n` : '';
		return prefix + richBody.slice(0, prefix ? 1000 : 3000);
	}

	return cleanBody(extractBody(part)).slice(0, BODY_LIMIT);
}
