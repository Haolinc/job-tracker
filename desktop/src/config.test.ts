import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfig, writeConfig } from './config';

// config.ts is the only writer of server/.env, and the panel round-trips every managed key through it. These
// cover the debug-logging checkbox's key specifically, plus the promise the module's header makes: lines it
// does not manage survive a save untouched.

let envPath: string;
let temporaryDirectory: string;

const A_FULL_CONFIG: LauncherConfig = {
	googleClientId: 'client-id',
	googleClientSecret: 'client-secret',
	googleRedirectUri: 'http://localhost:3001/api/auth/google/callback',
	sessionSecret: 'already-set',   // non-empty, so no secret is generated as a side effect
	port: '3001',
	ollamaModel: 'qwen2.5:7b',
	debugLogging: 'false',
};

beforeEach(() => {
	temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
	envPath = path.join(temporaryDirectory, '.env');
});

afterEach(() => {
	fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe('debug logging', () => {
	it('should round-trip the checkbox through DEBUG_LOG', () => {
		writeConfig(envPath, { ...A_FULL_CONFIG, debugLogging: 'true' });

		expect(fs.readFileSync(envPath, 'utf8')).toContain('DEBUG_LOG=true');
		expect(readConfig(envPath).debugLogging).toBe('true');
	});

	it('should read as off when the key has never been written', () => {
		// The upgrade path: an existing .env from before the toggle existed. Absent must mean off, or every
		// current install would silently keep writing megabytes per sync.
		fs.writeFileSync(envPath, 'PORT=3001\n');

		expect(readConfig(envPath).debugLogging).toBe('false');
	});

	it('should flip an existing key in place rather than appending a second one', () => {
		writeConfig(envPath, { ...A_FULL_CONFIG, debugLogging: 'true' });
		writeConfig(envPath, { ...A_FULL_CONFIG, debugLogging: 'false' });

		const contents = fs.readFileSync(envPath, 'utf8');
		expect(contents.match(/^DEBUG_LOG=/gm)).toHaveLength(1);
		expect(readConfig(envPath).debugLogging).toBe('false');
	});

	it('should leave unmanaged lines and comments alone', () => {
		fs.writeFileSync(envPath, '# hand-written\nLOG_TO_FILE=false\n');

		writeConfig(envPath, { ...A_FULL_CONFIG, debugLogging: 'true' });

		const contents = fs.readFileSync(envPath, 'utf8');
		expect(contents).toContain('# hand-written');
		expect(contents).toContain('LOG_TO_FILE=false');
	});
});
