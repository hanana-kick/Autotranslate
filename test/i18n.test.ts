// Unit tests for the localisation feature: `AT.i18n.msg` (catalogue lookups and
// positional substitutions) and `AT.i18n.apply` (data-i18n attributes), plus
// `AT.getURL`. `chrome.i18n.getMessage` is faked with Chrome's semantics: an
// unknown key yields an empty string and `$n` slots are filled from a flattened
// substitutions list, leaving an unfilled slot visible.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SRC, load, resetGlobals, type ATNamespace } from './helpers.ts';

const CATALOGUE: Record<string, string> = {
  greeting: 'Hello there',
  single: 'One is $1',
  triple: 'Answer $1 in $2 ms for $3',
  repeated: '$1 then $1 then $2'
};

type GetTextCall = { key: unknown; subs: unknown };

/** `chrome.i18n` with Chrome's substitution semantics, recording what was asked. */
function fakeI18n(calls: GetTextCall[], catalogue: Record<string, string> = CATALOGUE) {
  return {
    getMessage: (key: unknown, subs?: unknown): string => {
      calls.push({ key, subs });
      const template = catalogue[String(key)];
      if (template === undefined) return '';
      const list = Array.isArray(subs) ? subs : subs === undefined ? [] : [subs];
      return template.replace(/\$(\d)/g, (_match, digit: string) => {
        const value = list[Number(digit) - 1];
        return typeof value === 'string' ? value : `$${digit}`;
      });
    },
    getUILanguage: () => 'ko'
  };
}

// A mini DOM. Attributes are the source of truth and `dataset` is derived from
// them, the way a real element maps `data-i18n` to `dataset.i18n`.
type Attrs = Record<string, string>;

class StubElement {
  attrs: Attrs;
  textContent = '';
  children: StubElement[] = [];

  constructor(attrs: Attrs = {}) {
    this.attrs = attrs;
  }

  // A real element maps `data-i18n-placeholder` to `dataset.i18nPlaceholder`,
  // and that camelCase mapping is exactly what AT.i18n.apply relies on.
  get dataset(): Record<string, string | undefined> {
    const derived: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(this.attrs)) {
      if (!name.startsWith('data-')) continue;
      const key = name
        .slice('data-'.length)
        .replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
      derived[key] = value;
    }
    return derived;
  }

  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }

  descendants(): StubElement[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }

  /** Only attribute-presence selectors are needed by AT.i18n.apply. */
  querySelectorAll(selector: string): StubElement[] {
    const attribute = /^\[([\w-]+)\]$/.exec(selector)?.[1];
    if (attribute === undefined) return [];
    return this.descendants().filter((node) => node.attrs[attribute] !== undefined);
  }
}

function boot(): ATNamespace {
  resetGlobals();
  const calls: GetTextCall[] = [];
  const host = globalThis as unknown as { browser: unknown };
  host.browser = {
    runtime: { getURL: (path: string) => `chrome-extension://abc/${path}` },
    i18n: fakeI18n(calls)
  };
  const AT = load('lib/constants.js', 'lib/browser.js');
  (AT as unknown as { __calls: GetTextCall[] }).__calls = calls;
  return AT;
}

/** A shipped `_locales/<locale>/messages.json`. */
type Catalogue = Record<string, { message?: string; placeholders?: Record<string, { content?: string }> }>;

const enCatalogue = JSON.parse(readFileSync(join(SRC, '_locales', 'en', 'messages.json'), 'utf8')) as Catalogue;
const koCatalogue = JSON.parse(readFileSync(join(SRC, '_locales', 'ko', 'messages.json'), 'utf8')) as Catalogue;

/** Boots the namespace against a real catalogue instead of the mini one. */
function bootCatalogue(entries: Catalogue): ATNamespace {
  resetGlobals();
  const calls: GetTextCall[] = [];
  const messages = Object.fromEntries(Object.entries(entries).map(([key, entry]) => [key, entry.message ?? '']));
  const host = globalThis as unknown as { browser: unknown };
  host.browser = {
    runtime: { getURL: (path: string) => `chrome-extension://abc/${path}` },
    i18n: fakeI18n(calls, messages)
  };
  return load('lib/constants.js', 'lib/browser.js', 'lib/local.js');
}

test('msg returns the catalogue entry for a known key', () => {
  const AT = boot();
  assert.equal(AT.i18n.msg('greeting'), 'Hello there');
});

test('an unknown or absent key degrades to a visible placeholder', () => {
  const AT = boot();
  assert.equal(AT.i18n.msg('no_such_key'), '[no_such_key]');
  assert.equal(AT.i18n.msg(undefined), '[undefined]');
});

test('every positional slot is filled when all arguments are passed', () => {
  const AT = boot();
  const rendered = AT.i18n.msg('triple', ['sentence', '12', 'ko']);
  assert.equal(rendered, 'Answer sentence in 12 ms for ko');
  assert.ok(!rendered.includes('$'), `unexpanded placeholder left in ${rendered}`);
});

test('a missing argument leaves its slot visible instead of blanking it', () => {
  const AT = boot();
  // Chrome leaves an unfilled $n alone, so a caller that forgets an argument
  // shows up as a literal placeholder: this is how a dropped substitution
  // surfaces, and why callers must pass as many arguments as the template has.
  assert.equal(AT.i18n.msg('triple', ['sentence', '12']), 'Answer sentence in 12 ms for $3');
});

test('a single substitution may be passed as a string or a list', () => {
  const AT = boot();
  assert.equal(AT.i18n.msg('single', 'one'), 'One is one');
  assert.equal(AT.i18n.msg('single', ['one']), 'One is one');
  const calls = (AT as unknown as { __calls: GetTextCall[] }).__calls;
  assert.deepEqual(calls.map((call) => call.subs), ['one', ['one']]);
});

