// The packaging gate. Where `node scripts/build.ts --check` validates the
// source tree, this validates the artefacts a browser would actually install:
// every entry in dist/*.zip must inflate with a matching CRC, the archive must
// be exactly the built tree, and the manifest must be the flavour that target
// expects. Meant for CI and for the release job, run after a build.
//
//   node scripts/verify-package.ts            # both targets
//   node scripts/verify-package.ts chrome     # one target
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildZip, listZip, readZipEntry, type ZipEntry } from './zip.ts';
import { ENTRIES, GECKO_ID, GECKO_MIN_VERSION, TARGETS, archiveName } from './package-spec.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');

type Manifest = {
  manifest_version?: number;
  name?: string;
  version?: string;
  default_locale?: string;
  minimum_chrome_version?: string;
  background?: { service_worker?: string; scripts?: string[] };
  icons?: Record<string, string>;
  action?: { default_popup?: string };
  options_ui?: { page?: string };
  permissions?: string[];
  host_permissions?: string[];
  browser_specific_settings?: { gecko?: { id?: string; strict_min_version?: string } };
  [key: string]: unknown;
};

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { name: string; version: string };
const source = JSON.parse(readFileSync(join(ROOT, 'src', 'manifest.json'), 'utf8')) as Manifest;

const problems: string[] = [];
const fail = (condition: unknown, message: string): boolean => {
  if (!condition) problems.push(message);
  return Boolean(condition);
};

const text = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const walk = (dir: string, prefix = ''): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(join(dir, entry.name), `${prefix}${entry.name}/`)
      : [`${prefix}${entry.name}`]
  );

function checkEntries(target: string, bundle: Buffer, tree: string[]): string[] {
  const listing = listZip(bundle);
  const names = listing.map((entry) => entry.name);

  fail(
    names.every((name) => name.length > 0 && !name.startsWith('/') && !name.endsWith('/') && !name.split('/').includes('..')),
    `${target}: the archive holds an absolute, directory or escaping entry name`
  );
  fail([...names].sort().join('\n') === names.join('\n'), `${target}: the archive entries are not sorted`);
  fail(
    names.every((name) => !name.endsWith('.ts') && !name.endsWith('.map') && !name.endsWith('.mts')),
    `${target}: the archive ships TypeScript sources or source maps`
  );
  for (const required of ENTRIES) {
    fail(names.includes(required), `${target}: the archive is missing ${required}`);
  }
  fail(names.join('\n') === [...tree].sort().join('\n'), `${target}: the archive is not exactly build/${target} (${names.length} entries vs ${tree.length})`);

  // readZipEntry inflates and compares the stored CRC, so anything corrupt or
  // mismatched throws instead of silently shipping.
  for (const name of names) {
    try {
      fail(readZipEntry(bundle, name) !== undefined, `${target}: ${name} cannot be read back`);
    } catch (error) {
      problems.push(`${target}: ${name}: ${text(error)}`);
    }
  }

  // Repacking the same tree must reproduce the archive byte for byte: that is
  // what makes a rebuilt artefact comparable to a published one.
  const entries: ZipEntry[] = tree.map((name) => ({ name, data: readFileSync(join(ROOT, 'build', target, name)) }));
  fail(buildZip(entries).equals(bundle), `${target}: repacking build/${target} does not reproduce the archive`);

  return names;
}

