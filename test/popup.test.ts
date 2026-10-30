import assert from 'node:assert/strict';
import test from 'node:test';
import { load, resetGlobals, type ATNamespace } from './helpers.ts';

// The popup is a classic script next to popup.html; these are the files the
// markup loads before it, so `AT.settings.load()`, `AT.i18n` and
// `AT.local.describeStatus` are the real modules rather than stubs.
const LIBS = ['lib/constants.js', 'lib/rules.js', 'lib/browser.js', 'lib/local.js', 'lib/ui.js', 'lib/settings.js'];

// The ids in popup.html; the stub hands one element back per id.
const FIELD_IDS = ['enabled', 'host', 'status', 'localStatus', 'targetLang', 'options'] as const;
type FieldId = (typeof FIELD_IDS)[number];

/** The popup only ever reads `target` off an event. */
type UIEvent = { target?: unknown };
type Listener = (event: UIEvent) => unknown;

/** An `option` node made by `document.createElement('option')`. */
type StubOption = { tagName: string; value: string; textContent: string };

/** Everything popup.js touches on a field. */
type StubField = {
  tagName: string;
  value: string;
  checked: boolean;
  disabled: boolean;
  hidden: boolean;
  textContent: string;
  dataset: Record<string, string | undefined>;
  options: StubOption[];
  listeners: Record<string, Listener[]>;
  addEventListener: (type: string, listener: Listener) => void;
  replaceChildren: (...nodes: StubOption[]) => void;
};

/** The scripted reply for one message type; a function may read the message. */
type Script = { [type: string]: unknown };

type Options = {
  /** The GET_STATE payload, spread into an `{ ok: true }` reply. */
  state?: ATNamespace;
  /** Per-type overrides; an unscripted type answers nothing, like a dead channel. */
  script?: Script;
  /** The blob stored under the `settings` key. */
  stored?: ATNamespace | null;
  /** Fail storage reads from the start. */
  storageFails?: boolean;
};

const TAB = { id: 7, url: 'https://example.com/article', title: 'Example', host: 'example.com' };

const stateOf = (over: ATNamespace = {}): ATNamespace => ({
  tab: { ...TAB },
  canTranslate: true,
  rule: null,
  state: { status: 'idle', translated: 0, error: null, targetLang: 'ko' },
  ...over
});

/** A promise that settles once the given scheduler has run its turn. */
const yielded = (schedule: (callback: () => void) => void) =>
  new Promise<void>((resolve) => {
    schedule(resolve);
  });

/** Lets a handler chain the popup started without returning land: tick, then check phase. */
const flush = async () => {
  await yielded(process.nextTick);
  await yielded(setImmediate);
  await yielded(process.nextTick);
};

/**
 * Boots popup.js the way popup.html does — the shared libs first, then the
 * entry point — against a recording `chrome` stand-in plus a field-per-id
 * document.
 */
function environment({ state, script = {}, stored = null, storageFails = false }: Options = {}) {
  resetGlobals();
  const host = globalThis as ATNamespace;

  const sends: ATNamespace[] = [];
  const statesSent: ATNamespace[] = [];
  // The `chrome.storage.local` area; seeded with the settings blob once the
  // real storage key is known (after the libs loaded).
  const area: ATNamespace = {};
  let storageFailure: string | null = storageFails ? 'storage is unavailable' : null;
  let optionsOpened = 0;
  // Tabs the popup opened through `AT.ui` (the side panel is absent here, so
  // every extension page it asks for lands in one).
  const createdTabs: ATNamespace[] = [];

  // The background answers the action messages unless a test scripts them;
  // an unscripted type answers nothing, the way a dead channel does.
  const replies: Script = {
    'at/translate-tab': { ok: true },
    'at/restore-tab': { ok: true },
    ...script
  };

  host.browser = {
    runtime: {
      getURL: (path: string) => `chrome-extension://test/${path}`,
      getManifest: () => ({ version: '9.9.9' }),
      openOptionsPage: async () => {
        optionsOpened += 1;
      },
      sendMessage: async (message: ATNamespace) => {
        sends.push(message);
        if (message?.type === 'at/get-state') statesSent.push(message);
        const scripted: unknown = Object.prototype.hasOwnProperty.call(replies, message?.type)
          ? replies[message?.type]
          : message?.type === 'at/get-state'
            ? { ok: true, ...stateOf(state) }
            : undefined;
        return typeof scripted === 'function' ? (scripted as (message: ATNamespace) => unknown)(message) : scripted;
      },
      onMessage: { addListener: () => {} },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} }
    },
    storage: {
      local: {
        get: async (key: string) => {
          if (storageFailure) throw new Error(storageFailure);
          return { [key]: key in area ? structuredClone(area[key]) : undefined };
        },
        set: async (items: ATNamespace) => {
          if (storageFailure) throw new Error(storageFailure);
          Object.assign(area, structuredClone(items));
        }
      }
    },
    tabs: {
      create: async (details: ATNamespace) => {
        createdTabs.push(details);
        return { id: 9 };
      }
    },
    i18n: {
      // Keeps the message key visible in the status text and shows which
      // substitutions the popup passed along.
      getMessage: (key: string | undefined, subs?: string | string[]) =>
        subs === undefined ? String(key) : `${key}:${Array.isArray(subs) ? subs.join(',') : subs}`,
      getUILanguage: () => 'en'
    }
  };

