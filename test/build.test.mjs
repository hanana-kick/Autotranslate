import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers.mjs';

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const readJson = (path) => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));

function build(args) {
  const result = spawnSync(process.execPath, ['scripts/build.mjs', ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test('the validator accepts the source tree', () => {
  const result = build(['--check']);
  assert.equal(result.status, 0, result.output);
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
  assert.equal(manifest.browser_specific_settings.gecko.id, 'autotranslate@hanana-kick');
  assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, '121.0');
  assert.equal('minimum_chrome_version' in manifest, false);
});

test('both bundles carry the polyfill, icons, locales and entry points', () => {
  assert.equal(build([]).status, 0);
  const required = [
    'manifest.json',
    'background.js',
    'content.js',
    'popup.html',
    'popup.js',
    'options.html',
    'options.js',
    'styles.css',
    'vendor/browser-polyfill.js',
    'lib/constants.js',
    'lib/browser.js',
    'lib/rules.js',
    'lib/settings.js',
    'lib/engines.js',
    'lib/dom.js',
    'icons/icon-16.png',
    'icons/icon-32.png',
    'icons/icon-48.png',
    'icons/icon-128.png',
    '_locales/en/messages.json',
    '_locales/ko/messages.json'
  ];
  for (const target of ['chrome', 'firefox']) {
    for (const file of required) {
      assert.ok(existsSync(join(ROOT, 'build', target, file)), `${target}/${file}`);
    }
  }
});
