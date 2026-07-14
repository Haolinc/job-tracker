// Builds a production-only, Electron-ABI copy of the server for packaging, under build-staging/server.
//
// Why a separate copy instead of shipping server/node_modules directly: dev's copy carries dev-only deps
// (tsx, vitest, eslint) AND a better-sqlite3 native binary compiled for SYSTEM Node's ABI. The packaged
// server runs under ELECTRON'S Node (a different ABI), which cannot load that binary. So we do a clean prod
// install here and tell better-sqlite3 to fetch its ELECTRON prebuilt — dev's server/node_modules is never
// touched, so `npm run dev` and the tests keep working against the system-Node binary.
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverSourceDir = path.join(repoRoot, 'server');
const stagingRoot = path.join(repoRoot, 'build-staging');
const stagedServerDir = path.join(stagingRoot, 'server');

// 1. Start from a clean staging directory so a stale copy never leaks into the package.
rmSync(stagingRoot, { recursive: true, force: true });
mkdirSync(stagedServerDir, { recursive: true });

// 2. Copy only what the running server needs: compiled output + the manifest/lockfile pair. Deliberately
//    NOT src/, tests, .env, sync.log, data/, or node_modules — those are dev artifacts or user data.
const compiledEntryPoint = path.join(serverSourceDir, 'dist', 'index.js');
if (!existsSync(compiledEntryPoint)) {
	throw new Error(`Compiled server not found at ${compiledEntryPoint}. Run "npm run build:server" first.`);
}
cpSync(path.join(serverSourceDir, 'dist'), path.join(stagedServerDir, 'dist'), { recursive: true });
cpSync(path.join(serverSourceDir, 'package.json'), path.join(stagedServerDir, 'package.json'));
cpSync(path.join(serverSourceDir, 'package-lock.json'), path.join(stagedServerDir, 'package-lock.json'));

// 3. Install production dependencies, pointing better-sqlite3's prebuild-install at the ELECTRON runtime so
//    it downloads the matching prebuilt .node (ABI-correct for the bundled Electron) rather than compiling
//    from source. This is why packaging needs no Visual Studio / C++ toolchain.
const electronVersion = JSON.parse(
	readFileSync(path.join(repoRoot, 'node_modules', 'electron', 'package.json'), 'utf8'),
).version;
const electronInstallEnv = {
	...process.env,
	npm_config_runtime: 'electron',
	npm_config_target: electronVersion,
	npm_config_disturl: 'https://electronjs.org/headers',
	npm_config_arch: 'x64',
};
console.log(`\n$ npm ci --omit=dev  (runtime=electron target=${electronVersion})`);
execSync('npm ci --omit=dev', { cwd: stagedServerDir, stdio: 'inherit', env: electronInstallEnv });

// 4. Fail loudly if the native binary didn't land — otherwise the failure would only surface at runtime
//    inside the packaged app as a confusing "invalid ELF/PE" style load error.
const nativeBinary = path.join(stagedServerDir, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
if (!existsSync(nativeBinary)) {
	throw new Error(`better-sqlite3 native binary missing at ${nativeBinary} — prebuild download may have failed.`);
}

console.log(`\nStaged Electron-ready server at ${stagedServerDir}`);
