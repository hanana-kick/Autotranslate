// Compiles the TypeScript sources, builds browser-specific bundles from src/
// plus the emitted JS, validates the cross-browser invariants, and packages
// each bundle as a zip in dist/. No dependencies beyond Node and typescript.
//
//   node scripts/build.ts                  # both targets
//   node scripts/build.ts --target=firefox # one target
//   node scripts/build.ts --check          # validate only, write nothing
//   node scripts/build.ts --watch          # rebuild on change
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, watch, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildZip, type ZipEntry } from './zip.ts';
import { GECKO_ID, GECKO_MIN_VERSION, RUNTIME_ENTRIES, archiveName, stripComments } from './package-spec.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');
const BUILD = join(ROOT, 'build');
const COMPILED = join(BUILD, 'ts', 'src');
const DIST = join(ROOT, 'dist');
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const POLYFILL = join(ROOT, 'node_modules', 'webextension-polyfill', 'dist', 'browser-polyfill.js');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GENAI = join(ROOT, 'node_modules', '@mediapipe', 'tasks-genai');
const GENAI_WASM = [
  'genai_wasm_internal.js',
  'genai_wasm_internal.wasm',
  'genai_wasm_nosimd_internal.js',
  'genai_wasm_nosimd_internal.wasm'
];
/**
 * The on-device runtime is an installed devDependency, not a checked-in
 * artefact, exactly like the polyfill. The ESM bundle is shipped with a `.js`
 * name so the browser serves it as a script the classic offscreen page can
 * `import()`; the `_module_` wasm variants are skipped because the loader only
 * ever asks for the simd or nosimd pair.
 */
const VENDOR_FILES: { from: string; to: string }[] = [
  { from: 'genai_bundle.mjs', to: 'vendor/mediapipe/genai_bundle.js' },
  ...GENAI_WASM.map((file) => ({ from: `wasm/${file}`, to: `vendor/mediapipe/wasm/${file}` }))
];
// 'offscreen' hosts the on-device model; Firefox has no such API and the
// firefox target strips it, so it never ships in that bundle.
const PERMISSIONS = ['storage', 'scripting', 'contextMenus', 'activeTab', 'tabs', 'offscreen', 'sidePanel'];
type Manifest = {
  manifest_version?: number;
  name?: string;
  version?: string;
  default_locale?: string;
  minimum_chrome_version?: string;
  background?: { service_worker?: string; scripts?: string[] };
  icons?: Record<string, string>;
  action?: { default_icon?: Record<string, string>; default_popup?: string };
  options_ui?: { page?: string };
  permissions?: string[];
  /** Chrome only: the page docked to the side of the window. */
  side_panel?: { default_path?: string };
  browser_specific_settings?: { gecko?: { id?: string; strict_min_version?: string } };
};

type I18nEntry = { message?: string; placeholders?: Record<string, { content?: string }> };
type Catalogue = Record<string, I18nEntry>;
type Exists = (file: string) => boolean;

type Target = { manifest: (manifest: Manifest) => Manifest };

const TARGETS: Record<string, Target> = {
  chrome: {
    manifest(manifest) {
      delete manifest.browser_specific_settings;
      return manifest;
    }
  },
  firefox: {
    manifest(manifest) {
      delete manifest.minimum_chrome_version;
      // No chrome.offscreen in Firefox: the host runs in the background page,
      // so the permission would be a request for an API that does not exist.
      manifest.permissions = (manifest.permissions ?? []).filter(
        (permission) => permission !== 'offscreen' && permission !== 'sidePanel'
      );
      // `side_panel` is a Chrome key; Firefox has `sidebar_action`, which this
      // extension does not ship (the onboarding page opens in a tab there).
      delete manifest.side_panel;
      manifest.browser_specific_settings = {
        gecko: { id: GECKO_ID, strict_min_version: GECKO_MIN_VERSION }
      };
      return manifest;
    }
  }
};

class Check {
  problems: string[] = [];
  notes: string[] = [];

