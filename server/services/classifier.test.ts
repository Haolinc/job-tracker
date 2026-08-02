import { describe, it, expect } from 'vitest';
import { pickerContext, appearsInSource } from './classifier';

// pickerContext picks the candidate-bearing sentence(s) the source-grounded picker extracts from. It must
// surface the text that holds the CORRECT company/role so the model can re-cut a mis-glued parser span.
describe('pickerContext', () => {
	it('surfaces the sentence holding the real role when the parser glued the company onto it', () => {
		// Astronomer: the parser span was "Astronomer for the Software Engineer, Astro Core Services"; the
		// excerpt must still expose the untrimmed sentence so the model can split company from role.
		const body = 'Hello Hao, Thank you for taking the time to apply to Astronomer for the Software Engineer, Astro Core Services role. We really do appreciate your interest.';
		const excerpt = pickerContext(body, ['Astronomer for the Software Engineer, Astro Core Services', 'Astronomer']);
		expect(excerpt).toContain('apply to Astronomer for the Software Engineer, Astro Core Services role');
	});

	it('includes both the company sentence and the role sentence for a department-line email', () => {
		const body = 'Thank you for your interest in working with Peraton. Your resume will be reviewed by our Recruiting team for the following position: Entry-Level Full Stack Software Developer. A recruiter will contact you.';
		const excerpt = pickerContext(body, ['Peraton', 'Entry-Level Full Stack Software Developer']);
		expect(excerpt).toContain('Peraton');
		expect(excerpt).toContain('Entry-Level Full Stack Software Developer');
		expect(excerpt).not.toContain('A recruiter will contact you');   // unrelated sentence left out
	});

	it('caps the excerpt and falls back to the opening sentences when no candidate matches', () => {
		const body = 'Opening line one. Opening line two. ' + 'padding sentence. '.repeat(60);
		const excerpt = pickerContext(body, ['Nonexistent Candidate Span']);
		expect(excerpt.length).toBeLessThanOrEqual(500);
		expect(excerpt).toContain('Opening line one');
	});
});

// appearsInSource is the "must be exact extraction" gate: an answer is trusted only if it is verbatim in what the
// model was actually shown (the excerpt + subject), NOT the full body. This is what rejects the fabricated
// "Liberty Mutual @ icims" — the footer cruft that carried it lives outside the excerpt the model read.
describe('appearsInSource', () => {
	const excerpt = 'We appreciate your interest in Liberty Mutual Insurance.';
	const subject = 'We have received your application for Software Engineer';

	it('accepts a value that is verbatim (case/space-insensitive) in the shown text', () => {
		expect(appearsInSource('Liberty Mutual Insurance', [excerpt, subject])).toBe(true);
		expect(appearsInSource('software engineer', [excerpt, subject])).toBe(true);
	});

	it('rejects a fabricated ATS-suffixed value that is not in the shown excerpt or subject', () => {
		// The model stitched "@ icims" from the (no-longer-shown) sender; it appears nowhere in what it was given.
		expect(appearsInSource('Liberty Mutual @ icims', [excerpt, subject])).toBe(false);
	});
});