function checkManifest(target: string, bundle: Buffer, names: string[]): void {
  const zipped = readZipEntry(bundle, 'manifest.json');
  if (!fail(zipped !== undefined, `${target}: manifest.json is missing`)) return;

  const manifest = JSON.parse(String(zipped?.toString('utf8'))) as Manifest;
  fail(manifest.manifest_version === 3, `${target}: manifest_version must be 3`);
  fail(manifest.version === pkg.version, `${target}: manifest version ${manifest.version} != package.json ${pkg.version}`);
  fail(manifest.name === source.name, `${target}: manifest name drifted from src/manifest.json`);
  fail(manifest.background?.service_worker === 'background.js', `${target}: background.service_worker must be background.js`);
  fail(manifest.background?.scripts?.at(-1) === 'background.js', `${target}: background.scripts must end with background.js`);
  fail(Array.isArray(manifest.host_permissions) && manifest.host_permissions.length > 0, `${target}: host_permissions must be declared`);
  fail(!('content_scripts' in manifest), `${target}: content scripts are injected on demand, never declared`);
  // The manifest may only constrain the extension's own pages, and those must
  // not need eval/inline scripts: the shipped code is plain classic scripts.
  const policies = (manifest.content_security_policy ?? {}) as Record<string, unknown>;
  fail(
    Object.keys(policies).every((key) => key === 'extension_pages'),
    `${target}: only an extension_pages content security policy may be declared`
  );
  const extensionPages = String(policies.extension_pages ?? '');
  // 'wasm-unsafe-eval' is the one exception the on-device host needs: WebAssembly
  // compilation is not eval, so an unquoted substring match would reject it.
  fail(
    extensionPages.includes("script-src 'self'") &&
      extensionPages.includes("'wasm-unsafe-eval'") &&
      !extensionPages.includes("'unsafe-eval'") &&
      !extensionPages.includes("'unsafe-inline'"),
    `${target}: extension_pages must keep script-src 'self' plus 'wasm-unsafe-eval' without 'unsafe-eval' or 'unsafe-inline'`
  );

  for (const permission of ['storage', 'scripting', 'contextMenus']) {
    fail(manifest.permissions?.includes(permission), `${target}: missing permission ${permission}`);
  }
  // Only Chrome has chrome.offscreen; the firefox build must not ask for it.
  fail(
    (manifest.permissions ?? []).includes('offscreen') === (target === 'chrome'),
    `${target}: the offscreen permission must be present for chrome and absent for firefox`
  );

  const locale = manifest.default_locale ?? '';
  fail(names.includes(`_locales/${locale}/messages.json`), `${target}: _locales/${locale}/messages.json is not in the archive`);
  for (const [size, path] of Object.entries(manifest.icons ?? {})) {
    fail(names.includes(String(path)), `${target}: icon ${size} -> ${path} is not in the archive`);
  }
  const popup = manifest.action?.default_popup ?? '';
  fail(names.includes(popup), `${target}: action.default_popup ${popup} is not in the archive`);
  const options = manifest.options_ui?.page ?? '';
  fail(names.includes(options), `${target}: options_ui.page ${options} is not in the archive`);

  if (target === 'firefox') {
    fail(manifest.browser_specific_settings?.gecko?.id === GECKO_ID, `${target}: gecko id must be ${GECKO_ID}`);
    fail(
      manifest.browser_specific_settings?.gecko?.strict_min_version === GECKO_MIN_VERSION,
      `${target}: gecko strict_min_version must be ${GECKO_MIN_VERSION}`
    );
    fail(!('minimum_chrome_version' in manifest), `${target}: minimum_chrome_version must be stripped`);
  } else {
    fail(!('browser_specific_settings' in manifest), `${target}: browser_specific_settings must not be present`);
    fail(
      manifest.minimum_chrome_version === source.minimum_chrome_version && typeof manifest.minimum_chrome_version === 'string',
      `${target}: minimum_chrome_version must be kept as in src/manifest.json`
    );
  }
}

function check(target: string): void {
  const file = join(DIST, archiveName(pkg, target));
  if (!existsSync(file)) {
    problems.push(`${target}: dist/${archiveName(pkg, target)} is missing (run \`npm run build\` first)`);
    return;
  }
  const bundle = readFileSync(file);
  const treeDir = join(ROOT, 'build', target);
  if (!fail(existsSync(treeDir), `${target}: build/${target} is missing, cannot compare the archive`)) return;

  const names = checkEntries(target, bundle, walk(treeDir));
  checkManifest(target, bundle, names);
  console.log(`verified ${target}: ${archiveName(pkg, target)} (${names.length} files, ${Math.round(bundle.length / 1024)} KB)`);
}

const requested = [...new Set(process.argv.slice(2))];
for (const target of requested) {
  if (!TARGETS.includes(target)) {
    console.error(`usage: node scripts/verify-package.ts [${TARGETS.join('|')}]`);
    console.error(`unknown target: ${target}`);
    process.exit(1);
  }
}
const targets = requested.length > 0 ? requested : TARGETS;
for (const target of targets) check(target);

if (problems.length > 0) {
  console.error(`packaging gate failed with ${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`packaging gate passed for ${targets.join(', ')}`);