  fail(condition: unknown, message: string): boolean {
    if (!condition) this.problems.push(message);
    return Boolean(condition);
  }

  note(message: string): void {
    this.notes.push(message);
  }
}

function walk(dir: string, filter: (path: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(path, filter));
    else if (filter(path)) found.push(path);
  }
  return found;
}

const read = (path: string): string => readFileSync(path, 'utf8');
const matches = (source: string, pattern: RegExp): string[] =>
  [...source.matchAll(pattern)].map((match) => match[1] ?? '');

function listedFiles(source: string, marker: RegExp): string[] {
  const block = marker.exec(source)?.[1] ?? '';
  return matches(block, /'([^']+)'/g);
}

/** Runs the compiler; `emit: false` turns it into the project's type check. */
function tsc(project: string, emit: boolean): string | null {
  const args = ['-p', join(ROOT, project)];
  if (!emit) args.push('--noEmit');
  const result = spawnSync(process.execPath, [TSC, ...args], { cwd: ROOT, encoding: 'utf8' });
  if (result.status === 0) return null;
  return (result.stderr || result.stdout || `tsc exited with ${String(result.status)}`).trim();
}

function checkManifest(check: Check, manifest: Manifest, exists: Exists): void {
  check.fail(manifest.manifest_version === 3, 'manifest: manifest_version must be 3');
  check.fail(typeof manifest.version === 'string', 'manifest: version is required');
  check.fail(manifest.default_locale === 'en', 'manifest: default_locale must be en');
  check.fail(
    manifest.background?.service_worker === 'background.js',
    'manifest: background.service_worker must be background.js'
  );
  const scripts = manifest.background?.scripts;
  check.fail(Array.isArray(scripts) && scripts.length > 0, 'manifest: background.scripts must be a list');
  check.fail(
    scripts?.at(-1) === manifest.background?.service_worker,
    'manifest: background.scripts must end with the service worker entry'
  );
  const referenced: string[] = [
    ...(scripts ?? []),
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action?.default_icon ?? {}),
    manifest.action?.default_popup ?? '',
    manifest.options_ui?.page ?? '',
    manifest.side_panel?.default_path ?? ''
  ].filter(Boolean);
  for (const file of referenced) {
    check.fail(exists(file), `manifest: referenced file is missing: ${file}`);
  }
  for (const permission of manifest.permissions ?? []) {
    check.fail(PERMISSIONS.includes(permission), `manifest: unexpected permission ${permission}`);
  }
  // The host page is opened by URL through chrome.offscreen, so nothing in the
  // manifest lists it and the referenced-file loop above cannot see it.
  for (const file of ['offscreen.html', 'offscreen.js']) {
    check.fail(exists(file), `manifest: the on-device host needs ${file}`);
  }
}

/**
 * background.ts must importScripts exactly the manifest's background.scripts,
 * and must list the files it injects. Checked against the compiled output when
 * it exists, because that is what the browser runs.
 */
function checkSourcePairing(check: Check, manifest: Manifest): string[] {
  const candidates = [join(COMPILED, 'background.js'), join(SRC, 'background.ts')];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    check.fail(false, 'background: neither background.ts nor its compiled output exists');
    return [];
  }
  const source = read(found);
  const importScripts = listedFiles(source, /importScripts\(([\s\S]*?)\)/);
  const expected = (manifest.background?.scripts ?? []).slice(0, -1);
  check.fail(
    importScripts.length > 0 && importScripts.join(',') === expected.join(','),
    `background.js: importScripts list must match background.scripts (${expected.join(', ')})`
  );
  const contentFiles = listedFiles(source, /CONTENT_FILES\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/);
  check.fail(contentFiles.length > 0, 'background.js: CONTENT_FILES must list the injectable files');
  return contentFiles;
}