test('the same slot can be used twice', () => {
  const AT = boot();
  assert.equal(AT.i18n.msg('repeated', ['a', 'b']), 'a then a then b');
});

test('apply fills text, placeholder and title from data attributes', () => {
  const AT = boot();
  const text = new StubElement({ 'data-i18n': 'greeting' });
  const input = new StubElement({ 'data-i18n-placeholder': 'single' });
  const button = new StubElement({ 'data-i18n-title': 'no_such_key' });
  const untouched = new StubElement({ id: 'keep' });
  untouched.textContent = 'page copy';
  const page = new StubElement();
  page.children = [text, input, button, untouched];

  AT.i18n.apply(page);

  assert.equal(text.textContent, 'Hello there');
  assert.equal(input.attrs['placeholder'], 'One is $1', 'one slot stays unfilled without arguments');
  assert.equal(button.attrs['title'], '[no_such_key]');
  assert.equal(untouched.textContent, 'page copy', 'elements without data attributes are not rewritten');
});

test('apply is scoped to the root it is given', () => {
  const AT = boot();
  const inside = new StubElement({ 'data-i18n': 'greeting' });
  const outside = new StubElement({ 'data-i18n': 'greeting' });
  const section = new StubElement();
  section.children = [inside];
  const page = new StubElement();
  page.children = [section, outside];

  AT.i18n.apply(section);

  assert.equal(inside.textContent, 'Hello there');
  assert.equal(outside.textContent, '', 'nodes outside the root stay untouched');
});

test('getURL delegates to the extension runtime', () => {
  const AT = boot();
  assert.equal(AT.getURL('icons/icon-16.png'), 'chrome-extension://abc/icons/icon-16.png');
});

test('getURL fails loudly without an extension runtime', () => {
  resetGlobals();
  const host = globalThis as unknown as { browser: unknown };
  host.browser = { i18n: fakeI18n([]) };
  const AT = load('lib/constants.js', 'lib/browser.js');
  assert.throws(() => AT.getURL('a.png'), TypeError);
});

test('loading without any extension API is refused outright', () => {
  resetGlobals();
  assert.throws(() => load('lib/constants.js', 'lib/browser.js'), /no browser\/chrome API/);
});

// The on-device UI reads every label from the catalogue, so a key that exists
// in code only would show the popup its own key name.
test('both shipped catalogues carry the on-device wording', () => {
  assert.deepEqual(
    Object.keys(koCatalogue).sort(),
    Object.keys(enCatalogue).sort(),
    'a key missing from ko shows Korean users the raw key'
  );

  const needed = [
    'options_local',
    'options_localHint',
    'options_localModel',
    'options_localNone',
    'options_localMaxTokens',
    'options_fallbackEngine',
    'options_fallbackNone',
    'options_modelUrl',
    'options_modelToken',
    'options_modelTokenHint',
    'options_download',
    'options_downloading',
    'options_downloadDone',
    'options_downloadFailed',
    'options_needsToken',
    'options_noModels',
    'options_usage',
    'options_localUnsupported',
    'options_stateUnloaded',
    'options_stateLoading',
    'options_stateReady',
    'options_stateBusy',
    'options_stateError'
  ];
  for (const key of needed) {
    assert.ok(enCatalogue[key]?.message, `en.${key} is used by the model manager`);
    assert.ok(koCatalogue[key]?.message, `ko.${key} must be translated as well`);
  }

  // Anything with a slot must declare it, or Chrome leaves `$1` on screen.
  for (const [key, entry] of Object.entries(enCatalogue)) {
    if (!/\$\d+\$/.test(entry.message ?? '')) continue;
    assert.ok(entry.placeholders, `${key} uses a positional slot without declaring a placeholder`);
  }
});

test('every host state has wording the popup can show', () => {
  const AT = bootCatalogue(enCatalogue);
  const msg = AT.i18n.msg as (key: string) => string;
  const describe = (state: string, extra: ATNamespace = {}) =>
    AT.local.describeStatus(AT.local.normalizeStatus({ supported: true, state, ...extra }), true, msg);

  const unsupported = AT.local.describeStatus(null, false, msg);
  const unloaded = AT.local.describeStatus(null, true, msg);
  const loading = describe('loading', { modelName: 'TranslateGemma 4B IT (int8, web)' });
  const busy = describe('busy', { modelName: 'TranslateGemma 4B IT (int8, web)' });
  const ready = describe('ready', { modelName: 'TranslateGemma 4B IT (int8, web)', loadMs: 4200 });
  const failed = describe('error', { lastError: 'no webgpu device' });

  assert.equal(unsupported, enCatalogue['options_localUnsupported']?.message);
  assert.equal(unloaded, enCatalogue['options_stateUnloaded']?.message);
  assert.ok(loading.startsWith(String(enCatalogue['options_stateLoading']?.message)));
  assert.ok(busy.startsWith(String(enCatalogue['options_stateBusy']?.message)));
  assert.ok(ready.startsWith(String(enCatalogue['options_stateReady']?.message)));
  assert.ok(failed.startsWith(String(enCatalogue['options_stateError']?.message)));

  assert.ok(loading.includes('TranslateGemma 4B IT (int8, web)'), 'the sentence names the model being loaded');
  assert.ok(ready.includes('4200 ms'), 'a ready model says how long it took to get here');
  assert.ok(failed.includes('no webgpu device'), 'the reason the host gave has to be visible');

  for (const value of [unsupported, unloaded, loading, busy, ready, failed]) {
    assert.ok(!value.startsWith('['), `a missing key would surface as ${JSON.stringify(value)}`);
  }
});
