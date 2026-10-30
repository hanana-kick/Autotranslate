import assert from 'node:assert/strict';
import test from 'node:test';
import { load, resetGlobals, type ATNamespace } from './helpers.ts';

// The content script is the page-context half: it owns a DOM, a MutationObserver
// and a floating card, all of which the test has to stand in for. Like the rest
// of the suite this file stays DOM-free and stubs what the script touches:
// document.documentElement / document.body / document.createElement,
// MutationObserver and getSelection.

const FILES = [
  'lib/constants.js',
  'lib/browser.js',
  'lib/pagecontext.js',
  'lib/targets.js',
  'lib/pipeline.js',
  'lib/dom.js',
  'content.js'
];
const DEFAULT_TEXTS = ['Hello there', 'Good morning'];

const host = globalThis as ATNamespace;

/** The channel resolves with `undefined` when no listener claims the message. */
const silence = undefined as unknown as ATNamespace;

/**
 * Let a chain the script started without us land. `setImmediate` is a queue hop
 * in the check phase, not a guessed duration: every pending microtask, and
 * every microtask those queue, runs before the callback does.
 */
const drain = () => new Promise<void>((resolve) => { setImmediate(resolve); });

const wrap = (texts: string[]) => texts.map((text) => `»${text}«`);

type Listener = (...args: unknown[]) => unknown;
type MessageListener = (message: ATNamespace, sender: ATNamespace, respond: (payload: unknown) => void) => unknown;

// --- page stand-in ----------------------------------------------------------

type StubText = {
  nodeType: 3;
  nodeValue: string;
  parentElement: StubElement | null;
  childNodes?: StubNode[];
};

type StubElement = {
  nodeType: 1;
  tagName: string;
  childNodes: StubNode[];
  parentElement: StubElement | null;
  attrs: Record<string, string>;
  classes: string[];
  isContentEditable: boolean;
  /** Present because a page element has one; the card is styled through the attribute. */
  style: Record<string, string>;
  listeners: Record<string, Listener[]>;
  lang: string;
  /** Assigned by the card, or the concatenated text of the children. */
  readonly textContent: string;
  type: string;
  closest: (matcher: string) => StubNode | null;
  contains: (other: StubNode) => boolean;
  appendChild: (child: StubNode) => StubNode;
  append: (...children: StubNode[]) => void;
  remove: () => void;
  setAttribute: (name: string, value: string) => void;
  getAttribute: (name: string) => string | null;
  getBoundingClientRect: () => { top: number; bottom: number; width: number; height: number };
  addEventListener: (type: string, listener: Listener) => void;
  click: () => void;
  querySelectorAll: (selector: string) => StubElement[];
};

type StubNode = StubText | StubElement;

type StubProps = { attrs?: Record<string, string>; classes?: string[]; editable?: boolean; lang?: string };

/** Only the selector shapes IGNORE_SELECTOR and the editable selector use. */
function matches(element: StubElement, selector: string) {
  if (selector.startsWith('.')) return element.classes.includes(selector.slice(1));
  const attribute = /^\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]$/.exec(selector);
  if (attribute) {
    const [, name, value] = attribute;
    if (!(name! in element.attrs)) return false;
    return value === undefined || String(element.attrs[name!]) === value;
  }
  return element.tagName === selector.toUpperCase();
}

function t(value: string): StubText {
  return { nodeType: 3, nodeValue: value, parentElement: null };
}

function textNodes(node: StubNode, out: StubText[] = []) {
  for (const child of node.childNodes ?? []) {
    if (child.nodeType === 3) out.push(child);
    else textNodes(child, out);
  }
  return out;
}

/** The text the reader would see, in document order: what "untouched" is compared against. */
function pageTexts(node: StubNode) {
  return textNodes(node).map((child) => child.nodeValue);
}

function makeElement(tag: string, props: StubProps, removed: StubElement[]): StubElement {
  const { attrs = {}, classes = [], editable = false, lang = '' } = props;
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    childNodes: [],
    parentElement: null,
    attrs,
    classes,
    isContentEditable: editable,
    style: {},
    listeners: {},
    lang,
    type: ''
  } as unknown as StubElement;
  // A real element derives textContent from its children until someone assigns
  // it. The detector samples `document.body.textContent`, so the stub has to.
  let ownText: string | null = null;
  Object.defineProperty(node, 'textContent', {
    get: () => {
      if (ownText !== null) return ownText;
      const collect = (parent: StubNode): string =>
        (parent.childNodes ?? [])
          .map((child) => (child.nodeType === 3 ? String(child.nodeValue ?? '') : collect(child)))
          .join('');
      return collect(node);
    },
    set: (value: string) => {
      ownText = value;
    }
  });
  node.closest = (matcher) => {
    const candidates = String(matcher)
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    for (let current: StubElement | null = node; current; current = current.parentElement) {
      if (candidates.some((candidate) => matches(current!, candidate))) return current;
    }
    return null;
  };
  node.contains = (other) => {
    for (let current: StubNode | null = other; current; current = current.parentElement) {
      if (current === node) return true;
    }
    return false;
  };
  node.appendChild = (child) => {
    child.parentElement = node;
    node.childNodes.push(child);
    return child;
  };
  node.append = (...children) => {
    for (const child of children) node.appendChild(child);
  };
  node.remove = () => {
    removed.push(node);
    const parent = node.parentElement;
    if (parent) {
      const index = parent.childNodes.indexOf(node);
      if (index >= 0) parent.childNodes.splice(index, 1);
      node.parentElement = null;
    }
  };
  node.getAttribute = (name) => (name in attrs ? String(attrs[name]) : null);
  node.getBoundingClientRect = () => ({ top: Number(attrs.top ?? 0), bottom: Number(attrs.top ?? 0) + 20, width: 1, height: 20 });
  node.setAttribute = (name, value) => {
    attrs[name] = value;
  };
  node.addEventListener = (type, listener) => {
    (node.listeners[type] ??= []).push(listener);
  };
  node.click = () => {
    for (const listener of node.listeners.click ?? []) listener({ type: 'click' });
  };
  node.querySelectorAll = (selector) => {
    const out: StubElement[] = [];
    const walk = (element: StubElement) => {
      for (const child of element.childNodes) {
        if (child.nodeType !== 1) continue;
        if (matches(child, selector)) out.push(child);
        walk(child);
      }
    };
    walk(node);
    return out;
  };
  return node;
}

