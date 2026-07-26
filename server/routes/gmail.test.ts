import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import gmailRouter, { mapAhead, classifyOne } from './gmail';
import { classifyEmail, pickCompanyRole } from '../services/classifier';
import { parseEmail } from '../services/parser/templates';
import { setSyncRunning, setImportRunning, setLastSyncEvent, isSyncCancelRequested, clearSyncCancel } from '../services/syncState';
import type { EmailResult } from '../types';

// classifyOne's LLM path is under test — force every fixture past the hard filter so the mocked
// classifier and parser are the only variables. parseEmail defaults to null (no deterministic hit).
vi.mock('../services/classifier', () => ({
	classifyEmail: vi.fn(),
	warmUpModel: vi.fn(),
	pickCompanyRole: vi.fn(),
}));
vi.mock('../services/filters', () => ({
	isIgnorableEmail: () => false,
}));
vi.mock('../services/parser/templates', () => ({
	parseEmail: vi.fn(() => null),
}));

const classifyEmailMock = vi.mocked(classifyEmail);
const pickCompanyRoleMock = vi.mocked(pickCompanyRole);
const parseEmailMock = vi.mocked(parseEmail);

async function* range(n: number): AsyncGenerator<number> {
	for (let i = 0; i < n; i++) yield i;
}

describe('classifyOne', () => {
	const email: EmailResult = {
		threadId: 'thread-1',
		messageId: 'message-1',
		subject: 'Your application to Acme',
		from: 'careers@acme.com',
		body: 'Thanks for applying to Acme as a Software Engineer.',
		lastMessageDate: '2026-07-10',
		internalDate: 1_780_000_000_000,
	};

	beforeEach(() => {
		classifyEmailMock.mockReset();
		pickCompanyRoleMock.mockReset();
		parseEmailMock.mockReset();
		parseEmailMock.mockReturnValue(null);   // default: no deterministic hit, so the LLM path runs
	});

	it('should report a classifier failure as failed, never as an ignored skip', async () => {
		classifyEmailMock.mockRejectedValue(new Error('Ollama is not running'));
		const result = await classifyOne(email);
		// A 'skip' here would mark the email synced-as-ignored PERMANENTLY — it would never be
		// classified again even after Ollama recovers, while the sync still reports success.
		expect(result.kind).toBe('failed');
	});

	it('should return a merge result when the classifier succeeds', async () => {
		classifyEmailMock.mockResolvedValue({ category: 'applied', company: 'Acme', role: 'Software Engineer' });
		const result = await classifyOne(email);
		expect(result).toMatchObject({ kind: 'merge', company: 'Acme', category: 'applied', detectedBy: 'llm' });
	});

	it('should skip as ignored when the classifier deliberately ignores the email', async () => {
		classifyEmailMock.mockResolvedValue({ category: 'ignored', company: null, role: null });
		const result = await classifyOne(email);
		expect(result).toMatchObject({ kind: 'skip', classifiedAs: 'ignored' });
	});

	// The parser can capture a noun phrase without knowing whether it names a company or a job title
	// ("your interest in X"), so it emits the candidates untyped. These cover how they get resolved: a lone
	// span goes to the full classifier; ≥2 spans go to the cheap picker, which types them or declines.
	describe('when the parser could not type its spans', () => {
		// What the general template emits for "…applying to Acme … the Software Engineer position": two
		// candidates, but which is the company is only a guess because "applying to X" doesn't say what X is.
		const twoSpanParse = {
			category: 'applied' as const, company: 'Acme', role: 'Software Engineer',
			classifier_code: 'general_template', ambiguous_spans: ['Acme', 'Software Engineer'],
		};

		// What it emits for "…your interest in Software Engineer": a LONE span that is really the role, grabbed
		// as the company. Unconfirmed, this is the record that reaches the board with a bogus employer.
		const loneSpanParse = {
			category: 'applied' as const, company: 'Software Engineer', role: null,
			classifier_code: 'general_template', ambiguous_spans: ['Software Engineer'],
		};

		it('should keep the parser result and never call the LLM when the spans are typed', async () => {
			// No ambiguous_spans → the sentence structure already named both slots; nothing to confirm.
			parseEmailMock.mockReturnValue({ category: 'applied', company: 'Axoni', role: 'Software Engineer', classifier_code: 'general_template' });
			const result = await classifyOne(email);
			expect(pickCompanyRoleMock).not.toHaveBeenCalled();
			expect(classifyEmailMock).not.toHaveBeenCalled();   // the free path stays free
			expect(result).toMatchObject({ kind: 'merge', company: 'Axoni', detectedBy: 'parser' });
		});

		it('should skip the picker and defer a lone candidate to the full classifier', async () => {
			// < 2 candidates: nothing to pick between, and the lone span is really a role — the Leidos trap. Go
			// straight to the full classifier, which reads the whole email for the real employer.
			parseEmailMock.mockReturnValue(loneSpanParse);
			classifyEmailMock.mockResolvedValue({ category: 'applied', company: 'Leidos', role: 'Software Engineer' });
			const result = await classifyOne(email);
			expect(pickCompanyRoleMock).not.toHaveBeenCalled();   // no genuine choice → don't burn a picker call
			expect(classifyEmailMock).toHaveBeenCalledTimes(1);
			expect(result).toMatchObject({ kind: 'merge', company: 'Leidos', detectedBy: 'llm' });
		});

		it('should adopt the company/role the picker assigns to the candidates', async () => {
			parseEmailMock.mockReturnValue({
				category: 'applied', company: 'Axoni', role: null,
				classifier_code: 'general_template', ambiguous_spans: ['Axoni', 'Software Engineer'],
			});
			pickCompanyRoleMock.mockResolvedValue({ company: 'Axoni', role: 'Software Engineer' });
			const result = await classifyOne(email);
			expect(pickCompanyRoleMock).toHaveBeenCalledWith(['Axoni', 'Software Engineer'], email.subject, email.from);
			expect(classifyEmailMock).not.toHaveBeenCalled();   // the picker replaces the full classification
			expect(result).toMatchObject({ kind: 'merge', company: 'Axoni', role: 'Software Engineer', detectedBy: 'parser' });
		});

		it('should defer to a full classification when the picker is not confident of any employer', async () => {
			// ≥2 candidates but the picker judges none a legitimate company (e.g. both are titles). It returns
			// company:null → slide to the full classifier, which finds the real employer.
			parseEmailMock.mockReturnValue(twoSpanParse);
			pickCompanyRoleMock.mockResolvedValue({ company: null, role: 'Software Engineer' });
			classifyEmailMock.mockResolvedValue({ category: 'applied', company: 'Axoni', role: 'Software Engineer' });
			const result = await classifyOne(email);
			expect(classifyEmailMock).toHaveBeenCalledTimes(1);
			expect(result).toMatchObject({ kind: 'merge', company: 'Axoni', detectedBy: 'llm' });
		});

		it('should keep the parser guess when the picker is unavailable', async () => {
			parseEmailMock.mockReturnValue(twoSpanParse);
			pickCompanyRoleMock.mockResolvedValue(null);   // Ollama down / unparseable response
			const result = await classifyOne(email);
			// Degrades to the pre-picker behaviour rather than losing the email or burning a full call.
			expect(classifyEmailMock).not.toHaveBeenCalled();
			expect(result).toMatchObject({ kind: 'merge', company: 'Acme', role: 'Software Engineer', detectedBy: 'parser' });
		});
	});
});

