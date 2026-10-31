import assert from 'node:assert/strict';
import test from 'node:test';
import { deferred, load, resetGlobals, type ATNamespace } from './helpers.ts';

// These tests execute the compiled production modules, not copies of their
// algorithms. Native Response/ReadableStream exercise the actual Fetch contract.
function boot(...extra: string[]) {
  resetGlobals();
  return load('lib/constants.js', 'lib/local.js', 'lib/dom.js', ...extra);
}

function element(tag: string, children: ATNamespace[] = []): ATNamespace {
  const node: ATNamespace = {
    nodeType: 1, tagName: tag.toUpperCase(), childNodes: children,
    parentElement: null, isContentEditable: false, id: '',
    closest: () => null, getAttribute: () => null, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ top: 10, bottom: 30, width: 100, height: 20 }),
    contains(other: ATNamespace) {
      for (let current = other; current; current = current.parentElement) if (current === node) return true;
      return false;
    }
  };
  for (const child of children) child.parentElement = node;
  return node;
}
const text = (value: string): ATNamespace => ({ nodeType: 3, nodeValue: value, parentElement: null, isConnected: true });
const doc = (root: ATNamespace) => ({ nodeType: 9, documentElement: root });

function store(AT: ATNamespace) {
  const records = new Map<string, unknown>();
  const bytes = new Map<string, Uint8Array>();
  AT.modelstore.configure({
    driver: {
      get: async (_store: string, id: string) => records.get(id),
      put: async (_store: string, id: string, record: unknown) => { records.set(id, record); },
      remove: async (_store: string, id: string) => { records.delete(id); },
      all: async () => [...records.values()]
    },
    files: {
      async write(id: string, stream: ReadableStream<Uint8Array>) {
        const value = new Uint8Array(await new Response(stream).arrayBuffer());
        bytes.set(id, value);
        return value.byteLength;
      },
      read: async (id: string) => new Blob([Uint8Array.from(bytes.get(id) ?? [])]),
      remove: async (id: string) => { bytes.delete(id); },
      estimate: async () => ({ usage: 0, quota: 1e10, persisted: true }),
      persist: async () => true
    }
  });
  return { records, bytes };
}

test('review: model download accepts a native Fetch Response', async () => {
  const AT = boot('lib/modelstore.js');
  const memory = store(AT);
  const payload = new Uint8Array(AT.local.MIN_MODEL_BYTES + 17).fill(23);
  AT.modelstore.configure({ fetchImpl: async () => new Response(payload, {
    headers: { 'content-length': String(payload.length) }
  }) });
  const result = await AT.modelstore.download({ url: 'https://models.example.test/model.task' });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(memory.bytes.get(result.record.id), payload);
});

test('review: storing a replacement does not delete an unverified working copy', async () => {
  const AT = boot('lib/modelstore.js');
  const memory = store(AT);
  let now = 1000;
  AT.modelstore.configure({ now: () => now });
  const ingest = () => AT.modelstore.ingest({ name: 'model.task', sourceUrl: 'https://models.example.test/model.task',
    stream: new Blob([new Uint8Array(AT.local.MIN_MODEL_BYTES)]).stream() });
  const old = await ingest();
  now += 1;
  const next = await ingest();
  assert.notEqual(old.record.id, next.record.id);
  assert.ok(memory.bytes.has(old.record.id), 'the replacement has not passed a load test');
  assert.ok(memory.bytes.has(next.record.id));
});

test('review: a late model result must not overwrite a newer page value', async () => {
  const AT = boot();
  const node = text('Old source');
  const root = element('p', [node]);
  const response = deferred<string[]>();
  const translator = AT.dom.createTranslator({ doc: doc(root), translate: () => response.promise });
  const run = translator.translateRoot(root);
  node.nodeValue = 'New source from page';
  response.resolve(['Old translation']);
  await run;
  assert.equal(node.nodeValue, 'New source from page');
  assert.equal(translator.has(node), false);
});

test('review: restore invalidates in-flight answers even without an external abort callback', async () => {
  const AT = boot();
  const node = text('Original');
  const root = element('p', [node]);
  const response = deferred<string[]>();
  const translator = AT.dom.createTranslator({ doc: doc(root), translate: () => response.promise });
  const run = translator.translateRoot(root);
  translator.restore(root);
  response.resolve(['Late translation']);
  await run;
  assert.equal(node.nodeValue, 'Original');
});