function createPage({
  lang = '',
  title = '',
  href = 'https://example.com/article',
  meta = {}
}: { lang?: string; title?: string; href?: string; meta?: Record<string, string> } = {}) {
  const removed: StubElement[] = [];
  const created: StubElement[] = [];
  const make = (tag: string, props: StubProps = {}, children: StubNode[] = []) => {
    const element = makeElement(tag, props, removed);
    for (const child of children) element.appendChild(child);
    return element;
  };
  const documentElement = make('html', { lang });
  const body = make('body');
  documentElement.appendChild(body);
  const createElement = (tag: string) => {
    const element = makeElement(tag, {}, removed);
    created.push(element);
    return element;
  };
  const document = {
    nodeType: 9,
    documentElement,
    body,
    createElement,
    title,
    location: { href },
    // The collector's two DOM calls; the page stub has no <meta> tree, so the
    // map is the tree.
    querySelector(selector: string) {
      const key = selector.match(/meta\[(?:property|name)="([^"]+)"\]/)?.[1];
      const value = key ? meta[key] : undefined;
      if (value === undefined) return null;
      return { getAttribute: (name: string) => (name === 'content' ? value : null), textContent: null };
    },
    querySelectorAll() {
      return [];
    }
  };
  /** Every card currently hanging off the page, found the way a page would. */
  const cards = () => documentElement.querySelectorAll('[data-no-translate]');
  return { document, documentElement, body, make, created, removed, cards };
}

// --- mutation observer stand-in --------------------------------------------

class ObserverStub {
  callback: (records: unknown[]) => void;
  targets: StubNode[] = [];
  init: ATNamespace = {};
  disconnected = false;

  constructor(callback: (records: unknown[]) => void) {
    this.callback = callback;
  }

  observe(target: StubNode, init: ATNamespace): void {
    this.targets.push(target);
    this.init = init;
  }

  disconnect(): void {
    this.disconnected = true;
    this.targets = [];
  }

  takeRecords(): unknown[] {
    return [];
  }
}

// --- fake clock -------------------------------------------------------------
// The observer debounce must not be waited out; the test captures the scheduled
// callback and runs it itself, so a tick is observed rather than slept through.

type Timer = { id: number; callback: () => unknown; delay: number };

function installClock() {
  const pending: Timer[] = [];
  let nextId = 1;
  const originals = { setTimeout: host.setTimeout, clearTimeout: host.clearTimeout };
  host.setTimeout = (callback: () => unknown, delay = 0): number => {
    const timer = { id: nextId++, callback, delay };
    pending.push(timer);
    return timer.id;
  };
  host.clearTimeout = (id?: number): void => {
    const index = pending.findIndex((timer) => timer.id === id);
    if (index >= 0) pending.splice(index, 1);
  };
  return {
    pending,
    /** Run everything scheduled so far, in order, awaiting what it returns. */
    async run() {
      const due = pending.splice(0, pending.length);
      for (const timer of due) {
        await timer.callback();
        // scheduleTick hands runTick's promise to AT.warn's catch and returns
        // nothing, so the tick's provider round trip is waited for from here.
        await drain();
      }
    },
    restore() {
      host.setTimeout = originals.setTimeout;
      host.clearTimeout = originals.clearTimeout;
    }
  };
}

// --- environment ------------------------------------------------------------

type Options = {
  /** The declared language of the page (`<html lang>`). */
  lang?: string;
  /** One `<p>` per entry inside the body. */
  texts?: string[];
  /** What the provider answers an at/batch with. */
  translate?: (texts: string[]) => string[];
  /** Answer at/batch with a rejection instead, from the `after`th call on. */
  fail?: { error: string; code?: string | null; after?: number };
  /** What `getSelection().toString()` reports. */
  selection?: string;
  /** i18n overrides; anything missing falls back to `[key]`. */
  messages?: Record<string, string>;
  /** What the page publishes about itself (`<meta>` values by key). */
  meta?: Record<string, string>;
  /** `<title>`, which the collector reads when no og:title is present. */
  title?: string;
  /** The page's URL, which supplies the host when nothing else does. */
  url?: string;
};

