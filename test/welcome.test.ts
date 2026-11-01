import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SRC, load, resetGlobals, deferred, type ATNamespace } from './helpers.ts';

// welcome.html is a classic script page: constants + browser + local +
// modelstore + modelflow + settings, then welcome.js. The pure data modules are
// real; the three modules the page calls into (modelstore, modelflow, settings)
// plus the message channel are stubs, so a test scripts the transfer instead of
// streaming gigabytes through a fake IndexedDB.
const LIBS = ['lib/constants.js', 'lib/local.js'];

const host = globalThis as ATNamespace;

// The real English catalogue, so assertions read the rendered strings the user
// sees and `$1$`/`$2$` substitution is exercised for real.
const CATALOGUE = JSON.parse(readFileSync(join(SRC, '_locales', 'en', 'messages.json'), 'utf8')) as {
  [key: string]: { message: string };
};

/** Chrome's substitution rules: `$1$`..`$9$` from `subs`, `$$` is a literal `$`. */
function getMessage(key: string | undefined, subs?: string | string[]): string | undefined {
  const entry = key === undefined ? undefined : CATALOGUE[key];
  if (!entry) return undefined;
  const list = subs === undefined ? [] : Array.isArray(subs) ? subs : [subs];
  return entry.message.replace(/\$(\d+)\$|\$\$/g, (match, digit: string | undefined) =>
    digit === undefined ? '$' : list[Number(digit) - 1] ?? match
  );
}

const msg = (key: string, subs?: string | string[]): string => getMessage(key, subs) ?? `[${key}]`;

// --- DOM stand-in -----------------------------------------------------------
// welcome.js only touches getElementById / createElement / replaceChildren /
// addEventListener / click plus value, hidden, disabled, max, files,
// textContent and dataset, so a hand-rolled tree is enough to inspect what the
// page rendered without pulling in a DOM dependency.

type Listener = (...args: unknown[]) => unknown;

/** The one `File` member the page reads when a local model is picked. */
type StubFile = { name: string; size: number };

type Stub = {
  tagName: string;
  id: string;
  value: string | number;
  checked: boolean;
  hidden: boolean;
  disabled: boolean;
  /** `<progress max>`; the page assigns bytes, not percentages. */
  max: number;
  /** `<input type=file>`: the page only ever looks at the first entry. */
  files: StubFile[] | null;
  type: string;
  textContent: string;
  dataset: Record<string, string | undefined>;
  children: Stub[];
  listeners: Record<string, Listener[]>;
  /** How often the page called `click()` on this node. */
  clicks: number;
  addEventListener(type: string, fn: Listener): void;
  click(): void;
  replaceChildren(...children: Stub[]): void;
};

function makeEl(tagName: string, id = ''): Stub {
  const node: Stub = {
    tagName: tagName.toUpperCase(),
    id,
    value: '',
    checked: false,
    hidden: false,
    disabled: false,
    max: 0,
    files: null,
    type: '',
    textContent: '',
    dataset: {},
    children: [],
    listeners: {},
    clicks: 0,
    addEventListener(type, fn) {
      (node.listeners[type] ??= []).push(fn);
    },
    click() {
      node.clicks += 1;
      for (const fn of [...(node.listeners.click ?? [])]) fn({ type: 'click' });
    },
    replaceChildren(...children) {
      node.children = [...children];
    }
  };
  return node;
}

type StubDocument = {
  fields: Record<string, Stub>;
  body: Stub;
  listeners: Record<string, Listener[]>;
  createElement(tagName: string): Stub;
  getElementById(id: string): Stub | undefined;
  addEventListener(type: string, fn: Listener): void;
};

// The ids welcome.html carries, in markup order.
const FIELDS: readonly (readonly [string, string])[] = [
  ['targetLang', 'select'],
  ['support', 'p'],
  ['installed', 'p'],
  ['download', 'button'],
  ['cancel', 'button'],
  ['pick', 'button'],
  ['modelFile', 'input'],
  ['modelToken', 'input'],
  ['progress', 'progress'],
  ['status', 'p'],
  ['start', 'button'],
  ['options', 'button']
];

/** welcome.html ships these with the `hidden` attribute. */
const HIDDEN_AT_BOOT: Record<string, true | undefined> = {
  support: true,
  installed: true,
  cancel: true,
  modelFile: true,
  progress: true
};