const makeField = (tagName: string, hidden = false): StubField => {
    const field: StubField = {
      tagName,
      value: '',
      checked: false,
      disabled: false,
      hidden,
      textContent: '',
      dataset: {},
      options: [],
      listeners: {},
      addEventListener: (type, listener) => {
        (field.listeners[type] ??= []).push(listener);
      },
      replaceChildren: (...nodes) => {
        field.options = nodes;
      }
    };
    return field;
  };

  const fields: Record<FieldId, StubField> = {
    enabled: makeField('input'),
    host: makeField('p'),
    status: makeField('p'),
    // popup.html ships #localStatus with the `hidden` attribute on.
    localStatus: makeField('p', true),
    targetLang: makeField('select'),
    options: makeField('button')
  };

  const documentEvents: Record<string, Listener[]> = {};
  host.document = {
    getElementById: (id: string) => ((FIELD_IDS as readonly string[]).includes(id) ? fields[id as FieldId] : null),
    createElement: (tag: string) => ({ tagName: tag, value: '', textContent: '' }),
    querySelectorAll: () => [],
    addEventListener: (type: string, listener: Listener) => {
      (documentEvents[type] ??= []).push(listener);
    }
  };

  const AT = load(...LIBS, 'popup.js');
  if (stored !== null) area[AT.C.STORAGE_KEY as string] = structuredClone(stored);

  // Mirrors the real background: SET_SETTINGS really saves the patch and
  // answers with the normalised snapshot a content script may see.
  if (!Object.prototype.hasOwnProperty.call(replies, 'at/set-settings')) {
    replies['at/set-settings'] = async (message: ATNamespace) => ({
      ok: true,
      settings: AT.settings.contentSnapshot(await AT.settings.save(message?.patch ?? {}))
    });
  }

  const dispatch = (id: FieldId, type: string, event: UIEvent = { target: fields[id] }): Promise<unknown>[] =>
    (fields[id].listeners[type] ?? []).map((listener) => Promise.resolve(listener(event)));

  const run = async (id: FieldId, type: string, event?: UIEvent) => {
    await Promise.all(dispatch(id, type, event));
    await flush();
  };

  return {
    AT,
    fields,
    sends,
    statesSent,
    get stored(): ATNamespace | null {
      return (area[AT.C.STORAGE_KEY as string] ?? null) as ATNamespace | null;
    },
    get optionsOpened(): number {
      return optionsOpened;
    },
    get createdTabs(): ATNamespace[] {
      return createdTabs;
    },
    types: () => sends.map((message) => message.type as string),
    status: () => ({ text: fields.status.textContent, kind: fields.status.dataset.kind }),
    localStatus: () => ({
      text: fields.localStatus.textContent,
      kind: fields.localStatus.dataset.kind,
      hidden: fields.localStatus.hidden
    }),
    failStorage: (reason = 'storage is unavailable') => {
      storageFailure = reason;
    },
    boot: async () => {
      for (const listener of documentEvents['DOMContentLoaded'] ?? []) await listener({});
      await flush();
    },
    flip: (checked: boolean) => {
      fields.enabled.checked = checked;
      return run('enabled', 'change');
    },
    choose: (id: 'targetLang', value: string) => {
      fields[id].value = value;
      return run(id, 'change');
    },
    click: (id: 'options') => run(id, 'click'),
    fire: dispatch
  };
}

