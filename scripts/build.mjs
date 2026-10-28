// Builds browser-specific bundles from src/ and validates the cross-browser
// invariants. No dependencies beyond Node.
//
//   node scripts/build.mjs                  # both targets
//   node scripts/build.mjs --target=firefox # one target
//   node scripts/build.mjs --check          # validate only, write nothing
//   node scripts/build.mjs --watch          # rebuild on change
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, watch, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');
const BUILD = join(ROOT, 'build');
const POLYFILL = join(ROOT, 'node_modules', 'webextension-polyfill', 'dist', 'browser-polyfill.js');
const GECKO_ID = 'autotranslate@hanana-kick';
const GECKO_MIN_VERSION = '121.0';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const TARGETS = {
  chrome: {
    manifest(manifest) {
      delete manifest.browser_specific_settings;
      return manifest;
    }
  },
  firefox: {
    manifest(manifest) {
      delete manifest.minimum_chrome_version;
      manifest.browser_specific_settings = {
        gecko: { id: GECKO_ID, strict_min_version: GECKO_MIN_VERSION }
      };
      return manifest;
    }
  }
};

class Check {
  constructor() {
    this.problems = [];
    this.notes = [];
  }

  fail(condition, message) {
    if (!condition) this.problems.push(message);
    return Boolean(condition);
  }

  note(message) {
    this.notes.push(message);
  }
}

function walk(dir, filter) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(path, filter));
    else if (filter(path)) found.push(path);
  }
  return found;
}

const read = (path) => readFileSync(path, 'utf8');
const matches = (source, pattern) => [...source.matchAll(pattern)].map((match) => match[1]);

function listedFiles(source, marker) {
  const block = marker.exec(source)?.[1] ?? '';
  return matches(block, /'([^']+)'/g);
}

function checkManifest(check, manifest, exists) {
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
  const referenced = [
    ...(scripts ?? []),
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action?.default_icon ?? {}),
    manifest.action?.default_popup,
    manifest.options_ui?.page
  ].filter(Boolean);
  for (const file of referenced) {
    check.fail(exists(file), `manifest: referenced file is missing: ${file}`);
  }
  for (const permission of manifest.permissions ?? []) {
    check.fail(
      ['storage', 'scripting', 'contextMenus', 'activeTab', 'tabs'].includes(permission),
      `manifest: unexpected permission ${permission}`
    );
  }
}

function checkSourcePairing(check, backgroundSource, manifest) {
  const importScripts = listedFiles(backgroundSource, /importScripts\(([\s\S]*?)\)/);
  const expected = (manifest.background?.scripts ?? []).slice(0, -1);
  check.fail(
    importScripts.length > 0 && importScripts.join(',') === expected.join(','),
    `background.js: importScripts list must match background.scripts (${expected.join(', ')})`
  );
  const contentFiles = listedFiles(backgroundSource, /const CONTENT_FILES = Object\.freeze\(\[([\s\S]*?)\]\)/);
  check.fail(contentFiles.length > 0, 'background.js: CONTENT_FILES must list the injectable files');
  return contentFiles;
}