function makeDocument(): StubDocument {
  const fields: Record<string, Stub> = {};
  for (const [id, tag] of FIELDS) {
    const node = makeEl(tag, id);
    if (HIDDEN_AT_BOOT[id] === true) node.hidden = true;
    fields[id] = node;
  }
  // welcome.html writes `disabled` on the start button.
  fields.start!.disabled = true;
  const doc: StubDocument = {
    fields,
    body: makeEl('body'),
    listeners: {},
    createElement: (tagName) => makeEl(tagName),
    getElementById: (id) => fields[id],
    addEventListener(type, fn) {
      (doc.listeners[type] ??= []).push(fn);
    }
  };
  return doc;
}

/**
 * Lets a chain the page started without awaiting (`void download()`) land:
 * `setImmediate` only runs once the microtask queue has drained.
 */
const idle = (): Promise<void> => {
  const { promise, resolve } = deferred<void>();
  setImmediate(() => setImmediate(resolve));
  return promise;
};

async function fire(node: Stub, type: string): Promise<void> {
  for (const fn of [...(node.listeners[type] ?? [])]) fn({ type });
  await idle();
}

const click = (node: Stub): Promise<void> => fire(node, 'click');

// --- model stand-ins --------------------------------------------------------

/** The record the page names in `welcome_modelReady` and saves as `localModelId`. */
const MODEL = { id: 'translategemma-4b-it-int8-web-a1b2c3', name: 'translategemma.task', size: 2048 };

/** A transfer result, as `AT.modelflow.Outcome` shapes it. */
const outcome = (over: ATNamespace = {}): ATNamespace => ({
  ok: true,
  stored: true,
  retired: [],
  modelId: MODEL.id,
  name: MODEL.name,
  bytes: MODEL.size,
  seconds: 4,
  error: null,
  ...over
});

type BootOptions = {
  /** The settings blob the page loads. */
  settings?: ATNamespace;
  /** The Hugging Face token the fake blob store holds. */
  token?: string;
  /** What `at/local-get-status` answers. */
  supported?: boolean;
  /** The model `AT.modelflow.installed()` reports, if any. */
  installed?: ATNamespace | null;
  /** What loading the installed model answers. */
  prepare?: { ok: boolean; error: string | null };
  /** Progress samples the fake URL transfer reports before it returns. */
  progress?: (readonly [number, number | null])[];
  /** The outcome the URL transfer answers with. */
  urlOutcome?: ATNamespace;
  /** Replace the URL transfer itself (used to hold it open and abort it). */
  installUrl?: (install: ATNamespace) => Promise<ATNamespace>;
  /** The outcome the file import answers with. */
  fileOutcome?: ATNamespace;
};

/**
 * Boots the welcome page the way the browser does: the stub document on
 * `globalThis`, the shared data libs as classic scripts, stubbed collaborators,
 * welcome.js, then the DOMContentLoaded event the controller waits for.
 */
async function boot(options: BootOptions = {}) {
  resetGlobals();

  const doc = makeDocument();
  host.document = doc;

  const stored: ATNamespace = { enabled: false, targetLang: 'en', ...(options.settings ?? {}) };
  const records = new Map<string, ATNamespace>([[String(MODEL.id), { ...MODEL }]]);
  if (options.installed) records.set(String(options.installed.id), options.installed);

  const calls = {
    messages: [] as ATNamespace[],
    tokens: [] as string[],
    prepare: [] as string[],
    saves: [] as ATNamespace[],
    installs: [] as ATNamespace[],
    files: [] as unknown[],
    warnings: [] as unknown[],
    applied: [] as unknown[],
    opens: 0,
    closed: 0
  };
  /** The progress bar and status as the transfer reported each sample. */
  const samples: ATNamespace[] = [];

  const AT = load(...LIBS);

  const field = (id: string): Stub => {
    const node = doc.getElementById(id);
    if (!node) throw new Error(`welcome.html has no #${id}`);
    return node;
  };

  AT.modelstore = {
    get: async (id: string) => records.get(String(id)) ?? null,
    fits: async () => true,
    getToken: async () => options.token ?? '',
    setToken: async (token: string) => {
      calls.tokens.push(token);
    }
  };

  AT.modelflow = {
    SOURCE: { url: 'https://models.example.test/translategemma.task', size: MODEL.size },
    installed: async () => options.installed ?? null,
    prepare: async (id: string) => {
      calls.prepare.push(id);
      return options.prepare ?? { ok: true, error: null };
    },
    installFromUrl: async (install: ATNamespace) => {
      calls.installs.push(install);
      if (options.installUrl) return await options.installUrl(install);
      for (const [received, total] of options.progress ?? []) {
        (install.onProgress as ((a: number, b: number | null) => void) | undefined)?.(received, total);
        samples.push({
          value: field('progress').value,
          max: field('progress').max,
          hidden: field('progress').hidden,
          status: field('status').textContent
        });
      }
      return options.urlOutcome ?? outcome();
    },
    installFromFile: async (file: unknown) => {
      calls.files.push(file);
      return options.fileOutcome ?? outcome();
    }
  };

  AT.settings = {
    load: async () => ({ ...stored }),
    save: async (patch: ATNamespace) => {
      calls.saves.push({ ...patch });
      Object.assign(stored, patch);
      return { ...stored };
    }
  };

  AT.sendMessage = async (message: ATNamespace) => {
    calls.messages.push({ ...message });
    return { ok: true, supported: options.supported !== false };
  };

  AT.i18n = {
    apply: (root: unknown) => {
      calls.applied.push(root);
    },
    msg: (key: string, subs?: string | string[]) => msg(key, subs)
  };

  AT.warn = (...args: unknown[]) => {
    calls.warnings.push(args);
  };

  AT.api = {
    runtime: {
      openOptionsPage: async () => {
        calls.opens += 1;
      }
    }
  };

  host.window = {
    close: () => {
      calls.closed += 1;
    }
  };

  load('welcome.js');

  for (const fn of [...(doc.listeners.DOMContentLoaded ?? [])]) await fn({ type: 'DOMContentLoaded' });
  await idle();

  return { AT, doc, field, calls, samples, stored };
}