function collectI18nKeys(source: string, path: string): { key: string; path: string }[] {
  const keys = new Set<string>();
  for (const key of matches(source, /__MSG_([A-Za-z0-9_]+)__/g)) keys.add(key);
  for (const key of matches(source, /i18n\.msg\(\s*'([A-Za-z0-9_]+)'/g)) keys.add(key);
  // Context-menu titles resolve their key through the MENU table.
  for (const key of matches(source, /i18n:\s*'([A-Za-z0-9_]+)'/g)) keys.add(key);
  for (const key of matches(source, /data-i18n(?:-placeholder|-title)?="([A-Za-z0-9_]+)"/g)) keys.add(key);
  return [...keys].map((key) => ({ key, path }));
}

/**
 * The extension API is reached through `AT.api` and its surfaces; only
 * `lib/browser.ts` may name the host global, because that is the one place
 * where the standard `browser` object and Chrome's `chrome` fallback are
 * resolved. A stray `chrome.tabs…` elsewhere would bypass the polyfill and
 * break the other browser, so the validator refuses it.
 */
function checkHostSurface(check: Check): void {
  const apiCall = /\bchrome\.(runtime|tabs|storage|action|scripting|i18n|contextMenus|offscreen)\b/;
  const globalName = /\b(globalThis|window|self|global)\.(chrome|browser)\b/;
  for (const path of walk(SRC, (file) => /\.(ts|html)$/.test(file))) {
    const file = relative(SRC, path).split(sep).join('/');
    if (file === 'lib/browser.ts') continue;
    const code = stripComments(read(path));
    check.fail(
      !apiCall.test(code) && !globalName.test(code),
      `api: ${file} names the browser global; use AT.api/AT.<surface> (lib/browser.ts resolves it)`
    );
  }
}

function checkI18n(check: Check): void {
  const localeDir = join(SRC, '_locales');
  const locales = readdirSync(localeDir);
  check.fail(locales.includes('en'), 'i18n: default locale en is missing');
  const catalogues = new Map<string, Catalogue>();
  for (const locale of locales) {
    const path = join(localeDir, locale, 'messages.json');
    let parsed: Catalogue;
    try {
      parsed = JSON.parse(read(path)) as Catalogue;
    } catch (error) {
      check.fail(false, `i18n: ${locale}/messages.json is not valid JSON (${(error as Error).message})`);
      continue;
    }
    catalogues.set(locale, parsed);
    for (const [key, entry] of Object.entries(parsed)) {
      check.fail(
        typeof entry?.message === 'string' && entry.message.length > 0,
        `i18n: ${locale}.${key} has no message`
      );
      for (const placeholder of matches(entry.message ?? '', /\$(\d+)\$/g)) {
        check.fail(
          entry.placeholders?.[placeholder]?.content === `$${placeholder}`,
          `i18n: ${locale}.${key} is missing placeholder $${placeholder}`
        );
      }
    }
  }
  const used = new Map<string, string[]>();
  const sources = walk(SRC, (path) => /\.(ts|html|json)$/.test(path) && !path.includes(localeDir));
  for (const path of sources) {
    for (const { key, path: from } of collectI18nKeys(read(path), relative(ROOT, path))) {
      if (!used.has(key)) used.set(key, []);
      used.get(key)?.push(from);
    }
  }
  const en = catalogues.get('en') ?? {};
  for (const [key, from] of used) {
    for (const [locale, catalogue] of catalogues) {
      check.fail(catalogue[key], `i18n: ${key} used by ${from.join(', ')} is missing from ${locale}`);
    }
  }
  for (const key of Object.keys(en)) {
    if (!used.has(key)) check.note(`i18n: unused key ${key}`);
  }
  for (const [locale, catalogue] of catalogues) {
    if (locale === 'en') continue;
    for (const key of Object.keys(catalogue)) {
      check.fail(en[key], `i18n: ${locale} defines unknown key ${key}`);
    }
  }
}

function checkIcons(check: Check, exists: Exists): void {
  for (const size of [16, 32, 48, 128]) {
    const file = `icons/icon-${size}.png`;
    if (!exists(file)) {
      check.fail(false, `icons: ${file} is missing (run npm run icons)`);
      continue;
    }
    const head = readFileSync(join(SRC, file)).subarray(0, 8);
    check.fail(head.equals(PNG_SIGNATURE), `icons: ${file} is not a PNG`);
  }
}

function checkTypes(check: Check): void {
  const sources = tsc('tsconfig.json', false);
  if (sources) check.fail(false, `types: ${sources}`);
  const tools = tsc('tsconfig.tools.json', false);
  if (tools) check.fail(false, `types: ${tools}`);
}

function validate(): Check {
  const check = new Check();
  const pkg = JSON.parse(read(join(ROOT, 'package.json'))) as { name: string; version: string };
  const manifest = JSON.parse(read(join(SRC, 'manifest.json'))) as Manifest;
  // A referenced script may exist as the TypeScript source (validator only) or
  // as emitted JS (a build), and vendor/ comes from the installed polyfill.
  const exists: Exists = (file) =>
    existsSync(join(SRC, file)) ||
    existsSync(join(SRC, file.replace(/\.js$/, '.ts'))) ||
    existsSync(join(COMPILED, file)) ||
    (file.startsWith('vendor/') && existsSync(POLYFILL)) ||
    vendorTarget(file) !== undefined;

  /** Maps a shipped vendor path back to the installed package file. */
  function vendorTarget(file: string): string | undefined {
    const entry = VENDOR_FILES.find((candidate) => candidate.to === file);
    if (!entry) return undefined;
    return existsSync(join(GENAI, entry.from)) ? join(GENAI, entry.from) : undefined;
  }

  check.fail(
    manifest.version === pkg.version,
    `manifest: version ${String(manifest.version)} must match package.json ${pkg.version}`
  );
  check.fail(existsSync(POLYFILL), 'vendor: webextension-polyfill is not installed (run npm install)');
  check.fail(
    existsSync(join(GENAI, 'genai_bundle.mjs')),
    'vendor: @mediapipe/tasks-genai is not installed (run npm install)'
  );
  for (const entry of VENDOR_FILES) {
    check.fail(existsSync(join(GENAI, entry.from)), `vendor: ${entry.from} is missing from @mediapipe/tasks-genai`);
  }
  // What the build copies and what the packaging gate demands are one list; a
  // new wasm variant has to appear in both at once.
  check.fail(
    VENDOR_FILES.map((entry) => entry.to).join('\n') === RUNTIME_ENTRIES.join('\n'),
    'vendor: the runtime the build copies drifted from the packaging contract'
  );
  checkManifest(check, manifest, exists);
  for (const file of checkSourcePairing(check, manifest)) {
    check.fail(exists(file), `injection: content file is missing: ${file}`);
  }
  for (const target of Object.keys(TARGETS)) {
    const transformed = TARGETS[target]?.manifest(structuredClone(manifest)) ?? {};
    if (target === 'firefox') {
      check.fail(
        transformed.browser_specific_settings?.gecko?.id === GECKO_ID,
        'firefox: browser_specific_settings.gecko.id must be set'
      );
      check.fail(!('minimum_chrome_version' in transformed), 'firefox: minimum_chrome_version must be stripped');
    } else {
      check.fail(!('browser_specific_settings' in transformed), 'chrome: browser_specific_settings must not be shipped');
    }
  }
  checkI18n(check);
  checkHostSurface(check);
  checkIcons(check, exists);
  checkTypes(check);
  return check;
}

function compile(): string | null {
  if (!existsSync(TSC)) return 'typescript is not installed (run npm install)';
  return tsc('tsconfig.json', true);
}

function copyTree(from: string, to: string, filter: (path: string) => boolean = () => true): void {
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(target, { recursive: true });
      copyTree(source, target, filter);
    } else if (filter(source)) {
      mkdirSync(dirname(target), { recursive: true });
      cpSync(source, target);
    }
  }
}