function collectI18nKeys(source, path) {
  const keys = new Set();
  for (const key of matches(source, /__MSG_([A-Za-z0-9_]+)__/g)) keys.add(key);
  for (const key of matches(source, /i18n\.msg\(\s*'([A-Za-z0-9_]+)'/g)) keys.add(key);
  // Context-menu titles resolve their key through the MENU table.
  for (const key of matches(source, /i18n:\s*'([A-Za-z0-9_]+)'/g)) keys.add(key);
  for (const key of matches(source, /data-i18n(?:-placeholder|-title)?="([A-Za-z0-9_]+)"/g)) keys.add(key);
  return [...keys].map((key) => ({ key, path }));
}

function checkI18n(check) {
  const localeDir = join(SRC, '_locales');
  const locales = readdirSync(localeDir);
  check.fail(locales.includes('en'), 'i18n: default locale en is missing');
  const catalogues = new Map();
  for (const locale of locales) {
    const path = join(localeDir, locale, 'messages.json');
    let parsed;
    try {
      parsed = JSON.parse(read(path));
    } catch (error) {
      check.fail(false, `i18n: ${locale}/messages.json is not valid JSON (${error.message})`);
      continue;
    }
    catalogues.set(locale, parsed);
    for (const [key, entry] of Object.entries(parsed)) {
      check.fail(typeof entry?.message === 'string' && entry.message.length > 0, `i18n: ${locale}.${key} has no message`);
      for (const placeholder of matches(entry.message ?? '', /\$(\d+)\$/g)) {
        check.fail(
          entry.placeholders?.[placeholder]?.content === `$${placeholder}`,
          `i18n: ${locale}.${key} is missing placeholder $${placeholder}`
        );
      }
    }
  }
  const used = new Map();
  const sources = walk(SRC, (path) => /\.(js|html|json)$/.test(path) && !path.includes(`${localeDir}`));
  for (const path of sources) {
    for (const { key, path: from } of collectI18nKeys(read(path), relative(ROOT, path))) {
      if (!used.has(key)) used.set(key, []);
      used.get(key).push(from);
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

function checkSyntax(check) {
  for (const path of walk(SRC, (file) => file.endsWith('.js'))) {
    const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
    check.fail(result.status === 0, `syntax: ${relative(ROOT, path)}: ${result.stderr.trim()}`);
  }
}

function checkIcons(check, exists) {
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

function validate() {
  const check = new Check();
  const pkg = JSON.parse(read(join(ROOT, 'package.json')));
  const manifest = JSON.parse(read(join(SRC, 'manifest.json')));
  const backgroundSource = read(join(SRC, 'background.js'));
  const exists = (file) =>
    existsSync(join(SRC, file)) || (file.startsWith('vendor/') && existsSync(POLYFILL));

  check.fail(manifest.version === pkg.version, `manifest: version ${manifest.version} must match package.json ${pkg.version}`);
  check.fail(existsSync(POLYFILL), 'vendor: webextension-polyfill is not installed (run npm install)');
  checkManifest(check, manifest, exists);
  const contentFiles = checkSourcePairing(check, backgroundSource, manifest);
  for (const file of contentFiles) {
    check.fail(exists(file), `injection: content file is missing: ${file}`);
  }
  for (const target of Object.keys(TARGETS)) {
    const transformed = TARGETS[target].manifest(structuredClone(manifest));
    if (target === 'firefox') {
      check.fail(
        transformed.browser_specific_settings?.gecko?.id === GECKO_ID,
        'firefox: browser_specific_settings.gecko.id must be set'
      );
      check.fail(
        !('minimum_chrome_version' in transformed),
        'firefox: minimum_chrome_version must be stripped'
      );
    } else {
      check.fail(
        !('browser_specific_settings' in transformed),
        'chrome: browser_specific_settings must not be shipped'
      );
    }
  }
  checkI18n(check);
  checkIcons(check, exists);
  checkSyntax(check);
  return check;
}

function copyTree(from, to, filter = () => true) {
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

function build(target) {
  const out = join(BUILD, target);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  copyTree(SRC, out);
  const manifest = TARGETS[target].manifest(JSON.parse(read(join(SRC, 'manifest.json'))));
  manifest.version = JSON.parse(read(join(ROOT, 'package.json'))).version;
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const vendorDir = join(out, 'vendor');
  mkdirSync(vendorDir, { recursive: true });
  cpSync(POLYFILL, join(vendorDir, 'browser-polyfill.js'));
  return out;
}

function parseArgs(argv) {
  const args = { targets: [], watch: false, check: false };
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

function run({ targets, check: checkOnly }) {
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
  for (const target of targets) {
    const out = build(target);
    console.log(`built ${target} -> ${relative(ROOT, out)}`);
  }
  return true;
}

const args = parseArgs(process.argv.slice(2));
if (!run(args)) process.exitCode = 1;

if (args.watch) {
  const dirs = new Set([SRC]);
  for (const path of walk(SRC, () => true)) dirs.add(dirname(path));
  let timer = 0;
  for (const dir of dirs) {
    watch(dir, (_event, filename) => {
      if (!filename) return;
      clearTimeout(timer);
      timer = setTimeout(() => run(args), 60);
    });
  }
  console.log(`watching ${relative(ROOT, SRC)} ...`);
}