test('boot offers both install routes and asks for a model', async () => {
  const env = await boot({ token: 'hf-token' });
  const { field, calls } = env;

  assert.equal(field('status').textContent, msg('welcome_needModel'));
  assert.equal(field('status').dataset.kind, 'info');
  assert.equal(field('installed').hidden, true);
  assert.equal(field('support').hidden, true);
  assert.equal(field('download').disabled, false);
  assert.equal(field('pick').disabled, false);
  assert.equal(field('start').disabled, true);
  assert.equal(field('cancel').hidden, true);
  assert.equal(field('progress').hidden, true);

  // The language select is filled from the catalogue and follows settings.
  assert.equal(field('targetLang').children.length, env.AT.C.LANGS.length);
  assert.equal(field('targetLang').children[0]!.value, env.AT.C.LANGS[0].code);
  assert.equal(field('targetLang').value, 'en');
  assert.equal(field('modelToken').value, 'hf-token');

  // The page asked the host whether the model can run here, and looked for an
  // installed model without preparing one.
  assert.deepEqual(calls.messages, [{ type: env.AT.C.MSG.LOCAL_GET_STATUS }]);
  assert.deepEqual(calls.prepare, []);
  assert.equal(calls.applied[0], env.doc);
  assert.deepEqual(calls.saves, []);
  assert.equal(env.doc.body.dataset.done, undefined);
});

test('a successful download paints progress, arms start and saves the model', async () => {
  const env = await boot({
    settings: { targetLang: 'de' },
    token: 'hf-token',
    progress: [
      [512, 1024],
      [1024, 1024]
    ]
  });
  const { field, calls } = env;

  await click(field('download'));

  // Both progress samples reached the bar and the status line.
  assert.equal(env.samples.length, 2);
  assert.deepEqual(env.samples[0], {
    value: 512,
    max: 1024,
    hidden: false,
    status: msg('options_downloading', ['512 B', '1.0 KiB'])
  });
  assert.deepEqual(env.samples[1], {
    value: 1024,
    max: 1024,
    hidden: false,
    status: msg('options_downloading', ['1.0 KiB', '1.0 KiB'])
  });

  // The token was stored and handed to the transfer.
  assert.deepEqual(calls.tokens, ['hf-token']);
  assert.equal(calls.installs.length, 1);
  assert.equal(calls.installs[0]!.token, 'hf-token');

  assert.equal(field('progress').hidden, true);
  assert.equal(field('cancel').hidden, true);
  assert.equal(field('installed').hidden, false);
  assert.equal(field('installed').textContent, msg('welcome_modelReady', [MODEL.name, '2.0 KiB']));
  assert.equal(field('start').disabled, false);
  assert.equal(field('start').dataset.blocked, 'false');
  const status = field('status').textContent;
  assert.ok(status.includes(MODEL.name), `status should name the model: ${status}`);
  assert.equal(status, msg('options_downloadDone', [MODEL.name, '2.0 KiB', '4']));

  await click(field('start'));

  // The transfer selects the model it just installed, then Start turns the
  // extension on with the language the user picked.
  assert.deepEqual(calls.saves, [
    { localModelId: MODEL.id },
    { enabled: false, localModelId: MODEL.id, targetLang: 'de' }
  ]);
  assert.equal(env.doc.body.dataset.done, 'true');
  assert.equal(field('start').hidden, true);
  assert.equal(field('start').disabled, true);
  assert.equal(field('download').disabled, true);
  assert.equal(field('pick').disabled, true);
  assert.equal(field('status').textContent, msg('welcome_done'));
  assert.equal(calls.closed, 1);
});