test('review: unaligned inline output never changes a link to an unrelated word', async () => {
  const AT = boot();
  const linkText = text('privacy policy');
  const root = element('p', [text('Read '), element('a', [linkText]), text(' before you continue.')]);
  const translator = AT.dom.createTranslator({ doc: doc(root), translate: async (texts: string[]) => texts.map((value) =>
    value === 'privacy policy' ? '개인정보처리방침' : value === 'Read' ? '읽으세요.' :
      value === 'before you continue.' ? '계속하기 전에.' : '계속하기 전에 개인정보처리방침을 읽으세요.') });
  await translator.translateRoot(root);
  assert.equal(linkText.nodeValue, '개인정보처리방침');
});

test('review: a CJK translation cannot empty an inline link', async () => {
  const AT = boot();
  const linkText = text('privacy policy');
  const root = element('p', [text('Read '), element('a', [linkText]), text(' before continuing.')]);
  const translator = AT.dom.createTranslator({ doc: doc(root), translate: async (texts: string[]) => texts.map((value) =>
    value === 'privacy policy' ? 'プライバシーポリシー' : value === 'Read' ? '確認する' :
      value === 'before continuing.' ? '続行する前に' : '続行する前にプライバシーポリシーを確認してください。') });
  await translator.translateRoot(root);
  assert.equal(linkText.nodeValue, 'プライバシーポリシー');
});

test('review: partial answers remain eligible and retry from the original text', async () => {
  const AT = boot();
  const node = text('First. Second.');
  const root = element('p', [node]);
  const calls: string[][] = [];
  const translator = AT.dom.createTranslator({ doc: doc(root),
    sentences: { split: (value: string) => value.split(' ').filter(Boolean), maxChars: 1, always: true },
    translate: async (texts: string[]) => { calls.push(texts); return calls.length === 1 ? ['첫째.', ''] : ['첫째.', '둘째.']; }
  });
  await translator.translateRoot(root);
  assert.equal(translator.has(node), false, 'a partial answer is not a completed translation');
  await translator.translateRoot(root);
  assert.deepEqual(calls[1], ['First.', 'Second.'], 'retry the original unit, not the mixed-language DOM');
  assert.equal(node.nodeValue, '첫째. 둘째.');
  assert.equal(translator.has(node), true);
});

test('review: a detached translated node is released during restore', async () => {
  const AT = boot();
  const node = text('Original');
  const root = element('p', [node]);
  const translator = AT.dom.createTranslator({ doc: doc(root), translate: async () => ['번역'] });
  await translator.translateRoot(root);
  node.parentElement = null;
  node.isConnected = false;
  root.childNodes = [];
  translator.restore(root);
  assert.equal(translator.stats().translated, 0);
});

test('review: cached text is isolated by semantic scope', async () => {
  const AT = boot();
  const one = text('Home');
  const two = text('Home');
  const root = element('div', [element('p', [one]), element('p', [two])]);
  let scope = 'navigation';
  let calls = 0;
  const translator = AT.dom.createTranslator({ doc: doc(root), cacheScope: () => scope,
    translate: async () => { calls++; return [scope === 'navigation' ? '홈' : '집']; }
  });
  await translator.translateNodes([one]);
  scope = 'article';
  await translator.translateNodes([two]);
  assert.equal(two.nodeValue, '집');
  assert.equal(calls, 2);
});

test('review: continuation depends on unvisited nodes, not deduplicated requests', async () => {
  const AT = boot('lib/pagecontext.js', 'lib/targets.js', 'lib/pipeline.js');
  const nodes = Array.from({ length: 601 }, () => text('Repeated sentence'));
  const root = element('body', nodes.map((node) => element('p', [node])));
  const translator = AT.pipeline.create({ doc: doc(root), settings: () => ({ maxNodes: 600 }),
    translate: async ({ texts }: { texts: string[] }) => texts.map(() => '번역') });
  const first = await translator.translate();
  assert.equal(first.requested, 1);
  assert.equal(first.hasMore, true);
  assert.equal(first.processedNodes, 600);
  const next = await translator.refresh();
  assert.equal(next.hasMore, false);
  assert.ok(nodes.every((node) => node.nodeValue === '번역'));
});
