import assert from 'node:assert/strict';
import test from 'node:test';
import { deferred, load, resetGlobals, type ATNamespace } from './helpers.ts';

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
  // it. The card assigns its own body, and page context reads headings through
  // it, so the stub has to behave the same way.
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
  translate?: (texts: string[]) => string[] | Promise<string[]>;
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
  const batchReply = async (message: ATNamespace): Promise<ATNamespace> => {
    const index = batchCalls;
    batchCalls += 1;
    const texts = Array.isArray(message.texts) ? (message.texts as string[]) : [];
    const fail = options.fail;
    if (fail && index >= (fail.after ?? 0)) {
      return { ok: false, error: fail.error, code: fail.code ?? null };
    }
    return { ok: true, translations: await (options.translate ?? wrap)(texts), detected: 'en', engine: 'libre' };
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
    /** The reports a badge or popup acts on: progress reports are additive. */
    states: () => recorded.state.filter((patch) => patch.status !== 'translating'),
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
  targetLang: 'en',
  sourceLang: 'auto',
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

test('a translate decision translates every text and reports the count', async () => {
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

  assert.equal(env.recorded.batch.length, 2, 'one request per text: the page fills in as answers land');
  assert.deepEqual(env.recorded.batch.map((batch) => batch.texts), [['Hello there'], ['Good morning']]);
  assert.deepEqual(env.recorded.batch[0], {
    type: 'at/batch',
    texts: [DEFAULT_TEXTS[0]],
    targetLang: 'de',
    sourceLang: 'auto',
    url: 'https://example.com/article',
    context: null,
    role: 'unknown'
  });

  assert.deepEqual(pageTexts(env.page.documentElement), wrap(DEFAULT_TEXTS), 'every text node holds its translation');
  assert.deepEqual(env.recorded.state, [
    { type: 'at/state-changed', status: 'translating', translated: 1, error: null },
    { type: 'at/state-changed', status: 'translated', translated: 2, error: null }
  ], 'a pass reports progress before it reports the result');

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
  assert.equal(env.recorded.batch.length, 2, 'already translated nodes are not sent again');
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

test('a skip decision on an enabled page reports idle and sends no batch', async () => {
  const env = environment();
  const reply = await env.send(translateMessage(snapshot(), { action: 'skip', reason: 'site-never' }));

  assert.deepEqual(reply, { ok: true, status: 'idle', reason: 'site-never' });
  assert.equal(env.recorded.batch.length, 0, 'a skipped page never reaches the provider');
  assert.deepEqual(pageTexts(env.page.documentElement), DEFAULT_TEXTS, 'the DOM is untouched');
  assert.deepEqual(env.recorded.state, [{ type: 'at/state-changed', status: 'idle', translated: 0, error: null }]);
  assert.deepEqual(env.observers, [], 'a skipped page starts no observer');
});

test('the master switch reports idle without a batch', async () => {
  const env = environment();
  const reply = await env.send(translateMessage(snapshot({ enabled: false })));

  assert.deepEqual(reply, { ok: true, status: 'idle', reason: 'disabled' });
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
  assert.equal(env.recorded.batch.length, 2, 'both texts were attempted and both were refused');
  assert.deepEqual(pageTexts(env.page.documentElement), DEFAULT_TEXTS, 'a failure never edits the page');
  assert.deepEqual(
    env.recorded.state.filter((patch) => patch.status === 'translated'),
    [],
    'a failed pass must not claim translated nodes'
  );
  assert.equal(env.boot.state.observer, null, 'a failed pass leaves the page unwatched');
});

test('a failed chunk keeps what already landed and says what failed', async () => {
  // A run wider than the DOM layer's character budget (1200) is split into one
  // request per paragraph here: chunks are written as their answers arrive, so a
  // failure in the second one must not throw away the first.
  const first = 'Hello there '.repeat(60).slice(0, 700);
  const second = 'Good morning '.repeat(60).slice(0, 700);
  const env = environment({ texts: [first, second], fail: { error: 'provider exploded', code: null, after: 1 } });
  const reply = await env.send(translateMessage());

  assert.equal(env.recorded.batch.length, 2, 'the character budget really split the request');
  assert.deepEqual(env.recorded.batch[0]?.texts, [first]);
  assert.deepEqual(env.recorded.batch[1]?.texts, [second]);
  assert.equal(reply.ok, true, 'a partial pass is not a failed pass');
  assert.equal(reply.failed, 1);
  assert.match(String(reply.error), /provider exploded/);
  const [firstText, secondText] = pageTexts(env.page.documentElement);
  assert.equal(firstText, wrap([first])[0], 'the answered chunk stays translated');
  assert.equal(secondText, second, 'the failed one keeps its source text');

  // The next pass asks only for what is left: the answered chunk is not paid for
  // twice, even though the fake provider refuses every later request too.
  const batchesBefore = env.recorded.batch.length;
  await env.send(translateMessage());
  assert.equal(env.recorded.batch.length, batchesBefore + 1, 'one request for the one missing text');
  assert.deepEqual(env.recorded.batch.at(-1)?.texts, [second], 'only the failed text is retried');
  assert.equal(pageTexts(env.page.documentElement)[0], wrap([first])[0], 'the translated text is still there');
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
  assert.equal(env.states().length, 3, 'the second restore still reports idle');
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
  // The first pass honours `maxNodes`, so a longer page is left partly
  // translated. A quiet page has no mutation to wake it, so the pass that spent
  // its whole budget schedules the next one instead of waiting.
  const many = Array.from({ length: 120 }, (_, index) => `Paragraph number ${index}`);
  const env = environment({ texts: many });
  const clock = installClock();
  try {
    await env.send(translateMessage(snapshot({ maxNodes: 40 })));
    const translated = pageTexts(env.page.body).filter((text) => text.startsWith('»'));
    assert.equal(translated.length, 40, 'the first pass is bounded by maxNodes');
    assert.ok(clock.pending.length > 0, 'the spent budget schedules the next tick without a mutation');

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
    assert.equal(env.recorded.batch.length, 2);

    // A widget appears: one subtree, one new sentence.
    const widget = env.page.make('div', {}, [env.page.make('p', {}, [t('Brand new widget')])]);
    env.page.body.appendChild(widget);
    env.mutate([{ type: 'childList', target: env.page.body, addedNodes: [widget] }]);
    await clock.run();

    assert.equal(env.recorded.batch.length, 3, 'the tick asked once');
    assert.deepEqual(env.recorded.batch[2]?.texts, ['Brand new widget'], 'only the new region was read');
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

    assert.equal(env.recorded.batch.length, 3);
    assert.deepEqual(env.recorded.batch[2]?.texts, ['A different sentence']);
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
    assert.equal(env.recorded.batch.length, 2);

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
    assert.equal(env.recorded.batch.length, 2, 'the provider was not asked again');
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
    const asked = env.recorded.batch.flatMap((batch) => batch.texts);
    assert.ok(asked.includes('Late comment') && asked.includes('tick'), 'the tick ran anyway');
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
    assert.equal(env.recorded.batch.length, 2);
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
    assert.equal(env.recorded.batch.length, 3, 'the tick asks the provider about the new node');
    assert.deepEqual(env.recorded.batch[2]?.texts, ['Fresh content']);
    assert.deepEqual(pageTexts(env.page.body), [...wrap(['Hello there', 'Good morning']), '»Fresh content«']);
    assert.deepEqual(env.recorded.state.at(-1), { type: 'at/state-changed', status: 'translated', translated: 3, error: null });

    // A tick that collects nothing must not bother the provider or the badge.
    env.mutate();
    await clock.run();
    assert.equal(env.recorded.batch.length, 3);
    assert.equal(env.states().length, 2);
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
    assert.equal(env.recorded.batch.length, 2);

    await env.send({ type: 'at/content-restore' });
    assert.equal(observer.disconnected, true, 'the restore path disconnects the observer');
    assert.equal(env.boot.state.observer, null);
    assert.equal(env.boot.state.pipeline, null, 'a cancelled session releases its pipeline after restoring');

    env.page.body.appendChild(env.page.make('p', {}, [t('Late content')]));
    env.mutate();
    assert.equal(clock.pending.length, 0, 'a disconnected observer never schedules a tick');
    await clock.run();
    await drain();
    assert.equal(env.recorded.batch.length, 2, 'no provider call after a restore');
    assert.equal(env.states().length, 2);
    assert.deepEqual(pageTexts(env.page.body), [...DEFAULT_TEXTS, 'Late content']);
  } finally {
    clock.restore();
  }
});

// --- cancellation and session regressions -----------------------------------

test('restore is acknowledged before an in-flight generation finishes', async () => {
  const gate = deferred<string[]>();
  const env = environment({ texts: ['Pending source'], translate: () => gate.promise });
  const running = env.send(translateMessage());
  await drain();
  assert.equal(env.recorded.batch.length, 1);
  let acknowledged = false;
  const restoring = env.send({ type: 'at/content-restore' }).then((reply) => { acknowledged = true; return reply; });
  await drain();
  try {
    assert.equal(acknowledged, true, 'control commands must not wait in the translation queue');
    assert.equal(env.boot.state.stopped, true);
  } finally {
    gate.resolve(['Late result']);
    await Promise.all([running, restoring]);
  }
  assert.deepEqual(pageTexts(env.page.body), ['Pending source']);
  assert.equal(env.states().at(-1)?.status, 'idle');
});

test('a cancelled response cannot join a new session even with the same target language', async () => {
  const gate = deferred<string[]>();
  let calls = 0;
  const env = environment({ texts: ['Source'], translate: () => ++calls === 1 ? gate.promise : ['New session result'] });
  const old = env.send(translateMessage());
  await drain();
  await env.send({ type: 'at/content-restore' });
  const current = await env.send(translateMessage());
  assert.equal(current.ok, true);
  gate.resolve(['Obsolete result']);
  const previous = await old;
  assert.equal(previous.status, 'cancelled');
  assert.deepEqual(pageTexts(env.page.body), ['New session result']);
  assert.equal(env.states().at(-1)?.status, 'translated');
});

test('mutations during the first generation are observed and drained afterwards', async () => {
  const gate = deferred<string[]>();
  let calls = 0;
  const env = environment({ texts: ['First source'], translate: (texts) => ++calls === 1 ? gate.promise : wrap(texts) });
  const clock = installClock();
  try {
    const running = env.send(translateMessage());
    await drain();
    assert.ok(env.observers.some((observer) => !observer.disconnected), 'observe before awaiting inference');
    const inserted = env.page.make('p', {}, [t('Arrived during generation')]);
    env.page.body.appendChild(inserted);
    env.mutate([{ type: 'childList', target: env.page.body, addedNodes: [inserted] }]);
    gate.resolve(['First result']);
    await running;
    await clock.run();
    await drain();
    assert.deepEqual(pageTexts(env.page.body), ['First result', '»Arrived during generation«']);
  } finally {
    gate.resolve(['First result']);
    clock.restore();
  }
});

test('model configuration changes invalidate the cache even when the target is unchanged', async () => {
  const env = environment({ texts: ['Original source'] });
  await env.send(translateMessage(snapshot({ translationKey: 'model-one' })));
  await env.send(translateMessage(snapshot({ translationKey: 'model-two' })));
  assert.equal(env.recorded.batch.length, 2);
  assert.deepEqual(env.recorded.batch[1]?.texts, ['Original source']);
});

test('a new target takes effect without waiting for the obsolete target response', async () => {
  const gate = deferred<string[]>();
  let calls = 0;
  const env = environment({ texts: ['Original source'], translate: () => ++calls === 1 ? gate.promise : ['새 번역'] });
  const old = env.send(translateMessage(snapshot({ targetLang: 'ja' })));
  await drain();
  const current = await env.send(translateMessage(snapshot({ targetLang: 'ko' })));
  assert.equal(current.ok, true);
  assert.equal(env.recorded.batch[1]?.targetLang, 'ko');
  gate.resolve(['古い翻訳']);
  await old;
  assert.deepEqual(pageTexts(env.page.body), ['새 번역']);
});