function environment(options: Options = {}) {
  resetGlobals();
  delete host.__autotranslate;
  delete host.document;
  delete host.location;
  delete host.MutationObserver;
  delete host.getSelection;

  const page = createPage({
    lang: options.lang ?? '',
    title: options.title ?? '',
    href: options.url ?? 'https://example.com/article',
    meta: options.meta ?? {}
  });
  for (const value of options.texts ?? DEFAULT_TEXTS) {
    page.body.appendChild(page.make('p', {}, [t(value)]));
  }
  host.document = page.document;
  host.location = { href: options.url ?? 'https://example.com/article' };

  let selection = options.selection ?? '';
  host.getSelection = () => ({ toString: () => selection });
  const scrollListeners: Listener[] = [];
  host.addEventListener = (type: string, listener: Listener) => {
    if (type === 'scroll') scrollListeners.push(listener);
  };
  host.removeEventListener = (type: string, listener: Listener) => {
    if (type !== 'scroll') return;
    const index = scrollListeners.indexOf(listener);
    if (index >= 0) scrollListeners.splice(index, 1);
  };
  host.innerHeight = 800;
  const observers: ObserverStub[] = [];
  host.MutationObserver = class extends ObserverStub {
    constructor(callback: (records: unknown[]) => void) {
      super(callback);
      observers.push(this);
    }
  };

  const recorded = { batch: [] as ATNamespace[], state: [] as ATNamespace[] };
  let batchCalls = 0;
  const batchReply = (message: ATNamespace): ATNamespace => {
    const index = batchCalls;
    batchCalls += 1;
    const texts = Array.isArray(message.texts) ? (message.texts as string[]) : [];
    const fail = options.fail;
    if (fail && index >= (fail.after ?? 0)) {
      return { ok: false, error: fail.error, code: fail.code ?? null };
    }
    return { ok: true, translations: (options.translate ?? wrap)(texts), detected: 'en', engine: 'libre' };
  };

  const events: { messages: MessageListener[] } = { messages: [] };
  host.browser = {
    runtime: {
      lastError: null,
      id: 'autotranslate@test',
      getURL: (path: string) => path,
      getManifest: () => ({ version: '9.9.9' }),
      sendMessage: async (message: ATNamespace) => {
        if (message.type === 'at/batch') {
          recorded.batch.push(message);
          return batchReply(message);
        }
        if (message.type === 'at/state-changed') {
          recorded.state.push(message);
          return { ok: true };
        }
        return { ok: false, error: `unhandled ${message.type}` };
      },
      onMessage: { addListener: (fn: MessageListener) => events.messages.push(fn) }
    },
    i18n: {
      getUILanguage: () => 'en',
      getMessage: (key: string) => options.messages?.[key] ?? `[${key}]`
    }
  };

  const AT = load(...FILES);

  /** Post a message to the content script and wait for its single reply. */
  const send = (message: ATNamespace) =>
    new Promise<ATNamespace>((resolve) => {
      let answered = false;
      const respond = (payload: unknown) => {
        if (answered) return;
        answered = true;
        resolve(payload as ATNamespace);
      };
      const willAnswer = events.messages.map((listener) => listener(message, {}, respond));
      if (!willAnswer.includes(true)) resolve(silence);
    });

  /** Deliver DOM mutations the way the browser does: live observers only.
   *  No records means "something changed somewhere unnamed", which a caller
   *  that did not build records cannot be more precise about. */
  const mutate = (records?: unknown[]) => {
    const delivered = records ?? [
      { type: 'childList', target: page.documentElement, addedNodes: [page.body] }
    ];
    for (const observer of observers) {
      if (!observer.disconnected) observer.callback(delivered);
    }
  };

  return {
    AT,
    page,
    recorded,
    observers,
    boot: host.__autotranslate as ATNamespace,
    listenerCount: () => events.messages.length,
    send,
    mutate,
    scroll: () => {
      for (const listener of scrollListeners) listener();
    },
    scrollListeners
  };
}

const snapshot = (overrides: ATNamespace = {}): ATNamespace => ({
  enabled: true,
  autoDetect: true,
  targetLang: 'en',
  sourceLang: 'auto',
  engine: 'libre',
  batchChars: 1200,
  maxNodes: 600,
  showBadge: true,
  ...overrides
});

const translateMessage = (settings: ATNamespace = snapshot(), decision: ATNamespace = { action: 'translate' }) => ({
  type: 'at/content-translate',
  decision,
  settings
});

/** The body paragraph of the card: what the reader reads. */
function cardBody(card: StubElement) {
  const paragraph = card.childNodes.find((child) => child.nodeType === 1 && child.tagName === 'P');
  assert.ok(paragraph, 'the card has a paragraph');
  return paragraph as StubElement;
}

/** The card's close button. */
function cardClose(card: StubElement) {
  const button = card.childNodes.find((child) => child.nodeType === 1 && child.tagName === 'BUTTON');
  assert.ok(button, 'the card has a close button');
  return button as StubElement;
}

// --- ping -------------------------------------------------------------------

test('at/content-ping answers with a pong', async () => {
  const env = environment();
  const reply = await env.send({ type: 'at/content-ping' });
  assert.deepEqual(reply, { ok: true, pong: true });
  assert.equal(env.recorded.batch.length, 0, 'a ping asks the provider nothing');
  assert.equal(env.recorded.state.length, 0, 'a ping reports no state change');
  assert.deepEqual(env.page.cards(), [], 'a ping leaves no card behind');
});

test('the page context travels with the batch, and only when it says something', async () => {
  const plain = environment();
  await plain.send(translateMessage(snapshot({ targetLang: 'de' })));
  assert.equal(plain.recorded.batch[0]?.context, null, 'an unidentified page adds no context');

  const news = environment({
    meta: { 'og:type': 'article', 'og:site_name': 'Example News', 'article:section': 'Politics' },
    title: 'Headline'
  });
  await news.send(translateMessage(snapshot({ targetLang: 'de' })));
  const context = news.recorded.batch[0]?.context as ATNamespace;
  assert.equal(context.kind, 'article', 'og:type article is an article, not a news claim');
  assert.equal(context.site, 'Example News');
  assert.equal(context.section, 'Politics');
  assert.equal(context.title, 'Headline', 'the title is read when no og:title is present');
});