/** `AT.warn` would otherwise print failure noise into the reporter. */
const warnings: unknown[][] = [];
const consoleWarn = console.warn;
console.warn = (...args: unknown[]) => {
  warnings.push(args);
};
test.after(() => {
  console.warn = consoleWarn;
});

/** Runs `body` while catching rejections nothing awaited. */
async function watchingRejections(body: () => Promise<void>): Promise<unknown[]> {
  const rejections: unknown[] = [];
  const record = (reason: unknown) => {
    rejections.push(reason);
  };
  process.on('unhandledRejection', record);
  try {
    await body();
    await yielded(setImmediate);
    return rejections;
  } finally {
    process.off('unhandledRejection', record);
  }
}

// --- boot --------------------------------------------------------------------

test('boot asks the background once for state and renders a translated tab', async () => {
  const h = environment({
    stored: { enabled: true, targetLang: 'ko' },
    state: stateOf({ state: { status: 'translated', translated: 12, error: null, targetLang: 'ko' } })
  });
  await h.boot();

  assert.deepEqual(h.types(), ['at/get-state']);
  assert.deepEqual(h.statesSent[0], { type: 'at/get-state' });
  assert.deepEqual(h.status(), { text: 'popup_translated:12', kind: 'ok' });
  assert.equal(h.fields.host.textContent, 'example.com');
  assert.equal(h.fields.enabled.checked, true);
  assert.equal(h.fields.targetLang.disabled, false);
  // The language list comes from the constants, with the stored code selected.
  assert.equal(h.fields.targetLang.value, 'ko');
  assert.equal(h.fields.targetLang.options.length, h.AT.C.LANGS.length);
  assert.deepEqual(h.fields.targetLang.options[0], { tagName: 'option', value: 'en', textContent: 'English (en)' });
});

test('an idle tab renders the idle status with the switch on and the language select live', async () => {
  const h = environment({ stored: { enabled: true, targetLang: 'de' } });
  await h.boot();

  assert.deepEqual(h.status(), { text: 'popup_idle', kind: 'info' });
  assert.equal(h.fields.enabled.checked, true);
  assert.equal(h.fields.targetLang.disabled, false);
  assert.equal(h.fields.targetLang.value, 'de');
});

test('a tab the background cannot inject into disables the language select but not the switch', async () => {
  const h = environment({
    state: stateOf({
      tab: { id: 3, url: 'chrome://extensions', title: null, host: null },
      canTranslate: false
    })
  });
  await h.boot();

  assert.deepEqual(h.status(), { text: 'popup_unavailable', kind: 'warn' });
  assert.equal(h.fields.targetLang.disabled, true);
  // The switch is the global setting, so it stays operable on any tab.
  assert.equal(h.fields.enabled.disabled, false);
  // No host was derived, so the line falls back to the raw url.
  assert.equal(h.fields.host.textContent, 'chrome://extensions');
});

test('no active tab at all leaves the popup unavailable', async () => {
  const h = environment({ state: stateOf({ tab: null, canTranslate: false, state: null }) });
  await h.boot();

  assert.deepEqual(h.status(), { text: 'popup_unavailable', kind: 'warn' });
  assert.equal(h.fields.host.textContent, '');
  assert.equal(h.fields.targetLang.disabled, true);
});

test('a master switch of off names the reason nothing translates', async () => {
  const h = environment({ stored: { enabled: false } });
  await h.boot();

  assert.deepEqual(h.status(), { text: 'popup_disabled', kind: 'warn' });
  assert.equal(h.fields.enabled.checked, false);
});

test('a fresh profile starts switched off', async () => {
  const h = environment();
  await h.boot();

  assert.equal(h.fields.enabled.checked, false);
  assert.deepEqual(h.status(), { text: 'popup_disabled', kind: 'warn' });
});

test('a content-script error is shown verbatim as the status', async () => {
  const h = environment({
    stored: { enabled: true },
    state: stateOf({ state: { status: 'error', translated: 0, error: 'provider quota exceeded', targetLang: null } })
  });
  await h.boot();

  assert.deepEqual(h.status(), { text: 'provider quota exceeded', kind: 'error' });
});

test('a refused get-state leaves the fields untouched and names the error', async () => {
  const h = environment({ script: { 'at/get-state': { ok: false, error: 'no such tab' } } });
  await h.boot();

  assert.deepEqual(h.status(), { text: 'no such tab', kind: 'error' });
  // render() never ran: nothing was written to the fields.
  assert.equal(h.fields.host.textContent, '');
  assert.equal(h.fields.targetLang.options.length, 0);
  assert.equal(h.fields.enabled.checked, false);
});

