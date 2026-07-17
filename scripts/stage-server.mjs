// Builds a production-only, Electron-ABI copy of the server for packaging, under build-staging/server.
//
// Two problems are solved here:
//  1. ABI — dev's better-sqlite3 native binary is compiled for SYSTEM Node, but the packaged server runs
//     under ELECTRON's Node (a different ABI). So the staged copy installs better-sqlite3 with the ELECTRON
//     prebuilt. Dev's server/node_modules is never touched — `npm run dev` and the tests keep working.
//  2. File count — updates replace the whole current/ folder, so apply time scales with how many files we
//     ship (Windows Defender scans each one as it lands), and Velopack's delta packages stay small when
//     there are few, large files instead of a node_modules tree of thousands. esbuild collapses the server
//     and all its pure-JS dependencies into a single dist/index.js; only better-sqlite3 stays a real
//     module, because a native .node binary cannot live inside a JS bundle.
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverSourceDir = path.join(repoRoot, 'server');
const stagingRoot = path.join(repoRoot, 'build-staging');
const stagedServerDir = path.join(stagingRoot, 'server');

// 1. Start from a clean staging directory so a stale copy never leaks into the package.
rmSync(stagingRoot, { recursive: true, force: true });
mkdirSync(path.join(stagedServerDir, 'dist'), { recursive: true });

// 2. Bundle the compiled server (tsc has already type-checked it) into one file. The launcher's entry-point
//    contract is unchanged: it spawns <resources>/server/dist/index.js. All writable paths (.env, database,
//    logs, client dist) arrive via environment variables, so nothing in the bundle depends on its own
//    on-disk layout.
const compiledEntryPoint = path.join(serverSourceDir, 'dist', 'index.js');
if (!existsSync(compiledEntryPoint)) {
	throw new Error(`Compiled server not found at ${compiledEntryPoint}. Run "npm run build:server" first.`);
}
buildSync({
	entryPoints: [compiledEntryPoint],
	outfile: path.join(stagedServerDir, 'dist', 'index.js'),
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'node22',   // Electron 42's bundled Node
	external: ['better-sqlite3'],
	logLevel: 'warning',
});

// 3. A minimal manifest: after bundling, the native module is the server's only real dependency.
const serverManifest = JSON.parse(readFileSync(path.join(serverSourceDir, 'package.json'), 'utf8'));
writeFileSync(
	path.join(stagedServerDir, 'package.json'),
	JSON.stringify(
		{
			name: serverManifest.name,
			version: serverManifest.version,
			private: true,
			type: 'commonjs',
			dependencies: { 'better-sqlite3': serverManifest.dependencies['better-sqlite3'] },
		},
		null,
		'\t',
	) + '\n',
);

// 4. Install better-sqlite3, pointing its prebuild-install at the ELECTRON runtime so it downloads the
//    matching prebuilt .node (ABI-correct for the bundled Electron) rather than compiling from source.
//    This is why packaging needs no Visual Studio / C++ toolchain.
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
console.log(`\n$ npm install --omit=dev  (runtime=electron target=${electronVersion})`);
execSync('npm install --omit=dev', { cwd: stagedServerDir, stdio: 'inherit', env: electronInstallEnv });

// 5. Fail loudly if the native binary didn't land — otherwise the failure would only surface at runtime
//    inside the packaged app as a confusing "invalid ELF/PE" style load error.
const nativeBinary = path.join(stagedServerDir, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
if (!existsSync(nativeBinary)) {
	throw new Error(`better-sqlite3 native binary missing at ${nativeBinary} — prebuild download may have failed.`);
}

console.log(`\nStaged Electron-ready server at ${stagedServerDir}`);