test('a gated download reports the missing token and leaves start disabled', async () => {
  const env = await boot({
    urlOutcome: outcome({ ok: false, modelId: '', name: '', bytes: 0, seconds: 1, error: 'needs-token' })
  });
  const { field } = env;

  await click(field('download'));

  assert.equal(field('status').textContent, msg('options_needsToken'));
  assert.equal(field('status').dataset.kind, 'error');
  assert.equal(field('start').disabled, true);
  assert.equal(field('installed').hidden, true);
  assert.equal(field('installed').textContent, '');
  assert.equal(field('progress').hidden, true);
  assert.equal(field('cancel').hidden, true);
  assert.deepEqual(env.calls.saves, []);
});

test('cancel aborts the signal the transfer was given', async () => {
  const gate = deferred<ATNamespace>();
  const env = await boot({
    installUrl: async (install) => {
      (install.signal as AbortSignal).addEventListener('abort', () => {
        gate.resolve(outcome({ ok: false, modelId: '', name: '', bytes: 0, seconds: 1, error: 'cancelled' }));
      });
      return await gate.promise;
    }
  });
  const { field, calls } = env;

  // The transfer is held open; the page is busy and offers cancel.
  await click(field('download'));
  assert.equal(calls.installs.length, 1);
  const signal = calls.installs[0]!.signal as AbortSignal;
  assert.equal(signal.aborted, false);
  assert.equal(field('cancel').hidden, false);
  assert.equal(field('download').disabled, true);
  assert.equal(field('pick').disabled, true);

  await click(field('cancel'));
  await idle();

  assert.equal(signal.aborted, true);
  assert.equal(field('status').textContent, msg('options_cancelled'));
  assert.equal(field('start').disabled, true);
  assert.equal(field('cancel').hidden, true);
  assert.equal(field('progress').hidden, true);
});

test('picking a model file imports exactly the chosen file and arms start', async () => {
  const env = await boot();
  const { field, calls } = env;
  const file: StubFile = { name: 'translategemma-local.task', size: 4096 };

  await click(field('pick'));
  assert.equal(field('modelFile').clicks, 1);

  field('modelFile').files = [file];
  await fire(field('modelFile'), 'change');

  assert.equal(calls.files.length, 1);
  assert.equal(calls.files[0], file);
  assert.equal(field('modelFile').value, '');
  assert.equal(field('installed').textContent, msg('welcome_modelReady', [MODEL.name, '2.0 KiB']));
  assert.equal(field('start').disabled, false);
  assert.equal(field('progress').hidden, true);
  assert.equal(field('status').textContent, msg('options_downloadDone', [MODEL.name, '2.0 KiB', '4']));
});

test('an already installed model is prepared once and needs only a start', async () => {
  const env = await boot({ installed: { ...MODEL }, prepare: { ok: true, error: null } });
  const { field, calls } = env;

  assert.deepEqual(calls.prepare, [MODEL.id]);
  assert.equal(field('status').textContent, msg('welcome_readyExisting'));
  assert.equal(field('status').dataset.kind, 'ok');
  assert.equal(field('installed').hidden, false);
  assert.equal(field('installed').textContent, msg('welcome_modelReady', [MODEL.name, '2.0 KiB']));
  assert.equal(field('start').disabled, false);
  // A different model is still allowed: the download stays available.
  assert.equal(field('download').disabled, false);
  assert.equal(field('pick').disabled, false);
  assert.deepEqual(calls.installs, []);
});

test('an unsupported host says so and disables the download', async () => {
  const env = await boot({ supported: false });
  const { field } = env;

  assert.equal(field('support').hidden, false);
  assert.equal(field('support').textContent, msg('options_localUnsupported'));
  assert.equal(field('download').disabled, true);
  assert.equal(field('download').dataset.blocked, 'true');
  // Picking a file is still offered, and nothing is installed yet.
  assert.equal(field('pick').disabled, false);
  assert.equal(field('status').textContent, msg('welcome_needModel'));
});
