import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildZip, listZip, readZipEntry } from '../scripts/zip.ts';
import { ROOT } from './helpers.ts';
import { ENTRIES, GECKO_ID, GECKO_MIN_VERSION, ONNX_RUNTIME_ENTRIES, TARGETS, archiveName, stripComments } from '../scripts/package-spec.ts';

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const readJson = (path: string) => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));

const walk = (dir: string, prefix = ''): string[] =>
  readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(join(dir, entry.name), `${prefix}${entry.name}/`)
      : [`${prefix}${entry.name}`]
  );

/** The one policy the extension pages may ship with: WebAssembly needs its own quoted source. */
const CSP = "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'";

const ONNX_VENDOR = join(ROOT, 'vendor-src', 'onnxruntime');


function build(args: string[]) {
  const result = spawnSync(process.execPath, ['scripts/build.ts', ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test('the validator accepts the source tree', () => {
  const result = build(['--check']);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /^validated src for chrome, firefox$/m, 'the validator names the targets it checked');
  assert.equal(result.output.includes('error:'), false, result.output);
});

test('chrome gets a Chrome-flavoured manifest', () => {
  assert.equal(build(['--target=chrome']).status, 0);
  const manifest = readJson('build/chrome/manifest.json');
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, pkg.version, 'the build pins the manifest to package.json');
  assert.equal(manifest.minimum_chrome_version, '121');
  assert.equal('browser_specific_settings' in manifest, false);
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.equal(manifest.background.scripts.at(-1), 'background.js');
});

test('firefox gets a gecko id and no chrome-only keys', () => {
  assert.equal(build(['--target=firefox']).status, 0);
  const manifest = readJson('build/firefox/manifest.json');
  assert.equal(manifest.browser_specific_settings.gecko.id, GECKO_ID);
  assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, GECKO_MIN_VERSION);
  assert.equal('minimum_chrome_version' in manifest, false);
});

test('both bundles carry the polyfill, icons, locales and entry points', () => {
  assert.equal(build([]).status, 0);
  for (const target of TARGETS) {
    for (const file of ENTRIES) {
      assert.ok(existsSync(join(ROOT, 'build', target, file)), `${target}/${file}`);
    }
  }
});

test('each bundle is packed as a zip that mirrors the built tree', () => {
  assert.equal(build([]).status, 0);
  for (const target of TARGETS) {
    const archive = join(ROOT, 'dist', archiveName(pkg, target));
    assert.ok(existsSync(archive), `${target}: no zip was written to dist/`);
    const entries = listZip(readFileSync(archive));
    const names = entries.map((entry) => entry.name);
    assert.deepEqual(names, [...names].sort(), `${target}: zip entries are not sorted`);
    for (const file of ENTRIES) {
      assert.ok(names.includes(file), `${target}: ${file} is missing from the zip`);
    }
    assert.deepEqual(
      names,
      walk(join('build', target)).sort(),
      `${target}: the zip does not mirror build/${target}`
    );
    const zipped = readZipEntry(readFileSync(archive), 'manifest.json');
    assert.ok(zipped, `${target}: manifest.json could not be read back from the zip`);
    assert.equal(
      zipped.toString('utf8'),
      readFileSync(join(ROOT, 'build', target, 'manifest.json'), 'utf8'),
      `${target}: the zipped manifest differs from the built one`
    );
    for (const entry of entries) {
      assert.ok(!entry.name.endsWith('.ts'), `${target}: ${entry.name} should not ship`);
    }
  }
});