// --- on-device engine ------------------------------------------------------

test('the on-device line names the resident model when one is selected', async () => {
  const h = environment({
    stored: { enabled: true, targetLang: 'ko', localModelId: 'gemma-task' },
    state: stateOf({
      local: { supported: true, status: { state: 'ready', modelName: 'TranslateGemma 4B', loadedBytes: 4096, loadMs: 1200 } }
    })
  });
  await h.boot();

  // describeStatus() owns the wording: the ready label, the model name, then the load time.
  assert.deepEqual(h.localStatus(), {
    text: 'options_stateReady · TranslateGemma 4B (1200 ms)',
    kind: 'info',
    hidden: false
  });
  // The regular status line keeps reporting the tab, not the model.
  assert.deepEqual(h.status(), { text: 'popup_idle', kind: 'info' });
});

test('with no model selected the line points at Options instead of claiming readiness', async () => {
  const h = environment({
    stored: { enabled: true, targetLang: 'ko' },
    state: stateOf({ local: { supported: true, status: { state: 'unloaded' } } })
  });
  await h.boot();

  // The engine is the default now, so the first thing a new user sees has to be
  // the one step that makes it work.
  assert.deepEqual(h.localStatus(), { text: 'popup_localNoModel', kind: 'warn', hidden: false });
});

test('a browser that cannot run the model still shows the line, as a warning', async () => {
  const h = environment({
    stored: { enabled: true },
    state: stateOf({ local: { supported: false, status: { state: 'error', lastError: 'no webgpu' } } })
  });
  await h.boot();

  assert.deepEqual(h.localStatus(), { text: 'options_localUnsupported', kind: 'warn', hidden: false });
});

test('an unchecked language pair says so instead of looking fine', async () => {
  const h = environment({
    stored: { enabled: true, sourceLang: 'de', targetLang: 'ko', localModelId: 'gemma-task' },
    state: stateOf({
      local: { supported: true, status: { state: 'ready', modelName: 'TranslateGemma 4B', loadedBytes: 4096, loadMs: 1200 } }
    })
  });
  await h.boot();

  // The same model, the same ready state: only the pair is unknown, and the
  // line has to carry that instead of implying a checked claim.
  assert.deepEqual(h.localStatus(), {
    text: 'options_stateReady · TranslateGemma 4B (1200 ms) · popup_localUnverified',
    kind: 'warn',
    hidden: false
  });
});

test('an unsupported browser gets one problem, not two', async () => {
  const h = environment({
    stored: { enabled: true, sourceLang: 'de', targetLang: 'pl' },
    state: stateOf({ local: { supported: false, status: { state: 'error', lastError: 'no webgpu' } } })
  });
  await h.boot();

  assert.deepEqual(h.localStatus(), { text: 'options_localUnsupported', kind: 'warn', hidden: false });
});

// --- the switch acts on the active tab ---------------------------------------

test('switching on saves enabled and translates the active tab', async () => {
  const h = environment({ stored: { enabled: false, targetLang: 'ja' } });
  await h.boot();
  await h.flip(true);

  assert.deepEqual(h.sends[1], { type: 'at/set-settings', patch: { enabled: true } });
  assert.deepEqual(h.sends[2], { type: 'at/translate-tab', tabId: TAB.id });
  assert.deepEqual(h.types(), ['at/get-state', 'at/set-settings', 'at/translate-tab', 'at/get-state']);
  assert.equal(h.stored?.enabled, true);
  assert.equal(h.fields.enabled.checked, true);
});

test('switching off saves enabled and restores the active tab', async () => {
  const h = environment({
    stored: { enabled: true, targetLang: 'ko' },
    state: stateOf({ state: { status: 'translated', translated: 9, error: null, targetLang: 'ko' } })
  });
  await h.boot();
  await h.flip(false);

  assert.deepEqual(h.sends[1], { type: 'at/set-settings', patch: { enabled: false } });
  assert.deepEqual(h.sends[2], { type: 'at/restore-tab', tabId: TAB.id });
  assert.deepEqual(h.types(), ['at/get-state', 'at/set-settings', 'at/restore-tab', 'at/get-state']);
  assert.equal(h.stored?.enabled, false);
  // The re-render reports the stored setting, not the page state.
  assert.deepEqual(h.status(), { text: 'popup_disabled', kind: 'warn' });
});

