import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isReachable } from './health';
import { ServerManager } from './serverManager';
import type { LauncherPaths } from './paths';
import type { LogFn } from './log';
import type { OllamaService } from './ollamaService';
import type { SyncProgressEvent } from './shared';

vi.mock('node:child_process', () => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
vi.mock('node:fs', () => ({ existsSync: vi.fn(() => true) }));
vi.mock('./health', () => ({ isReachable: vi.fn() }));

/** A stand-in for the spawned server: emits on stdout/stderr and 'exit' exactly as a real ChildProcess does. */
function createFakeChild() {
	const child = new EventEmitter() as EventEmitter & {
		stdout: EventEmitter;
		stderr: EventEmitter;
		pid: number;
		kill: ReturnType<typeof vi.fn>;
	};
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.pid = 4242;
	child.kill = vi.fn();
	return child;
}

/** A promise whose settling this test controls, so we can observe start() mid-flight. */
function createGate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => { release = resolve; });
	return { promise, release };
}

const spawnMock = vi.mocked(spawn);
const spawnSyncMock = vi.mocked(spawnSync);
const isReachableMock = vi.mocked(isReachable);
const existsSyncMock = vi.mocked(existsSync);

let log: Mock<LogFn>;
let onStateChange: Mock<() => void>;
let onSyncProgress: Mock<(event: SyncProgressEvent) => void>;
let ensureRunning: Mock<() => Promise<void>>;
let paths: LauncherPaths;
let child: ReturnType<typeof createFakeChild>;

function createManager(): ServerManager {
	return new ServerManager(
		paths,
		log,
		() => 'http://localhost:3001',
		{ ensureRunning } as unknown as OllamaService,
		onStateChange,
		onSyncProgress,
	);
}

/** Start a manager and drive it to the running state — the precondition for the stdout and stop tests. */
async function startRunningManager(): Promise<ServerManager> {
	const manager = createManager();
	await manager.start();
	return manager;
}

beforeEach(() => {
	vi.clearAllMocks();
	child = createFakeChild();
	spawnMock.mockReturnValue(child as never);
	existsSyncMock.mockReturnValue(true);
	isReachableMock.mockResolvedValue(false);   // no server already on the port
	ensureRunning = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
	log = vi.fn<LogFn>();
	onStateChange = vi.fn<() => void>();
	onSyncProgress = vi.fn<(event: SyncProgressEvent) => void>();
	paths = {
		runningPackaged: false,
		serverEntryPoint: 'C:/app/server/index.js',
		serverDirectory: 'C:/app/server',
		serverEnvPath: 'C:/data/.env',
		serverDatabasePath: 'C:/data/job-tracker.db',
		serverLogsDirectory: 'C:/data/logs',
		clientDistDirectory: 'C:/app/client-dist',
	} as LauncherPaths;
});