test('the page content is translated before its chrome', async () => {
  // A menu label at the very top, a paragraph on screen, another far below.
  const env = environment();
  env.page.body.childNodes.length = 0;
  const menu = env.page.make('nav', {});
  menu.appendChild(env.page.make('a', { attrs: { top: '10' } }, [t('Home')]));
  const body = env.page.make('article', {});
  const first = env.page.make('p', { attrs: { top: '120' } }, [t('Hello there')]);
  const second = env.page.make('p', { attrs: { top: '4000' } }, [t('Far away text')]);
  body.append(first, second);
  env.page.documentElement.append(menu, body);

  const reply = await env.send(translateMessage(snapshot({ targetLang: 'de' })));
  assert.equal(reply.status, 'translated');

  const batches = env.recorded.batch;
  assert.equal(batches[0]?.texts[0], 'Hello there', 'the article is finished before the menu, whatever its position');
  assert.equal(batches[0]?.role, 'article');
  assert.equal(
    batches.some((batch: ATNamespace) => batch.texts.includes('Home') && batch.role === 'navigation'),
    true,
    'menu labels travel in their own batch, marked as navigation'
  );
  const farBatch = batches.find((batch: ATNamespace) => batch.texts.includes('Far away text'));
  assert.equal(farBatch?.role, 'article');
  const menuBatch = batches.find((batch: ATNamespace) => batch.texts.includes('Home'));
  assert.equal(menuBatch?.role, 'navigation');
  assert.ok(
    batches.indexOf(farBatch) < batches.indexOf(menuBatch),
    'the whole article, even far below, is finished before the menu'
  );
});

test('scrolling asks for the text that just came into view', async () => {
  const clock = installClock();
  try {
    const env = environment();
    env.page.body.childNodes.length = 0;
    const visible = env.page.make('p', { attrs: { top: '100' } }, [t('On screen now')]);
    const below = env.page.make('p', { attrs: { top: '4000' } }, [t('Scrolled into view')]);
    env.page.body.append(visible, below);

    await env.send(translateMessage(snapshot({ targetLang: 'de', maxNodes: 1 })));
    assert.deepEqual(env.recorded.batch[0]?.texts, ['On screen now'], 'the first pass takes only the screen');

    // The reader scrolls: the second paragraph is now at the top of the viewport.
    below.attrs.top = '10';
    env.scroll();
    await clock.run();

    const texts = env.recorded.batch.map((batch: ATNamespace) => batch.texts).flat();
    assert.deepEqual(texts, ['On screen now', 'Scrolled into view'], 'the scroll pass translates what is visible now');
  } finally {
    clock.restore();
  }
});

test('a second injection registers no extra listener', async () => {
  const env = environment();
  const before = env.listenerCount();
  assert.ok(before > 0, 'the first injection registers its handler table');
  // The re-entry guard reads the boot marker the first pass left on globalThis.
  assert.equal(env.boot.version, '9.9.9');
  load('content.js');
  assert.equal(env.listenerCount(), before, 'the guarded script body never runs twice');
  assert.deepEqual(await env.send({ type: 'at/content-ping' }), { ok: true, pong: true });
});

// --- translate --------------------------------------------------------------

test('a translate decision sends one batch and reports the translated count', async () => {
  const env = environment();
  const before = pageTexts(env.page.documentElement);
  assert.deepEqual(before, DEFAULT_TEXTS);

  const reply = await env.send(translateMessage(snapshot({ targetLang: 'de', sourceLang: 'auto' })));
  assert.deepEqual(reply, {
    ok: true,
    status: 'translated',
    translated: 2,
    requested: 2,
    failed: 0,
    error: null
  });

  assert.equal(env.recorded.batch.length, 1, 'one pass sends exactly one at/batch');
  assert.deepEqual(env.recorded.batch[0], {
    type: 'at/batch',
    texts: DEFAULT_TEXTS,
    targetLang: 'de',
    sourceLang: 'auto',
    url: 'https://example.com/article',
    context: null,
    role: 'unknown'
  });

  assert.deepEqual(pageTexts(env.page.documentElement), wrap(DEFAULT_TEXTS), 'every text node holds its translation');
  assert.deepEqual(env.recorded.state, [
    { type: 'at/state-changed', status: 'translated', translated: 2, error: null }
  ]);

  assert.equal(env.observers.length, 1, 'a translated page starts watching for dynamic content');
  const observer = env.observers[0];
  assert.ok(observer);
  assert.deepEqual(observer.targets, [env.page.documentElement]);
  assert.deepEqual(observer.init, { childList: true, subtree: true, characterData: true });
});

test('a repeated translate pass asks the provider nothing new', async () => {
  const env = environment();
  await env.send(translateMessage());
  const reply = await env.send(translateMessage());
  assert.equal(env.recorded.batch.length, 1, 'already translated nodes are not sent again');
  assert.deepEqual(reply, {
    ok: true,
    status: 'translated',
    translated: 2,
    requested: 0,
    failed: 0,
    error: null
  });
  assert.deepEqual(pageTexts(env.page.documentElement), wrap(DEFAULT_TEXTS));
});

// --- decisions that must not translate -------------------------------------

test('a skip decision leaves the page alone and reports idle', async () => {
  const env = environment();
  const reply = await env.send(translateMessage(snapshot(), { action: 'skip', reason: 'never-site' }));

  assert.deepEqual(reply, { ok: true, status: 'idle', reason: 'never-site' });
  assert.equal(env.recorded.batch.length, 0, 'a skipped page never reaches the provider');
  assert.deepEqual(pageTexts(env.page.documentElement), DEFAULT_TEXTS, 'the DOM is untouched');
  assert.deepEqual(env.recorded.state, [{ type: 'at/state-changed', status: 'idle', translated: 0, error: null }]);
  assert.deepEqual(env.observers, [], 'a skipped page starts no observer');
});