function verify(args: string[]) {
  const result = spawnSync(process.execPath, ['scripts/verify-package.ts', ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/**
 * Rebuilds `target`, then replaces its manifest in both the tree and the
 * archive, so the gate is fed an artefact that is internally consistent and
 * can only be rejected by the rule under test.
 */
function tamperManifest(target: string, mutate: (manifest: Record<string, any>) => void) {
  assert.equal(build([`--target=${target}`]).status, 0);
  const manifest = readJson(join('build', target, 'manifest.json'));
  mutate(manifest);
  writeFileSync(join(ROOT, 'build', target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const entries = walk(join('build', target)).map((name) => ({
    name,
    data: readFileSync(join(ROOT, 'build', target, name))
  }));
  writeFileSync(join(ROOT, 'dist', archiveName(pkg, target)), buildZip(entries));
  return verify([target]);
}

test('only the abstraction file touches the host globals', () => {
  // The extension talks to `browser`/`chrome` through AT.api and AT.<surface>
  // on purpose: one file resolves the global, everything else asks the
  // abstraction. A stray `chrome.tabs…` would bypass the polyfill and break
  // the other browser.
  const apiCalls = /\bchrome\.(runtime|tabs|storage|action|scripting|i18n|contextMenus|offscreen)\b/;
  const globals = /\b(globalThis|window|self|global)\.(chrome|browser)\b/;
  const offenders: string[] = [];
  for (const file of walk('src')) {
    if (!/\.(ts|html)$/.test(file) || file === 'lib/browser.ts') continue;
    const code = stripComments(readFileSync(join(ROOT, 'src', file), 'utf8'));
    if (apiCalls.test(code) || globals.test(code)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], 'the host API is only resolved in src/lib/browser.ts');
  assert.match(
    stripComments(readFileSync(join(ROOT, 'src', 'lib', 'browser.ts'), 'utf8')),
    /globals\.browser \?\? globals\.chrome/,
    'and it resolves the standard name first, with chrome only as the fallback'
  );
});

test('the source manifest is wired for the on-device host', () => {
  const manifest = readJson('src/manifest.json');
  assert.ok(manifest.permissions.includes('offscreen'), 'chrome.offscreen must be granted to open the host');
  assert.equal(manifest.content_security_policy.extension_pages, CSP, 'the shipped CSP is the one the gate accepts');

  const scripts: string[] = manifest.background.scripts;
  assert.ok(scripts.includes('lib/local.js'), 'the background shares the on-device protocol with the host');
  assert.ok(
    scripts.indexOf('lib/local.js') < scripts.indexOf('lib/settings.js'),
    'settings reads AT.local, so lib/local.js has to load first'
  );
  assert.ok(
    scripts.includes('lib/modelstore.js'),
    'a Firefox background page is the host, so it opens the model store itself'
  );
  assert.ok(scripts.includes('lib/onnxhost.js'), 'the host module is part of the background script set');
  assert.ok(
    scripts.indexOf('lib/onnxhost.js') < scripts.indexOf('background.js'),
    'the background installs the host, so the module has to exist first'
  );
  assert.ok(
    scripts.indexOf('lib/modelstore.js') < scripts.indexOf('lib/onnxhost.js'),
    'the host reads the model store, so it has to load after it'
  );
  assert.equal(scripts.includes('lib/localhost.js'), false, 'the retired GGUF host is gone');
  assert.equal(scripts.includes('lib/gemma.js'), false, 'the retired chat-template module is gone');

  // The host is opened by URL, so nothing in the manifest points at it: only
  // the validator knows to look for the pair.
  assert.ok(existsSync(join(ROOT, 'src', 'offscreen.html')), 'offscreen.html is reachable but unlisted');
  assert.ok(existsSync(join(ROOT, 'src', 'offscreen.ts')), 'offscreen.ts is reachable but unlisted');
});

test('both bundles ship the ONNX runtime byte for byte from the converted vendor tree', () => {
  // The runtime is part of every bundle: whether a context can execute it is a
  // runtime question (an offscreen document on Chrome, the background page on
  // Firefox, WebGPU either way), decided by the support probe, not by the zip.
  assert.equal(build([]).status, 0);

  for (const target of TARGETS) {
    const archive = listZip(readFileSync(join(ROOT, 'dist', archiveName(pkg, target)))).map((entry) => entry.name);
    for (const entry of ONNX_RUNTIME_ENTRIES) {
      const shipped = join(ROOT, 'build', target, entry);
      const source = join(ONNX_VENDOR, entry.slice('vendor/onnxruntime/'.length));
      assert.ok(existsSync(shipped), `${target}/${entry} was not copied out of the vendor tree`);
      assert.deepEqual(readFileSync(shipped), readFileSync(source), `${target}/${entry} is not the converted bytes`);
      assert.ok(archive.includes(entry), `${target}: ${entry} is missing from the zip`);
    }
  }
});

test('the retired runtimes are gone from both bundles', () => {
  assert.equal(build([]).status, 0);
  for (const target of TARGETS) {
    const archive = listZip(readFileSync(join(ROOT, 'dist', archiveName(pkg, target)))).map((entry) => entry.name);
    for (const gone of ['lib/localhost.js', 'lib/gemma.js', 'inference-worker.js']) {
      assert.equal(archive.includes(gone), false, `${target}: ${gone} still ships`);
    }
    assert.equal(
      archive.some((name) => name.startsWith('vendor/mediapipe/') || name.startsWith('vendor/wllama/')),
      false,
      `${target}: a retired runtime still ships`
    );
  }
});

test('only the chrome bundle asks for the permissions it can use', () => {
  assert.equal(build([]).status, 0);
  const chrome = readJson('build/chrome/manifest.json');
  const firefox = readJson('build/firefox/manifest.json');

  for (const [target, manifest] of [
    ['chrome', chrome],
    ['firefox', firefox]
  ] as [string, Record<string, any>][]) {
    for (const permission of ['storage', 'scripting', 'contextMenus']) {
      assert.ok(manifest.permissions.includes(permission), `${target}: ${permission}`);
    }
    assert.equal(manifest.content_security_policy.extension_pages, CSP, `${target}: CSP`);
  }

  assert.ok(chrome.permissions.includes('offscreen'), 'the model host needs the permission on chrome');
  assert.ok(chrome.permissions.includes('sidePanel'), 'the side panel needs the permission on chrome');
  assert.ok(chrome.permissions.includes('unlimitedStorage'), 'the multi-gigabyte model needs durable extension storage');
  assert.ok(firefox.permissions.includes('unlimitedStorage'), 'Firefox must not block installation on a persistence prompt');
  for (const permission of ['offscreen', 'sidePanel']) {
    assert.equal(
      firefox.permissions.includes(permission),
      false,
      `Firefox has no chrome.${permission} and refuses unknown permissions`
    );
  }
  assert.deepEqual(
    firefox.permissions,
    chrome.permissions.filter((permission: string) => permission !== 'offscreen' && permission !== 'sidePanel'),
    'firefox ships the same grant minus the ones it cannot use'
  );

  // The panel page itself is a chrome key; Firefox gets the tab fallback.
  assert.equal(chrome.side_panel?.default_path, 'options.html', 'the panel shows tab controls and model options');
  assert.equal('side_panel' in firefox, false, 'there is no side_panel key for firefox');
});

test('the packaging gate trades the wasm exception for eval only at the cost of failing', () => {
  // 'wasm-unsafe-eval' contains the word unsafe-eval; the gate compares quoted
  // source expressions, so the exception must not read as plain eval.
  const quoted = verify(['chrome']);
  assert.equal(quoted.status, 0, quoted.output);

  const evalled = tamperManifest('chrome', (manifest) => {
    manifest.content_security_policy.extension_pages = "script-src 'self' 'unsafe-eval'; object-src 'self'";
  });
  assert.equal(evalled.status, 1);
  assert.match(evalled.output, /extension_pages must keep script-src 'self' plus 'wasm-unsafe-eval'/);

  // Unquoted, it is not the exception at all: the runtime would not accept it.
  const unquoted = tamperManifest('chrome', (manifest) => {
    manifest.content_security_policy.extension_pages = 'script-src self wasm-unsafe-eval; object-src self';
  });
  assert.equal(unquoted.status, 1);
  assert.match(unquoted.output, /extension_pages must keep script-src 'self' plus 'wasm-unsafe-eval'/);
});

test('the packaging gate ties the offscreen permission to the target', () => {
  const tooBold = tamperManifest('firefox', (manifest) => {
    manifest.permissions = [...manifest.permissions, 'offscreen'];
  });
  assert.equal(tooBold.status, 1);
  assert.match(tooBold.output, /the offscreen permission must be present for chrome and absent for firefox/);

  const mute = tamperManifest('chrome', (manifest) => {
    manifest.permissions = manifest.permissions.filter((permission: string) => permission !== 'offscreen');
  });
  assert.equal(mute.status, 1);
  assert.match(mute.output, /the offscreen permission must be present for chrome and absent for firefox/);
});

test('the packaging gate refuses a bundle that lost the ONNX runtime', () => {
  for (const target of TARGETS) {
    assert.equal(build([`--target=${target}`]).status, 0);
    const entries = walk(join('build', target))
      .filter((name) => !name.startsWith('vendor/onnxruntime/'))
      .map((name) => ({ name, data: readFileSync(join(ROOT, 'build', target, name)) }));
    writeFileSync(join(ROOT, 'dist', archiveName(pkg, target)), buildZip(entries));
    const result = verify([target]);
    assert.equal(result.status, 1, `${target}: a bundle without the runtime must be refused`);
    for (const file of ONNX_RUNTIME_ENTRIES) {
      assert.match(result.output, new RegExp(`the archive is missing ${file.replace(/[/.]/g, '\\$&')}`));
    }
  }
});

test('the validator refuses a tree without the vendor tree', () => {
  // A scratch checkout with no converted runtime: the gate has to name what is
  // missing instead of emitting an offline-incapable zip.
  const dir = mkdtempSync(join(tmpdir(), 'autotranslate-vendor-'));
  try {
    for (const name of ['package.json', 'tsconfig.json', 'tsconfig.tools.json', 'src', 'scripts']) {
      cpSync(join(ROOT, name), join(dir, name), { recursive: true });
    }
    symlinkSync(join(ROOT, 'vendor-src'), join(dir, 'vendor-src'), 'dir');
    mkdirSync(join(dir, 'node_modules'));
    for (const name of readdirSync(join(ROOT, 'node_modules'))) {
      symlinkSync(join(ROOT, 'node_modules', name), join(dir, 'node_modules', name), 'dir');
    }
    const run = (args: string[]) => {
      const result = spawnSync(process.execPath, ['scripts/build.ts', ...args], { cwd: dir, encoding: 'utf8' });
      return { status: result.status, output: `${result.stdout}${result.stderr}` };
    };

    const armed = run(['--check']);
    assert.equal(armed.status, 0, `the scratch tree itself must validate: ${armed.output}`);

    // The converted tree is symlinked from the real checkout, so take the
    // contract's first entry away and let the gate notice.
    const first = ONNX_RUNTIME_ENTRIES[0]!;
    const relative = first.slice('vendor/onnxruntime/'.length);
    const scratch = join(dir, 'vendor-src');
    rmSync(scratch);
    cpSync(join(ROOT, 'vendor-src'), scratch, { recursive: true });
    rmSync(join(scratch, 'onnxruntime', relative));
    const missing = run(['--check']);
    assert.equal(missing.status, 1);
    assert.match(
      missing.output,
      new RegExp(`vendor: ${first.replace(/[/.]/g, '\\$&')} is missing from vendor-src/onnxruntime`)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    assert.ok(
      existsSync(join(ONNX_VENDOR, ONNX_RUNTIME_ENTRIES[0]!.slice('vendor/onnxruntime/'.length))),
      'the scratch test must not touch the real vendor tree'
    );
  }
});

test('the packaging gate accepts the built tree', () => {
  assert.equal(build([]).status, 0);
  const result = verify([]);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, new RegExp(`packaging gate passed for ${TARGETS.join(', ')}`));
});