describe('POST /sync concurrency guard', () => {
	let httpServer: Server;
	let baseUrl: string;

	beforeAll(async () => {
		const app = express();
		// requireAuth wants a connected session; a fake with tokens is enough — the guard under test
		// fires before any Gmail work could touch the fake tokens.
		app.use((req, _res, next) => { Object.assign(req, { session: { tokens: {} } }); next(); });
		app.use('/api/gmail', gmailRouter);
		await new Promise<void>((resolve) => { httpServer = app.listen(0, '127.0.0.1', () => resolve()); });
		baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
	});

	afterAll(async () => {
		await new Promise((resolve) => httpServer.close(resolve));
	});

	it('should reject a second sync with 409 while one is already running', async () => {
		setSyncRunning(true);
		try {
			const response = await fetch(`${baseUrl}/api/gmail/sync`, { method: 'POST' });
			expect(response.status).toBe(409);
			const body = await response.json() as { error: string };
			expect(body.error).toContain('already running');
		} finally {
			setSyncRunning(false);
		}
	});

	it('should reject a sync with 409 while a CSV import is being applied (mutual exclusion)', async () => {
		setImportRunning(true);
		try {
			const response = await fetch(`${baseUrl}/api/gmail/sync`, { method: 'POST' });
			expect(response.status).toBe(409);
			const body = await response.json() as { error: string };
			expect(body.error).toContain('CSV import');
		} finally {
			setImportRunning(false);
		}
	});
});