test('detect compares the declared page language with the target', async () => {
  const same = environment({ lang: 'en', title: 'Some English page title' });
  assert.deepEqual(await same.send(translateMessage(snapshot(), { action: 'detect' })), {
    ok: true,
    status: 'idle',
    reason: 'language-matches-target'
  });
  assert.equal(same.recorded.batch.length, 0);
  assert.deepEqual(pageTexts(same.page.documentElement), DEFAULT_TEXTS);

  // A regional variant of the target still counts as the same language.
  const regional = environment({ lang: 'en-GB', title: 'Some English page title' });
  assert.equal((await regional.send(translateMessage(snapshot(), { action: 'detect' }))).status, 'idle');
  assert.equal(regional.recorded.batch.length, 0);

  const foreign = environment({ lang: 'de' });
  assert.equal((await foreign.send(translateMessage(snapshot(), { action: 'detect' }))).status, 'translated');
  assert.equal(foreign.recorded.batch.length, 1);
  assert.deepEqual(pageTexts(foreign.page.documentElement), wrap(DEFAULT_TEXTS));

  // Nothing declared: the script cannot tell, so it translates.
  const undeclared = environment({ lang: '   ', title: 'Some English page title' });
  assert.equal((await undeclared.send(translateMessage(snapshot(), { action: 'detect' }))).status, 'translated');
  assert.equal(undeclared.recorded.batch.length, 1);
});

test('an explicit source language outranks the declared page language', async () => {
  const env = environment({ lang: 'en' });
  const settings = snapshot({ sourceLang: 'de' });
  const reply = await env.send(translateMessage(settings, { action: 'detect' }));
  assert.equal(reply.status, 'translated', 'the user-told-us source wins over <html lang>');
  assert.equal(env.recorded.batch.length, 1);
  assert.equal(env.recorded.batch[0]?.sourceLang, 'de');
});

test('the master switch outranks a translate decision', async () => {
  const env = environment();
  const reply = await env.send(translateMessage(snapshot({ enabled: false })));
  assert.equal(reply.status, 'idle');
  assert.equal(env.recorded.batch.length, 0, 'a disabled extension never calls the provider');
  assert.deepEqual(pageTexts(env.page.documentElement), DEFAULT_TEXTS);
  assert.deepEqual(env.recorded.state, [{ type: 'at/state-changed', status: 'idle', translated: 0, error: null }]);
  assert.deepEqual(env.observers, []);
});

// --- provider failure -------------------------------------------------------

test('a rejected batch leaves the page untouched and reaches the background', async () => {
  const env = environment({ fail: { error: 'provider exploded', code: 'rate_limited' } });
  const reply = await env.send(translateMessage());

  assert.deepEqual(reply, { ok: false, error: 'provider exploded', code: 'rate_limited' });
  assert.equal(env.recorded.batch.length, 1);
  assert.deepEqual(pageTexts(env.page.documentElement), DEFAULT_TEXTS, 'a failure never edits the page');
  assert.deepEqual(
    env.recorded.state.filter((patch) => patch.status === 'translated'),
    [],
    'a failed pass must not claim translated nodes'
  );
  assert.equal(env.boot.state.observer, null, 'a failed pass leaves the page unwatched');
});

test('a failure in a later chunk never leaves half the page translated', async () => {
  // Two texts, a chunk budget that fits one of them: the first request succeeds
  // and is cached, the second one fails before anything is written back.
  const env = environment({ fail: { error: 'provider exploded', code: null, after: 1 } });
  const settings = snapshot({ batchChars: 12 });
  const reply = await env.send(translateMessage(settings));

  assert.equal(env.recorded.batch.length, 2, 'the chunk budget really split the request');
  assert.deepEqual(env.recorded.batch[0]?.texts, ['Hello there']);
  assert.deepEqual(env.recorded.batch[1]?.texts, ['Good morning']);
  assert.deepEqual(reply, { ok: false, error: 'provider exploded', code: null });
  assert.deepEqual(pageTexts(env.page.documentElement), DEFAULT_TEXTS, 'the answered chunk stays unwritten too');
});

// --- restore ----------------------------------------------------------------

test('restore puts the original text back and reports idle', async () => {
  const env = environment();
  await env.send(translateMessage());
  assert.deepEqual(pageTexts(env.page.documentElement), wrap(DEFAULT_TEXTS));

  const reply = await env.send({ type: 'at/content-restore' });
  assert.deepEqual(reply, { ok: true, status: 'idle', restored: 2 });
  assert.deepEqual(pageTexts(env.page.documentElement), DEFAULT_TEXTS);
  assert.deepEqual(env.recorded.state.at(-1), { type: 'at/state-changed', status: 'idle', translated: 0, error: null });
  assert.equal(env.observers[0]?.disconnected, true, 'restore tears the observer down');
  assert.equal(env.boot.state.observer, null);

  // Restoring again has nothing left to do and must not disturb the page.
  const second = await env.send({ type: 'at/content-restore' });
  assert.deepEqual(second, { ok: true, status: 'idle', restored: 0 });
  assert.deepEqual(pageTexts(env.page.documentElement), DEFAULT_TEXTS);
  assert.equal(env.recorded.state.length, 3, 'the second restore still reports idle');
});

test('restoring a page that was never translated still answers', async () => {
  const env = environment();
  const reply = await env.send({ type: 'at/content-restore' });
  assert.deepEqual(reply, { ok: true, status: 'idle', restored: 0 });
  assert.deepEqual(env.recorded.state, [{ type: 'at/state-changed', status: 'idle', translated: 0, error: null }]);
  assert.equal(env.recorded.batch.length, 0);
  assert.deepEqual(env.observers, []);
  assert.deepEqual(pageTexts(env.page.documentElement), DEFAULT_TEXTS);
});

// --- selection --------------------------------------------------------------

test('a selection message translates the text it is given', async () => {
  const env = environment({ selection: 'Ignored page selection' });
  const reply = await env.send({ type: 'at/content-translate-selection', text: 'Some selected words', settings: snapshot() });

  assert.deepEqual(reply, { ok: true, status: 'selection' });
  assert.equal(env.recorded.batch.length, 1);
  assert.deepEqual(env.recorded.batch[0]?.texts, ['Some selected words'], 'the message text wins over the page');
  assert.equal(env.recorded.batch[0]?.targetLang, 'en');

  const [card] = env.page.cards();
  assert.ok(card, 'the translation is shown in a card');
  assert.equal(card.parentElement, env.page.documentElement, 'the card hangs off the root element');
  assert.equal(cardBody(card).textContent, '»Some selected words«');
  assert.equal(card.attrs.dir, 'ltr', 'a left-to-right target is laid out left to right');
});