describe('ServerManager lifecycle', () => {
	it('should report neither running nor starting before start is called', () => {
		const manager = createManager();
		expect(manager.isRunning).toBe(false);
		expect(manager.isStarting).toBe(false);
	});

	it('should be starting before the child is spawned, and running once it is', async () => {
		const ollamaGate = createGate();
		ensureRunning.mockReturnValue(ollamaGate.promise);
		const manager = createManager();

		const startPromise = manager.start();
		expect(manager.isStarting).toBe(true);
		expect(manager.isRunning).toBe(false);   // the child does not exist yet — this is the gap Start must cover
		expect(spawnMock).not.toHaveBeenCalled();

		ollamaGate.release();
		await startPromise;
		expect(manager.isStarting).toBe(false);
		expect(manager.isRunning).toBe(true);
		expect(spawnMock).toHaveBeenCalledTimes(1);
	});

	it('should not spawn a second server when start is called while a start is in flight', async () => {
		const ollamaGate = createGate();
		ensureRunning.mockReturnValue(ollamaGate.promise);
		const manager = createManager();

		const firstStart = manager.start();
		await manager.start();   // the double-click the disabled button is meant to prevent

		ollamaGate.release();
		await firstStart;
		expect(spawnMock).toHaveBeenCalledTimes(1);
	});

	it('should not spawn a second server when one is already running', async () => {
		const manager = await startRunningManager();
		await manager.start();
		expect(spawnMock).toHaveBeenCalledTimes(1);
	});

	it('should refuse to start when another server already answers on the port', async () => {
		isReachableMock.mockResolvedValue(true);
		const manager = createManager();

		await manager.start();
		expect(spawnMock).not.toHaveBeenCalled();
		expect(manager.isRunning).toBe(false);
		expect(manager.isStarting).toBe(false);
		expect(log).toHaveBeenCalledWith('launcher', expect.stringContaining('already running at http://localhost:3001'));
	});

	it('should clear the starting state when the packaged server build is missing', async () => {
		paths = { ...paths, runningPackaged: true } as LauncherPaths;
		existsSyncMock.mockReturnValue(false);
		const manager = createManager();

		await manager.start();
		expect(spawnMock).not.toHaveBeenCalled();
		expect(manager.isStarting).toBe(false);   // a failed start must re-enable the Start button
		expect(manager.isRunning).toBe(false);
	});

	it('should clear the starting state and not spawn when Ollama fails to start', async () => {
		ensureRunning.mockRejectedValue(new Error('ollama binary not found'));
		const manager = createManager();

		await expect(manager.start()).rejects.toThrow('ollama binary not found');
		expect(spawnMock).not.toHaveBeenCalled();
		expect(manager.isStarting).toBe(false);
		expect(onStateChange).toHaveBeenCalledTimes(2);   // once to disable Start, once to re-enable it
	});

	it('should start normally on a later attempt once the port is free', async () => {
		isReachableMock.mockResolvedValueOnce(true);   // an external server answers during the first start only
		const manager = createManager();

		await manager.start();
		expect(spawnMock).not.toHaveBeenCalled();

		await manager.start();
		expect(spawnMock).toHaveBeenCalledTimes(1);
		expect(manager.isRunning).toBe(true);
	});

	it('should clear the starting state when spawning throws', async () => {
		spawnMock.mockImplementation(() => { throw new Error('spawn failed'); });
		const manager = createManager();

		await expect(manager.start()).rejects.toThrow('spawn failed');
		expect(manager.isStarting).toBe(false);
		expect(manager.isRunning).toBe(false);
	});

	it('should report an unexpected stop when the child exits nonzero without a stop request', async () => {
		await startRunningManager();

		child.emit('exit', 1);
		expect(log).toHaveBeenCalledWith('launcher', expect.stringContaining('Server stopped unexpectedly (exit code 1)'));
	});

	it('should report a plain exit when a nonzero code follows a requested stop', async () => {
		const manager = await startRunningManager();

		manager.stop();
		child.emit('exit', 1);   // taskkill /F reports a nonzero code — still a user-initiated stop, not a crash
		expect(log).not.toHaveBeenCalledWith('launcher', expect.stringContaining('unexpectedly'));
		expect(log).toHaveBeenCalledWith('launcher', 'Server exited (code 1).');
	});

	it('should report a plain exit for a clean zero exit', async () => {
		await startRunningManager();

		child.emit('exit', 0);
		expect(log).not.toHaveBeenCalledWith('launcher', expect.stringContaining('unexpectedly'));
		expect(log).toHaveBeenCalledWith('launcher', 'Server exited (code 0).');
	});

	it('should report not running and notify the panel once when the child exits', async () => {
		const manager = await startRunningManager();
		expect(manager.isRunning).toBe(true);
		onStateChange.mockClear();

		child.emit('exit', 1);
		expect(manager.isRunning).toBe(false);
		expect(onStateChange).toHaveBeenCalledTimes(1);
	});

	it('should start a new server after the previous one exited', async () => {
		const manager = await startRunningManager();
		child.emit('exit', 1);

		const secondChild = createFakeChild();
		spawnMock.mockReturnValue(secondChild as never);
		await manager.start();

		expect(spawnMock).toHaveBeenCalledTimes(2);
		expect(manager.isRunning).toBe(true);
	});

	it('should notify the panel as soon as a start begins, before the child exists', async () => {
		const ollamaGate = createGate();
		ensureRunning.mockReturnValue(ollamaGate.promise);
		const manager = createManager();

		const startPromise = manager.start();
		expect(onStateChange).toHaveBeenCalledTimes(1);   // the push that disables the Start button

		ollamaGate.release();
		await startPromise;
	});
});

describe('ServerManager.stop', () => {
	it('should do nothing when no server is running', () => {
		const manager = createManager();
		manager.stop();
		expect(spawnSyncMock).not.toHaveBeenCalled();
		expect(child.kill).not.toHaveBeenCalled();
	});

	it('should terminate the child and report it as not running', async () => {
		const manager = await startRunningManager();

		manager.stop();
		expect(manager.isRunning).toBe(false);
		// Windows tree-kills via taskkill, POSIX signals the child directly — either way, exactly one of them.
		const terminated = spawnSyncMock.mock.calls.length + child.kill.mock.calls.length;
		expect(terminated).toBe(1);
	});

	it('should still deliver buffered sync output when the child exits after stop', async () => {
		const manager = await startRunningManager();
		child.stdout.emit('data', Buffer.from('@sync-progress@ {"phase":"progress","processed":7}'));   // killed mid-line

		manager.stop();
		child.emit('exit', null);   // the kill triggers the real exit event shortly after stop() returns

		expect(onSyncProgress).toHaveBeenCalledWith({ phase: 'progress', processed: 7 });
		expect(manager.isRunning).toBe(false);
	});
});