// The snapshot a reopened tab polls to restore its progress bar mid-sync.
describe('GET /sync/status', () => {
	let httpServer: Server;
	let baseUrl: string;

	beforeAll(async () => {
		const app = express();
		app.use((req, _res, next) => { Object.assign(req, { session: { tokens: {} } }); next(); });
		app.use('/api/gmail', gmailRouter);
		await new Promise<void>((resolve) => { httpServer = app.listen(0, '127.0.0.1', () => resolve()); });
		baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
	});

	afterAll(async () => {
		await new Promise((resolve) => httpServer.close(resolve));
		setSyncRunning(false);
		setLastSyncEvent(null);
	});

	it('reports a running sync and its latest progress event so a reconnecting tab can resume', async () => {
		setSyncRunning(true);
		setLastSyncEvent({ phase: 'progress', processed: 12, total: 40, added: 3, updated: 1, skipped: 8 });
		const response = await fetch(`${baseUrl}/api/gmail/sync/status`);
		expect(response.status).toBe(200);
		const body = await response.json() as { running: boolean; event: { phase: string; processed: number; total: number } | null };
		expect(body.running).toBe(true);
		expect(body.event).toMatchObject({ phase: 'progress', processed: 12, total: 40 });
	});

	it('reports not-running when no sync is in flight (the client then ignores any stale event)', async () => {
		setSyncRunning(false);
		setLastSyncEvent({ phase: 'done', added: 5, updated: 2, skipped: 1, failed: 0, durationMs: 1234 });
		const response = await fetch(`${baseUrl}/api/gmail/sync/status`);
		const body = await response.json() as { running: boolean; event: unknown };
		expect(body.running).toBe(false);
	});
});

// The endpoint the Cancel button hits — it only sets the cooperative cancel flag the sync loop checks.
describe('POST /sync/cancel', () => {
	let httpServer: Server;
	let baseUrl: string;

	beforeAll(async () => {
		const app = express();
		app.use((req, _res, next) => { Object.assign(req, { session: { tokens: {} } }); next(); });
		app.use('/api/gmail', gmailRouter);
		await new Promise<void>((resolve) => { httpServer = app.listen(0, '127.0.0.1', () => resolve()); });
		baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
	});

	afterAll(async () => {
		await new Promise((resolve) => httpServer.close(resolve));
		setSyncRunning(false);
		clearSyncCancel();
	});

	it('sets the cancel flag and returns cancelling:true while a sync is running', async () => {
		setSyncRunning(true);
		clearSyncCancel();
		try {
			const response = await fetch(`${baseUrl}/api/gmail/sync/cancel`, { method: 'POST' });
			expect(response.status).toBe(200);
			const body = await response.json() as { cancelling: boolean };
			expect(body.cancelling).toBe(true);
			expect(isSyncCancelRequested()).toBe(true);
		} finally {
			setSyncRunning(false);
			clearSyncCancel();
		}
	});

	it('rejects with 409 and sets no flag when no sync is running', async () => {
		setSyncRunning(false);
		clearSyncCancel();
		const response = await fetch(`${baseUrl}/api/gmail/sync/cancel`, { method: 'POST' });
		expect(response.status).toBe(409);
		expect(isSyncCancelRequested()).toBe(false);
	});
});

describe('mapAhead', () => {
	it('yields every result exactly once, in completion (not input) order', async () => {
		// Item 0 resolves slowest, the last item fastest. Order is not preserved (the consumer sorts by date
		// afterward), but every item must pass through exactly once — so a slow head can't drop or stall work.
		const fn = (i: number) => new Promise<number>(resolve => setTimeout(() => resolve(i), (10 - i) * 5));
		const out: number[] = [];
		for await (const r of mapAhead(range(10), 3, fn)) out.push(r);
		expect(out.slice().sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
		expect(out).not.toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);   // completion order differs from input order
	});

	it('never runs more than `depth` tasks concurrently', async () => {
		let active = 0, peak = 0;
		const fn = async (i: number) => {
			active++; peak = Math.max(peak, active);
			await new Promise(resolve => setTimeout(resolve, 5));
			active--; return i;
		};
		const out: number[] = [];
		for await (const r of mapAhead(range(12), 3, fn)) out.push(r);
		expect(out).toEqual([...Array(12).keys()]);
		expect(peak).toBeLessThanOrEqual(3);
	});

	it('handles a stream shorter than the window without dropping items', async () => {
		const out: number[] = [];
		for await (const r of mapAhead(range(2), 5, async (i) => i * 2)) out.push(r);
		expect(out).toEqual([0, 2]);
	});

	it('passes an empty stream through cleanly', async () => {
		const out: number[] = [];
		for await (const r of mapAhead(range(0), 3, async (i) => i)) out.push(r);
		expect(out).toEqual([]);
	});
});
