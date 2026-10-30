// A clean checkout has no build/ directory. Building must not depend on
// leftovers from an earlier run, so this copies the sources into a scratch
// directory (node_modules is symlinked, nothing is deleted from the checkout)
// and runs the real build there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from './helpers.ts';
import { ENTRIES, RUNTIME_ENTRIES, TARGETS, archiveName } from '../scripts/package-spec.ts';

const COPIED = ['package.json', 'tsconfig.json', 'tsconfig.tools.json', 'src', 'demo', 'scripts', 'test'];

const run = (dir: string, args: string[]) => {
  const result = spawnSync(process.execPath, ['scripts/build.ts', ...args], { cwd: dir, encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
};

/** Every file under `dir`, relative to it; a directory is not an artefact. */
const files = (dir: string, prefix = ''): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]
  );

test('a clean checkout validates, builds and packages', () => {
  const dir = mkdtempSync(join(tmpdir(), 'autotranslate-clean-'));
  try {
    for (const name of COPIED) cpSync(join(ROOT, name), join(dir, name), { recursive: true });
    symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
    assert.equal(existsSync(join(dir, 'build')), false, 'the scratch tree must start without build/');
    assert.equal(existsSync(join(dir, 'dist')), false, 'the scratch tree must start without dist/');

    const checked = run(dir, ['--check']);
    assert.equal(checked.status, 0, `--check on a clean tree: ${checked.output}`);

    const built = run(dir, []);
    assert.equal(built.status, 0, `build on a clean tree: ${built.output}`);

    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name: string; version: string };
    for (const target of TARGETS) {
      assert.ok(existsSync(join(dir, 'dist', archiveName(pkg, target))), `${target}: no archive was packaged`);
      for (const file of ENTRIES) {
        assert.ok(existsSync(join(dir, 'build', target, file)), `${target}/${file} is missing`);
      }
    }

    // The on-device host has to survive a build from scratch: the page, the
    // runtime it loads, and a permission set each browser actually accepts.
    for (const target of TARGETS) {
      const manifest = JSON.parse(readFileSync(join(dir, 'build', target, 'manifest.json'), 'utf8')) as {
        permissions?: string[];
        content_security_policy?: { extension_pages?: string };
      };
      assert.equal(
        manifest.content_security_policy?.extension_pages,
        "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
        `${target}: WebAssembly is the only exception the host needs`
      );
      assert.equal(
        (manifest.permissions ?? []).includes('offscreen'),
        target === 'chrome',
        `${target}: offscreen is a chrome-only permission`
      );
      const bundle = files(join(dir, 'build', target));
      for (const host of ['lib/local.js', 'lib/modelstore.js', 'lib/localhost.js', 'offscreen.html', 'offscreen.js']) {
        assert.ok(bundle.includes(host), `${target}: ${host} is part of the on-device engine`);
      }
      const runtime = bundle.filter((name) => name.startsWith('vendor/mediapipe/')).sort();
      assert.deepEqual(runtime, [...RUNTIME_ENTRIES].sort(), `${target} must carry the whole on-device runtime`);
      assert.deepEqual(
        readdirSync(join(dir, 'build', target, 'vendor')).sort(),
        ['browser-polyfill.js', 'mediapipe'],
        `${target}: vendor/ holds the polyfill and the runtime, nothing else`
      );
    }

    const gate = spawnSync(process.execPath, ['scripts/verify-package.ts'], { cwd: dir, encoding: 'utf8' });
    assert.equal(gate.status, 0, `the packaging gate rejected a clean build: ${gate.stdout}${gate.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