describe('ServerManager stdout parsing', () => {
	const emitStdout = (text: string) => child.stdout.emit('data', Buffer.from(text));

	it('should emit a sync-progress event for a marker line', async () => {
		await startRunningManager();

		emitStdout('@sync-progress@ {"phase":"start","total":12}\n');
		expect(onSyncProgress).toHaveBeenCalledTimes(1);
		expect(onSyncProgress).toHaveBeenCalledWith({ phase: 'start', total: 12 } satisfies SyncProgressEvent);
	});

	it('should parse a marker line that arrives with a Windows CRLF ending', async () => {
		await startRunningManager();

		// The splitter only splits on \n, so the \r stays attached to the JSON — JSON.parse must tolerate it.
		emitStdout('@sync-progress@ {"phase":"done","added":2}\r\n');
		expect(onSyncProgress).toHaveBeenCalledWith({ phase: 'done', added: 2 });
	});

	it('should log stderr output as server output', async () => {
		await startRunningManager();

		child.stderr.emit('data', Buffer.from('warning: something odd\n'));
		expect(log).toHaveBeenCalledWith('server', 'warning: something odd\n');
	});

	it('should reassemble a marker line split across chunks', async () => {
		await startRunningManager();

		emitStdout('@sync-progress@ {"phase":"pro');
		expect(onSyncProgress).not.toHaveBeenCalled();

		emitStdout('gress","processed":3}\n');
		expect(onSyncProgress).toHaveBeenCalledTimes(1);
		expect(onSyncProgress).toHaveBeenCalledWith({ phase: 'progress', processed: 3 });
	});

	it('should handle several lines arriving in one chunk', async () => {
		await startRunningManager();

		emitStdout('@sync-progress@ {"phase":"warming"}\nServer running\n@sync-progress@ {"phase":"done"}\n');
		expect(onSyncProgress).toHaveBeenCalledTimes(2);
		expect(log).toHaveBeenCalledWith('server', 'Server running');
	});

	it('should drop a malformed marker line without throwing or logging it', async () => {
		await startRunningManager();

		expect(() => emitStdout('@sync-progress@ {not json\n')).not.toThrow();
		expect(onSyncProgress).not.toHaveBeenCalled();
		expect(log).not.toHaveBeenCalledWith('server', expect.stringContaining('not json'));
	});

	it('should drop a marker whose payload is valid JSON but not a progress event', async () => {
		await startRunningManager();

		emitStdout('@sync-progress@ 42\n');
		emitStdout('@sync-progress@ null\n');
		emitStdout('@sync-progress@ {"status":"ok"}\n');   // an object, but no phase
		expect(onSyncProgress).not.toHaveBeenCalled();
	});

	it('should drop a marker line with no payload without throwing', async () => {
		await startRunningManager();

		expect(() => emitStdout('@sync-progress@\n')).not.toThrow();
		expect(onSyncProgress).not.toHaveBeenCalled();
	});

	it('should treat a marker appearing mid-line as ordinary server output', async () => {
		await startRunningManager();

		// Only lines STARTING with the marker are protocol — the same text quoted inside a log line is not.
		emitStdout('note: @sync-progress@ {"phase":"done"} is the marker format\n');
		expect(onSyncProgress).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledWith('server', 'note: @sync-progress@ {"phase":"done"} is the marker format');
	});

	it('should log a non-marker line to the panel', async () => {
		await startRunningManager();

		emitStdout('Server running on http://localhost:3001\n');
		expect(log).toHaveBeenCalledWith('server', 'Server running on http://localhost:3001');
		expect(onSyncProgress).not.toHaveBeenCalled();
	});

	it('should hold an unterminated line until its newline arrives', async () => {
		await startRunningManager();

		emitStdout('Server running');
		expect(log).not.toHaveBeenCalledWith('server', 'Server running');
	});

	it('should flush a buffered partial line when the child exits', async () => {
		await startRunningManager();

		emitStdout('@sync-progress@ {"phase":"done","added":4}');   // no trailing newline — the server was killed
		expect(onSyncProgress).not.toHaveBeenCalled();

		child.emit('exit', null);
		expect(onSyncProgress).toHaveBeenCalledWith({ phase: 'done', added: 4 });
	});
});

describe('ServerManager spawn environment', () => {
	/** The options bag is always spawn's last argument, whichever platform-specific spawn form was used. */
	const spawnEnvironment = () =>
		(spawnMock.mock.calls[0].at(-1) as { env: Record<string, string | undefined> }).env;

	it('should hand the dev server the launcher pid so it can self-exit if the launcher is force-killed', async () => {
		await startRunningManager();

		expect(spawnEnvironment().LAUNCHER_PID).toBe(String(process.pid));
		expect(spawnEnvironment().CLIENT_URL).toBe('http://localhost:3001');
	});

	it("should run the packaged server under Electron's bundled Node, pointed at the writable app-data locations", async () => {
		paths = { ...paths, runningPackaged: true };
		await startRunningManager();

		expect(spawnMock).toHaveBeenCalledWith(process.execPath, [paths.serverEntryPoint], expect.anything());
		expect(spawnEnvironment()).toMatchObject({
			ELECTRON_RUN_AS_NODE: '1',
			LAUNCHER_PID: String(process.pid),
			CLIENT_URL: 'http://localhost:3001',
			ENV_FILE: paths.serverEnvPath,
			DB_PATH: paths.serverDatabasePath,
			LOG_DIR: paths.serverLogsDirectory,
			CLIENT_DIST: paths.clientDistDirectory,
		});
	});
});