function build(target: string): string {
  const out = join(BUILD, target);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  // Sources are shipped only as compiled JS; everything else is copied as is.
  copyTree(SRC, out, (path) => !path.endsWith('.ts'));
  copyTree(COMPILED, out);
  const manifest = TARGETS[target]?.manifest(JSON.parse(read(join(SRC, 'manifest.json'))) as Manifest) ?? {};
  manifest.version = (JSON.parse(read(join(ROOT, 'package.json'))) as { version: string }).version;
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const vendorDir = join(out, 'vendor');
  mkdirSync(vendorDir, { recursive: true });
  cpSync(POLYFILL, join(vendorDir, 'browser-polyfill.js'));
  for (const entry of VENDOR_FILES) {
    const source = join(GENAI, entry.from);
    if (!existsSync(source)) throw new Error(`${entry.from} is missing from @mediapipe/tasks-genai (run npm install)`);
    const shipped = join(out, entry.to);
    mkdirSync(dirname(shipped), { recursive: true });
    cpSync(source, shipped);
  }
  return out;
}

/** Packs a built bundle; paths inside the archive are relative to its root. */
function package_(target: string, out: string, pkg: { name: string; version: string }): { file: string; files: number; bytes: number } {
  const entries: ZipEntry[] = walk(out, () => true).map((path) => ({
    name: relative(out, path).split(sep).join('/'),
    data: readFileSync(path)
  }));
  const archive = buildZip(entries);
  mkdirSync(DIST, { recursive: true });
  const file = join(DIST, archiveName(pkg, target));
  writeFileSync(file, archive);
  return { file, files: entries.length, bytes: archive.length };
}