test('a selection falls back to the page selection and trims it', async () => {
  const env = environment({ selection: '  Picked from the page  ' });
  const reply = await env.send({ type: 'at/content-translate-selection', settings: snapshot({ targetLang: 'fr' }) });

  assert.deepEqual(reply, { ok: true, status: 'selection' });
  assert.equal(env.recorded.batch.length, 1);
  assert.deepEqual(env.recorded.batch[0]?.texts, ['Picked from the page'], 'the selection is trimmed before the request');
  assert.equal(env.recorded.batch[0]?.targetLang, 'fr');
  const [card] = env.page.cards();
  assert.ok(card, 'the page selection is shown in a card');
  assert.equal(cardBody(card).textContent, '»Picked from the page«');
});

test('an empty or one-character selection asks the provider nothing', async () => {
  const blank = environment({ selection: '   \n  ', messages: { content_noSelection: 'Nothing selected' } });
  assert.deepEqual(await blank.send({ type: 'at/content-translate-selection', settings: snapshot() }), {
    ok: true,
    status: 'empty'
  });
  assert.equal(blank.recorded.batch.length, 0, 'nothing was selected, so nothing is sent');
  const [card] = blank.page.cards();
  assert.ok(card, 'the user is told why nothing happened');
  assert.equal(cardBody(card).textContent, 'Nothing selected');

  // The engine needs more than one character to be worth a request.
  const tiny = environment();
  assert.equal((await tiny.send({ type: 'at/content-translate-selection', text: 'a', settings: snapshot() })).status, 'empty');
  assert.equal(tiny.recorded.batch.length, 0);
  assert.equal((await tiny.send({ type: 'at/content-translate-selection', text: 'ab', settings: snapshot() })).status, 'selection');
  assert.deepEqual(tiny.recorded.batch[0]?.texts, ['ab']);
});

test('an empty message text does not resurrect the page selection', async () => {
  const env = environment({ selection: 'Picked from the page' });
  // `message.text ?? selection` is a nullish check on purpose: an explicit empty
  // string means "the caller had nothing", it does not fall through to the page.
  assert.deepEqual(await env.send({ type: 'at/content-translate-selection', text: '', settings: snapshot() }), {
    ok: true,
    status: 'empty'
  });
  assert.equal(env.recorded.batch.length, 0);
});

test('a message without settings is refused instead of guessing', async () => {
  const env = environment();
  assert.deepEqual(await env.send({ type: 'at/content-translate' }), {
    ok: false,
    error: 'translate request without settings',
    code: null
  });
  assert.deepEqual(await env.send({ type: 'at/content-translate-selection' }), {
    ok: false,
    error: 'selection request without settings',
    code: null
  });
  assert.equal(env.recorded.batch.length, 0);
  assert.deepEqual(pageTexts(env.page.documentElement), DEFAULT_TEXTS);

  // Once a translate pass has stored its snapshot, a selection may omit it.
  await env.send(translateMessage(snapshot({ targetLang: 'ja' })));
  assert.deepEqual(await env.send({ type: 'at/content-translate-selection', text: 'Remembered' }), {
    ok: true,
    status: 'selection'
  });
  assert.equal(env.recorded.batch.at(-1)?.targetLang, 'ja', 'the remembered settings drive the request');
});

// --- the card ---------------------------------------------------------------

test('the card is reused, and its close button removes that card', async () => {
  const env = environment({ messages: { content_close: 'Close' } });
  const settings = snapshot();
  await env.send({ type: 'at/content-translate-selection', text: 'First sentence', settings });
  const first = env.page.cards()[0];
  assert.ok(first, 'the first selection shows a card');
  assert.equal(env.page.created.filter((element) => element.tagName === 'DIV').length, 1);

  await env.send({ type: 'at/content-translate-selection', text: 'Second sentence', settings });
  const cards = env.page.cards();
  assert.equal(cards.length, 1, 'the second selection replaces the card instead of stacking');
  const [card] = cards;
  assert.ok(card);
  assert.notEqual(card, first, 'it is a fresh element');
  assert.equal(env.page.removed.at(-1), first, 'the old card was taken out of the page');
  assert.equal(cardBody(card).textContent, '»Second sentence«');

  const close = cardClose(card);
  assert.equal(close.attrs['aria-label'], 'Close');
  assert.equal(close.type, 'button');
  assert.equal(close.textContent, '×');

  close.click();
  assert.equal(env.page.removed.at(-1), card, 'the close listener removes the card it belongs to');
  assert.deepEqual(env.page.cards(), [], 'the page is clean again');

  // The handler is idempotent: the state was cleared with the element.
  const removals = env.page.removed.length;
  close.click();
  assert.equal(env.page.removed.length, removals, 'a second click removes nothing');
});

test('the card is laid out for the target language and is never translated', async () => {
  const env = environment({ texts: ['Hello there'], messages: { content_noSelection: 'Nothing selected' } });
  const settings = snapshot({ targetLang: 'ar' });
  await env.send({ type: 'at/content-translate-selection', text: 'Some selected words', settings });

  const [card] = env.page.cards();
  assert.ok(card);
  assert.equal(card.attrs['data-no-translate'], '', 'the card marks itself untranslatable');
  assert.equal(card.attrs.dir, 'rtl', 'an RTL target lays the card out right to left');
  assert.match(card.attrs.style ?? '', /position:fixed/, 'the card is positioned through the style attribute');

  // A full page pass must leave the card alone: its text is the user's own.
  await env.send(translateMessage(settings));
  assert.deepEqual(
    env.recorded.batch.at(-1)?.texts,
    ['Hello there'],
    'neither the card body nor its close button is sent to the provider'
  );
  assert.equal(cardBody(card).textContent, '»Some selected words«', 'the card keeps its translation');

  // RTL_LANGS is a plain table: an inherited key must not read as RTL.
  const inherited = environment({ texts: ['Hello there'] });
  await inherited.send({
    type: 'at/content-translate-selection',
    text: 'Some selected words',
    settings: snapshot({ targetLang: 'constructor' })
  });
  assert.equal(inherited.page.cards()[0]?.attrs.dir, 'ltr');
});

