import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

for (const page of ['welcome', 'popup', 'options']) {
  test(`${page} bundles the UI routing helper before its controller`, () => {
    const html = readFileSync(new URL(`../src/${page}.html`, import.meta.url), 'utf8');
    const scripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map(match => match[1]);
    assert.equal(scripts.filter(src => src === 'lib/ui.js').length, 1);
    assert.ok(scripts.indexOf('lib/browser.js') < scripts.indexOf('lib/ui.js'));
    assert.ok(scripts.indexOf('lib/ui.js') < scripts.indexOf(`${page}.js`));
  });
}