type Args = { targets: string[]; watch: boolean; check: boolean };

function parseArgs(argv: string[]): Args {
  const args: Args = { targets: [], watch: false, check: false };
  for (const arg of argv) {
    if (arg.startsWith('--target=')) args.targets.push(...arg.slice(9).split(',').filter(Boolean));
    else if (arg === '--watch') args.watch = true;
    else if (arg === '--check') args.check = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (args.targets.length === 0) args.targets = Object.keys(TARGETS);
  const unknown = args.targets.filter((target) => !(target in TARGETS));
  if (unknown.length) throw new Error(`unknown target(s): ${unknown.join(', ')}`);
  return args;
}

function run({ targets, check: checkOnly }: Args): boolean {
  // Compile before validating: the checks that cover the injection list and the
  // bundles are only meaningful against emitted JS. --check stays a read-only
  // source-level pass so a clean checkout can lint without emitting.
  if (!checkOnly) {
    const compileFailure = compile();
    if (compileFailure) {
      console.error(`  error: compile: ${compileFailure}`);
      console.error('build failed: the sources do not compile');
      return false;
    }
  }

  const report = validate();
  for (const note of report.notes) console.log(`  note: ${note}`);
  if (report.problems.length) {
    for (const problem of report.problems) console.error(`  error: ${problem}`);
    console.error(`build failed: ${report.problems.length} problem(s)`);
    return false;
  }
  if (checkOnly) {
    console.log(`validated src for ${Object.keys(TARGETS).join(', ')}`);
    return true;
  }

  const pkg = JSON.parse(read(join(ROOT, 'package.json'))) as { name: string; version: string };
  for (const target of targets) {
    const out = build(target);
    console.log(`built ${target} -> ${relative(ROOT, out)}`);
    const packed = package_(target, out, pkg);
    console.log(`packaged ${relative(ROOT, packed.file)} (${String(packed.files)} files, ${String(Math.round(packed.bytes / 1024))} KB)`);
  }
  return true;
}

const args = parseArgs(process.argv.slice(2));
if (!run(args)) process.exitCode = 1;

if (args.watch) {
  const dirs = new Set<string>([SRC]);
  for (const path of walk(SRC, () => true)) dirs.add(dirname(path));
  let timer: ReturnType<typeof setTimeout> | undefined;
  for (const dir of dirs) {
    watch(dir, (_event, filename) => {
      if (!filename) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => run(args), 60);
    });
  }
  console.log(`watching ${relative(ROOT, SRC)} ...`);
}