// --- the mutation observer ---------------------------------------------------

test('a page with more text than one tick may take finishes on its own', async () => {
  // A quiet page after one bounded pass used to stay half translated until
  // something else moved. The tick that spent its whole budget schedules the
  // next one instead of waiting for a mutation that may never come.
  const many = Array.from({ length: 40 }, (_, index) => `Paragraph number ${index}`);
  const env = environment({ texts: many });
  const clock = installClock();
  try {
    await env.send(translateMessage(snapshot({ batchChars: 60 })));
    const before = env.recorded.batch.length;
    assert.ok(before > 1, 'the batch budget split the page into several requests');

    // Nothing new in the DOM: only the self-scheduled ticks can finish it.
    for (let round = 0; round < 400 && clock.pending.length > 0; round += 1) await clock.run();
    const texts = pageTexts(env.page.body);
    assert.equal(
      texts.filter((text) => text.startsWith('»')).length,
      many.length,
      'every paragraph is translated without another mutation'
    );
  } finally {
    clock.restore();
  }
});

test('an inserted region is translated on its own, not by re-reading the page', async () => {
  const env = environment();
  const clock = installClock();
  try {
    await env.send(translateMessage());
    assert.equal(env.recorded.batch.length, 1);

    // A widget appears: one subtree, one new sentence.
    const widget = env.page.make('div', {}, [env.page.make('p', {}, [t('Brand new widget')])]);
    env.page.body.appendChild(widget);
    env.mutate([{ type: 'childList', target: env.page.body, addedNodes: [widget] }]);
    await clock.run();

    assert.equal(env.recorded.batch.length, 2, 'the tick asked once');
    assert.deepEqual(env.recorded.batch[1]?.texts, ['Brand new widget'], 'only the new region was read');
    assert.deepEqual(pageTexts(widget), ['»Brand new widget«']);
    assert.deepEqual(pageTexts(env.page.documentElement).slice(0, 2), wrap(DEFAULT_TEXTS), 'the page is untouched');
  } finally {
    clock.restore();
  }
});

test('a text the page rewrote is picked up from its record', async () => {
  const env = environment();
  const clock = installClock();
  try {
    await env.send(translateMessage());
    const first = textNodes(env.page.body)[0];
    assert.ok(first);
    // The page put its own text back and says so.
    first.nodeValue = 'A different sentence';
    env.mutate([{ type: 'characterData', target: first }]);
    await clock.run();

    assert.equal(env.recorded.batch.length, 2);
    assert.deepEqual(env.recorded.batch[1]?.texts, ['A different sentence']);
    assert.equal(first.nodeValue, '»A different sentence«');
  } finally {
    clock.restore();
  }
});

test('changes with nothing to translate do not wake the translator', async () => {
  const env = environment();
  const clock = installClock();
  try {
    await env.send(translateMessage());
    assert.equal(env.recorded.batch.length, 1);

    // A removal leaves nothing to read.
    const gone = env.page.make('p', {}, [t('Going away')]);
    env.mutate([{ type: 'childList', target: env.page.body, addedNodes: [], removedNodes: [gone] }]);
    // Our own write-back is a text edit too; the node already holds the answer.
    const translated = textNodes(env.page.body)[0];
    assert.ok(translated);
    env.mutate([{ type: 'characterData', target: translated }]);
    // An edit inside a region the extension never rewrites.
    const editor = env.page.make('div', { editable: true }, [t('Typing here')]);
    env.page.body.appendChild(editor);
    env.mutate([{ type: 'characterData', target: editor.childNodes[0] }]);
    // A text node with nothing to read: no letters, no numbers.
    const glyphs = t('— · —');
    env.page.body.appendChild(env.page.make('span', {}, [glyphs]));
    env.mutate([{ type: 'characterData', target: glyphs }]);

    assert.deepEqual(clock.pending, [], 'no tick was scheduled');
    assert.equal(env.recorded.batch.length, 1, 'the provider was not asked again');
    assert.equal(translated.nodeValue, '»Hello there«', 'the translation is still there');
  } finally {
    clock.restore();
  }
});

test('a flood of regions falls back to one pass over the page', async () => {
  const env = environment();
  const clock = installClock();
  try {
    await env.send(translateMessage());
    const added: StubElement[] = [];
    for (let index = 0; index < 40; index += 1) {
      const item = env.page.make('p', {}, [t(`Flood ${index}`)]);
      env.page.body.appendChild(item);
      added.push(item);
    }
    env.mutate([{ type: 'childList', target: env.page.body, addedNodes: added }]);
    for (let round = 0; round < 50 && clock.pending.length > 0; round += 1) await clock.run();

    assert.equal(
      pageTexts(env.page.body).filter((text) => text.startsWith('»Flood')).length,
      40,
      'every one of them is translated'
    );
  } finally {
    clock.restore();
  }
});

test('a page that keeps mutating still gets its new text translated', async () => {
  // YouTube mutates continuously: video progress, ads, counters. Resetting the
  // debounce on every mutation meant the tick never fired on such a page.
  const env = environment();
  const clock = installClock();
  try {
    await env.send(translateMessage());
    env.page.body.appendChild(env.page.make('p', {}, [t('Late comment')]));

    env.mutate();
    const scheduled = clock.pending.length;
    assert.equal(scheduled, 1);
    // A mutation inside the window must not push the tick back.
    env.page.body.appendChild(env.page.make('span', {}, [t('tick')]));
    env.mutate();
    env.mutate();
    assert.equal(clock.pending.length, scheduled, 'the pending tick is kept, not rescheduled');

    await clock.run();
    assert.equal(env.recorded.batch.length, 2, 'the tick ran anyway');
    assert.deepEqual(pageTexts(env.page.body).slice(2), ['»Late comment«', '»tick«']);
  } finally {
    clock.restore();
  }
});

