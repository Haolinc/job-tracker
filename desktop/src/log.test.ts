import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock, MockInstance } from 'vitest';
import type { BrowserWindow } from 'electron';
import { createLog, logToTerminal } from './log';

let terminal: MockInstance<typeof console.log>;
let send: Mock<(channel: string, line: string) => void>;
let window: BrowserWindow;

/** The launcher's stdout — what the dev terminal sees. */
const terminalLines = () => terminal.mock.calls.map(([line]) => line as string);
/** What the control panel's log console receives over IPC. */
const panelLines = () => send.mock.calls.map(([, line]) => line);

beforeEach(() => {
	terminal = vi.spyOn(console, 'log').mockImplementation(() => {});
	send = vi.fn<(channel: string, line: string) => void>();
	window = { isDestroyed: () => false, webContents: { send } } as unknown as BrowserWindow;
});

afterEach(() => {
	terminal.mockRestore();
});

describe('createLog', () => {
	it('should tag a line with its source and send it to both the terminal and the panel', () => {
		createLog(() => window)('launcher', 'Starting server…');

		expect(terminalLines()).toEqual(['[launcher] Starting server…']);
		expect(panelLines()).toEqual(['[launcher] Starting server…']);
		expect(send).toHaveBeenCalledWith('launcher:log', '[launcher] Starting server…');
	});

	it('should split a multi-line chunk into one tagged line each', () => {
		createLog(() => window)('server', 'first\nsecond\r\nthird');

		expect(panelLines()).toEqual(['[server] first', '[server] second', '[server] third']);
	});

	it('should drop blank and whitespace-only lines', () => {
		createLog(() => window)('server', 'kept\n\n   \nalso kept\n');

		expect(panelLines()).toEqual(['[server] kept', '[server] also kept']);
	});

	it('should log nothing at all for an empty chunk', () => {
		createLog(() => window)('server', '');

		expect(terminalLines()).toEqual([]);
		expect(panelLines()).toEqual([]);
	});

	it('should drop a chunk that is only ANSI codes and whitespace', () => {
		createLog(() => window)('server', '\x1b[0m  \n\x1b[32m\x1b[0m\n\t');

		expect(terminalLines()).toEqual([]);
		expect(panelLines()).toEqual([]);
	});

	it('should strip ANSI colour codes that vite and tsx emit', () => {
		createLog(() => window)('server', '\x1b[32mready\x1b[0m in 300ms');

		expect(panelLines()).toEqual(['[server] ready in 300ms']);
	});

	it('should still reach the terminal when no window exists yet', () => {
		createLog(() => null)('launcher', 'Launcher ready.');

		expect(terminalLines()).toEqual(['[launcher] Launcher ready.']);
		expect(send).not.toHaveBeenCalled();
	});

	it('should not send to a window that has been destroyed', () => {
		const destroyedWindow = { isDestroyed: () => true, webContents: { send } } as unknown as BrowserWindow;
		createLog(() => destroyedWindow)('launcher', 'Server exited.');

		expect(terminalLines()).toEqual(['[launcher] Server exited.']);
		expect(send).not.toHaveBeenCalled();
	});

	it('should read the window lazily, so a window opened later still receives lines', () => {
		let currentWindow: BrowserWindow | null = null;
		const log = createLog(() => currentWindow);

		log('launcher', 'before');
		expect(send).not.toHaveBeenCalled();

		currentWindow = window;
		log('launcher', 'after');
		expect(panelLines()).toEqual(['[launcher] after']);
	});
});

describe('logToTerminal', () => {
	it('should write to the terminal only, never the panel', () => {
		logToTerminal('launcher', 'Failed to download 65465: pull model manifest: file does not exist');

		expect(terminalLines()).toEqual(['[launcher] Failed to download 65465: pull model manifest: file does not exist']);
		expect(send).not.toHaveBeenCalled();
	});

	it('should tag and split lines exactly as createLog does', () => {
		const log = createLog(() => window);
		log('launcher', '\x1b[31mone\x1b[0m\n\ntwo');
		const teed = terminalLines();

		terminal.mockClear();
		logToTerminal('launcher', '\x1b[31mone\x1b[0m\n\ntwo');

		expect(terminalLines()).toEqual(teed);
	});
});
