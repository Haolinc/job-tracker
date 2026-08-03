// Config panel backend: reads and writes the managed keys in server/.env. Pure Node (no Electron imports)
// so it can be exercised standalone. Unknown lines and comments in the file are always preserved — the
// launcher only ever touches the keys it manages.

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export const DEFAULT_PORT = '3001';

// LauncherConfig (the server/.env values the panel reads and writes) is an ambient global declared in
// launcher-globals.d.ts, so the classic control-panel script sees the same shape this module reads/writes.

const ENV_KEYS_BY_CONFIG_FIELD: Record<keyof LauncherConfig, string> = {
	googleClientId: 'GOOGLE_CLIENT_ID',
	googleClientSecret: 'GOOGLE_CLIENT_SECRET',
	googleRedirectUri: 'GOOGLE_REDIRECT_URI',
	sessionSecret: 'SESSION_SECRET',
	port: 'PORT',
	ollamaModel: 'OLLAMA_MODEL',
	debugLogging: 'DEBUG_LOG',
};

const CONFIG_FIELDS = Object.keys(ENV_KEYS_BY_CONFIG_FIELD) as (keyof LauncherConfig)[];

const DEFAULT_CONFIG_VALUES: Record<keyof LauncherConfig, string> = {
	googleClientId: '',
	googleClientSecret: '',
	googleRedirectUri: `http://localhost:${DEFAULT_PORT}/api/auth/google/callback`,
	sessionSecret: '',
	port: DEFAULT_PORT,
	ollamaModel: '',
	debugLogging: 'false',
};

export function readEnvFile(envPath: string): Map<string, string> {
	const values = new Map<string, string>();
	if (!existsSync(envPath)) return values;
	for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
		const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
		if (match) values.set(match[1], match[2]);
	}
	return values;
}

export function readConfig(envPath: string): LauncherConfig {
	const envValues = readEnvFile(envPath);
	const config = {} as LauncherConfig;
	for (const configField of CONFIG_FIELDS) {
		config[configField] = envValues.get(ENV_KEYS_BY_CONFIG_FIELD[configField]) ?? DEFAULT_CONFIG_VALUES[configField];
	}
	return config;
}

/**
 * Update the managed keys in the .env file IN PLACE — existing unknown lines and comments survive, missing
 * keys are appended. An empty session secret is replaced with a generated one (reported via the return so
 * the caller can log it).
 */
export function writeConfig(envPath: string, config: LauncherConfig): { generatedSessionSecret: boolean } {
	const generatedSessionSecret = !config.sessionSecret;
	const configToWrite: LauncherConfig = generatedSessionSecret
		? { ...config, sessionSecret: randomBytes(32).toString('hex') }
		: config;

	let updatedContent = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
	for (const configField of CONFIG_FIELDS) {
		updatedContent = upsertAssignment(updatedContent, ENV_KEYS_BY_CONFIG_FIELD[configField], configToWrite[configField]);
	}
	writeFileSync(envPath, updatedContent);
	return { generatedSessionSecret };
}

/**
 * Persist a single managed key in place, leaving every other line (and the session secret) untouched. Used to
 * adopt an auto-selected model without the full-save side effects (e.g. generating a session secret).
 */
export function updateConfigValue(envPath: string, field: keyof LauncherConfig, value: string): void {
	const content = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
	writeFileSync(envPath, upsertAssignment(content, ENV_KEYS_BY_CONFIG_FIELD[field], value));
}

/** Set `ENVKEY=value` in `content`: replace the existing line in place, or append a new one if the key is absent. */
function upsertAssignment(content: string, envKey: string, value: string): string {
	const assignment = `${envKey}=${value}`;
	const keyLinePattern = new RegExp(`^\\s*${envKey}\\s*=.*$`, 'm');
	// Replacer FUNCTION, not the string: a literal `$&`/`$'` in a pasted secret must not trigger
	// String.replace's substitution patterns and corrupt the file.
	return keyLinePattern.test(content)
		? content.replace(keyLinePattern, () => assignment)
		: appendAssignmentLine(content, assignment);
}

/** Append on a fresh line; an empty/new file gets no leading blank line. */
function appendAssignmentLine(content: string, assignment: string): string {
	return content.trim() ? `${content.trimEnd()}\n${assignment}\n` : `${assignment}\n`;
}