test('a mutation re-scans the page and translates the new text', async () => {
  const env = environment();
  const clock = installClock();
  try {
    await env.send(translateMessage());
    assert.equal(env.recorded.batch.length, 1);
    assert.equal(env.observers.length, 1);
    const observer = env.observers[0];
    assert.ok(observer);
    assert.deepEqual(observer.targets, [env.page.documentElement]);
    assert.deepEqual(observer.init, { childList: true, subtree: true, characterData: true });

    env.page.body.appendChild(env.page.make('p', {}, [t('Fresh content')]));
    env.mutate();
    assert.equal(clock.pending.length, 1, 'a mutation schedules one debounced tick');
    assert.equal(clock.pending[0]?.delay, env.AT.C.OBSERVER_DEBOUNCE_MS);

    // Several mutations in a row still amount to a single tick.
    env.mutate();
    env.mutate();
    assert.equal(clock.pending.length, 1, 'the tick is debounced, not queued');

    await clock.run();
    assert.equal(env.recorded.batch.length, 2, 'the tick asks the provider about the new node');
    assert.deepEqual(env.recorded.batch[1]?.texts, ['Fresh content']);
    assert.deepEqual(pageTexts(env.page.body), [...wrap(['Hello there', 'Good morning']), '»Fresh content«']);
    assert.deepEqual(env.recorded.state.at(-1), { type: 'at/state-changed', status: 'translated', translated: 3, error: null });

    // A tick that collects nothing must not bother the provider or the badge.
    env.mutate();
    await clock.run();
    assert.equal(env.recorded.batch.length, 2);
    assert.equal(env.recorded.state.length, 2);
  } finally {
    clock.restore();
  }
});

test('a stopped observer ignores later mutations', async () => {
  const env = environment();
  const clock = installClock();
  try {
    await env.send(translateMessage());
    const observer = env.observers[0];
    assert.ok(observer);
    assert.equal(env.recorded.batch.length, 1);

    await env.send({ type: 'at/content-restore' });
    assert.equal(observer.disconnected, true, 'the restore path disconnects the observer');
    assert.equal(env.boot.state.observer, null);
    assert.ok(env.boot.state.pipeline, 'the engine that holds the originals stays recoverable');

    env.page.body.appendChild(env.page.make('p', {}, [t('Late content')]));
    env.mutate();
    assert.equal(clock.pending.length, 0, 'a disconnected observer never schedules a tick');
    await clock.run();
    await drain();
    assert.equal(env.recorded.batch.length, 1, 'no provider call after a restore');
    assert.equal(env.recorded.state.length, 2);
    assert.deepEqual(pageTexts(env.page.body), [...DEFAULT_TEXTS, 'Late content']);
  } finally {
    clock.restore();
  }
});

test('a page that claims the target language is still translated when its content is foreign', async () => {
  // YouTube: html[lang] is ko-KR (the shell is localised) while the title,
  // description and comments are English. Without asking the detector the page
  // is skipped and nothing is translated.
  resetGlobals();
  const env = environment({ lang: 'ko-KR', title: 'Some English page title', texts: ['Some English body text here'] });
  const detected: string[] = [];
  (env.AT as ATNamespace).detectLanguage = async (sample: string) => {
    detected.push(sample);
    return { code: 'en', reliable: true };
  };

  const reply = await env.send(
    translateMessage(snapshot({ targetLang: 'ko', sourceLang: 'auto' }), { action: 'detect' })
  );
  assert.equal(reply.status, 'translated', 'the foreign content is translated');
  assert.equal(detected.length, 1, 'the detector was asked once');
});

test('a page whose content is already in the target language is left alone', async () => {
  resetGlobals();
  const env = environment({ lang: 'ko-KR', title: '이미 한국어로 쓰인 제목', texts: ['이미 한국어로 쓰인 본문입니다'] });
  (env.AT as ATNamespace).detectLanguage = async () => ({ code: 'ko', reliable: true });

  const reply = await env.send(
    translateMessage(snapshot({ targetLang: 'ko', sourceLang: 'auto' }), { action: 'detect' })
  );
  assert.equal(reply.status, 'idle', 'nothing to do');
  assert.equal(env.recorded.batch.length, 0, 'the provider was never asked');
});

test('a page that has not rendered yet is translated once its content arrives', async () => {
  // YouTube reports `complete` with an empty body and lang=ko-KR; deciding then
  // would answer "already Korean" and nothing would ever translate. The script
  // waits, then looks again.
  const clock = installClock();
  try {
    const env = environment({ lang: 'ko-KR', texts: [] });
    (env.AT as ATNamespace).detectLanguage = async () => ({ code: 'en', reliable: true });

    const reply = await env.send(translateMessage(snapshot({ targetLang: 'ko' }), { action: 'detect' }));
    assert.equal(reply.status, 'idle');
    assert.equal(reply.reason, 'waiting-for-content', 'the empty page is not judged yet');
    assert.equal(env.recorded.batch.length, 0);

    // The app renders.
    env.page.body.append(env.page.make('p', {}, [t('The video title is here')]));
    env.page.document.title = 'The video title is here';
    await clock.run();

    assert.equal(env.recorded.batch.length, 1, 'the retry found the content and translated it');
    assert.deepEqual(pageTexts(env.page.body), ['»The video title is here«']);
  } finally {
    clock.restore();
  }
});