test('the switch sends no action when the tab cannot be injected into', async () => {
  const h = environment({
    stored: { enabled: false, targetLang: 'ko' },
    state: stateOf({ tab: { id: 3, url: 'chrome://extensions', title: null, host: null }, canTranslate: false })
  });
  await h.boot();
  await h.flip(true);

  assert.deepEqual(h.types(), ['at/get-state', 'at/set-settings', 'at/get-state']);
  assert.ok(!h.types().includes('at/translate-tab'));
  // The setting is global, so it is still saved.
  assert.equal(h.stored?.enabled, true);
});

test('an action for a tab the background did not identify omits its id', async () => {
  const h = environment({
    stored: { enabled: false, targetLang: 'ko' },
    state: stateOf({ tab: { url: 'https://example.com/plain', title: null, host: 'example.com' } })
  });
  await h.boot();
  await h.flip(true);

  const message = h.sends[2];
  assert.equal(message?.type, 'at/translate-tab');
  assert.ok(!('tabId' in (message ?? {})) || message.tabId === undefined);
});

// --- master switch -----------------------------------------------------------

test('the master switch patches the settings it read and re-renders from them', async () => {
  const h = environment({
    stored: { enabled: true, targetLang: 'ko' },
    state: stateOf({ state: { status: 'translated', translated: 3, error: null, targetLang: 'ko' } })
  });
  await h.boot();
  await h.flip(false);

  assert.deepEqual(h.sends[1], { type: 'at/set-settings', patch: { enabled: false } });
  assert.deepEqual(h.sends[2], { type: 'at/restore-tab', tabId: TAB.id });
  assert.deepEqual(h.types(), ['at/get-state', 'at/set-settings', 'at/restore-tab', 'at/get-state']);
  assert.equal(h.stored?.enabled, false);
  // The render after the patch reflects the settings the background kept.
  assert.equal(h.fields.enabled.checked, false);
  assert.deepEqual(h.status(), { text: 'popup_disabled', kind: 'warn' });
});

test('the checkbox follows the background snapshot, not the value the control holds', async () => {
  // The control flipped to checked, but the reply (and storage) still say
  // disabled: the following render must not keep the optimistic value.
  const h = environment({
    stored: { enabled: false, targetLang: 'ko' },
    script: { 'at/set-settings': { ok: true, settings: { enabled: true, targetLang: 'ko' } } }
  });
  await h.boot();
  assert.equal(h.fields.enabled.checked, false);

  await h.flip(true);

  assert.deepEqual(h.sends[1], { type: 'at/set-settings', patch: { enabled: true } });
  // The action still follows the switch that was flipped.
  assert.deepEqual(h.sends[2], { type: 'at/translate-tab', tabId: TAB.id });
  assert.equal(h.fields.enabled.checked, false);
  assert.deepEqual(h.status(), { text: 'popup_disabled', kind: 'warn' });
});

test('a refused settings patch is re-rendered over by the following state', async () => {
  const h = environment({
    stored: { enabled: true },
    script: { 'at/set-settings': { ok: false, error: 'settings are locked' } }
  });
  await h.boot();
  await h.flip(false);

  assert.deepEqual(h.sends[1], { type: 'at/set-settings', patch: { enabled: false } });
  assert.deepEqual(h.sends[2], { type: 'at/restore-tab', tabId: TAB.id });
  assert.deepEqual(h.types(), ['at/get-state', 'at/set-settings', 'at/restore-tab', 'at/get-state']);
  // patchSettings() reported the refusal, then the handler re-rendered and
  // render() overwrote the status with what storage still says: enabled.
  assert.deepEqual(h.status(), { text: 'popup_idle', kind: 'info' });
  assert.equal(h.fields.enabled.checked, true);
});

// --- target language ---------------------------------------------------------

test('the target language patch re-triggers translation on a translated tab', async () => {
  const h = environment({
    stored: { enabled: true, targetLang: 'ko' },
    state: stateOf({ state: { status: 'translated', translated: 7, error: null, targetLang: 'ko' } })
  });
  await h.boot();
  await h.choose('targetLang', 'ja');

  assert.deepEqual(h.types(), ['at/get-state', 'at/set-settings', 'at/translate-tab', 'at/get-state']);
  assert.deepEqual(h.sends[1], { type: 'at/set-settings', patch: { targetLang: 'ja' } });
  assert.equal(h.sends[2]?.tabId, TAB.id);
  assert.equal(h.stored?.targetLang, 'ja');
  assert.equal(h.fields.targetLang.value, 'ja');
});

test('the target language patch leaves an untranslated tab alone', async () => {
  const h = environment({ stored: { enabled: true, targetLang: 'en' } });
  await h.boot();
  await h.choose('targetLang', 'fr');

  assert.deepEqual(h.types(), ['at/get-state', 'at/set-settings', 'at/get-state']);
  assert.ok(!h.types().includes('at/translate-tab'));
  assert.equal(h.stored?.targetLang, 'fr');
  assert.deepEqual(h.status(), { text: 'popup_idle', kind: 'info' });
});

test('a tab reported translated with nothing translated is still re-translated', async () => {
  // render() calls a page translated only when `translated > 0`, while the
  // change handler looks at `status` alone.
  const h = environment({
    stored: { enabled: true, targetLang: 'ko' },
    state: stateOf({ state: { status: 'translated', translated: 0, error: null, targetLang: 'ko' } })
  });
  await h.boot();
  assert.deepEqual(h.status(), { text: 'popup_idle', kind: 'info' });

  await h.choose('targetLang', 'de');

  assert.ok(h.types().includes('at/translate-tab'));
});

// --- options button ----------------------------------------------------------

test('the settings button opens the options page on a profile that has a model', async () => {
  const h = environment({ stored: { enabled: true, localModelId: 'model-a' } });
  await h.boot();
  await h.click('options');

  assert.equal(h.optionsOpened, 1);
  assert.deepEqual(h.createdTabs, [], 'a set-up profile goes to the settings page, not the setup flow');
  assert.deepEqual(h.types(), ['at/get-state'], 'no message is needed for a page that is not the background');
});

test('the settings button opens the setup flow while no model is installed', async () => {
  // The onboarding page is the useful destination, and a click is a gesture, so
  // the browser may dock it as a side panel.
  const h = environment();
  await h.boot();
  await h.click('options');

  assert.equal(h.optionsOpened, 0, 'there is nothing to configure yet');
  assert.deepEqual(
    h.createdTabs,
    [{ url: 'chrome-extension://test/welcome.html', active: true }],
    'the setup flow opens; without the side panel API it is a tab'
  );
});

// --- failure paths -----------------------------------------------------------

test('a background that answers with nothing surfaces as a status, not a crash', async () => {
  const h = environment({ script: { 'at/get-state': undefined } });
  const rejections = await watchingRejections(() => h.boot());

  assert.deepEqual(h.status(), { text: 'no listener answered at/get-state', kind: 'error' });
  assert.deepEqual(h.types(), ['at/get-state']);
  assert.equal(h.fields.host.textContent, '');
  assert.deepEqual(rejections, []);
});

test('a failing action is reported before the following render replaces it', async () => {
  const state = stateOf();
  const reported: string[] = [];
  const h = environment({
    state,
    script: {
      'at/translate-tab': undefined,
      'at/get-state': () => {
        reported.push(`${h.fields.status.textContent}|${h.fields.status.dataset.kind}`);
        return { ok: true, ...state };
      }
    }
  });
  await h.boot();
  const rejections = await watchingRejections(async () => {
    await h.flip(true);
  });

  // The failure reaches the status line...
  assert.equal(reported[1], 'no listener answered at/translate-tab|error');
  // ...and is then overwritten by render(), which knows nothing about it.
  assert.deepEqual(h.status(), { text: 'popup_idle', kind: 'info' });
  assert.deepEqual(rejections, []);
});

test('a storage read that rejects is reported once and leaks nothing', async () => {
  const h = environment({ storageFails: true });
  warnings.length = 0;
  const rejections = await watchingRejections(() => h.boot());

  assert.deepEqual(h.status(), { text: 'storage is unavailable', kind: 'error' });
  assert.deepEqual(h.types(), ['at/get-state']);
  // AT.warn prefixes its tag, so the popup's own label is the second argument.
  assert.deepEqual(warnings[0]?.slice(0, 2), ['[autotranslate]', 'popup refresh failed']);
  assert.match(String(warnings[0]?.[2]), /storage is unavailable/);
  assert.deepEqual(rejections, []);
});

test('a click whose storage read rejects reaches no handler: the click chain has no catch', async () => {
  const h = environment();
  await h.boot();
  h.failStorage();

  const pending = h.fire('targetLang', 'change', { target: h.fields.targetLang });
  await assert.rejects(() => Promise.all(pending), /storage is unavailable/);
});
