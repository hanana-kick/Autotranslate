import test from 'node:test';
import assert from 'node:assert/strict';
import { load, type ATNamespace } from './helpers.ts';

// The page translation engine ties pagecontext + targets + dom together. The
// document stand-in is deliberately small: a parent element, a rect, two
// attributes and `contains` are all the engine may ask of a page.
const AT = load('lib/constants.js', 'lib/pagecontext.js', 'lib/targets.js', 'lib/dom.js', 'lib/pipeline.js');
const { pipeline } = AT;

type StubElement = {
  nodeType: 1;
  tagName: string;
  childNodes: unknown[];
  parentElement: StubElement | null;
  attrs: Record<string, string>;
  classes: string[];
  isContentEditable: boolean;
  id?: string;
  getAttribute: (name: string) => string | null;
  getBoundingClientRect: () => { top: number; bottom: number; width: number; height: number };
  querySelectorAll: () => never[];
  closest: () => null;
  contains: () => boolean;
};

type Entry = { text: string; top: number; attrs?: Record<string, string>; tag?: string };

function page(entries: Entry[]) {
  const parents: StubElement[] = entries.map((entry) => ({
    nodeType: 1,
    tagName: (entry.tag ?? 'p').toUpperCase(),
    childNodes: [],
    parentElement: null,
    attrs: entry.attrs ?? {},
    classes: [],
    isContentEditable: false,
    getAttribute(name: string) {
      return this.attrs[name] ?? null;
    },
    getBoundingClientRect: () => ({ top: entry.top, bottom: entry.top + 20, width: 600, height: 20 }),
    querySelectorAll: () => [],
    closest: () => null,
    contains: () => true
  }));
  const texts = entries.map((entry, index) => {
    const node = { nodeType: 3 as const, nodeValue: entry.text, parentElement: parents[index] as StubElement | null };
    parents[index]!.childNodes = [node];
    return node;
  });
  const body: StubElement = {
    nodeType: 1,
    tagName: 'BODY',
    childNodes: parents,
    parentElement: null,
    attrs: {},
    classes: [],
    isContentEditable: false,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ top: 0, bottom: 5000, width: 1000, height: 5000 }),
    querySelectorAll: () => [],
    closest: () => null,
    contains: () => true
  };
  for (const parent of parents) parent.parentElement = body;
  return { document: { nodeType: 9 as const, documentElement: body }, body, texts };
}

function engine(
  entries: Entry[],
  settings: { maxNodes?: number; failRole?: string } = {}
) {
  let failedOnce = false;
  const { document, body, texts } = page(entries);
  const batches: { texts: string[]; role: string; context: unknown }[] = [];
  const translator = pipeline.create({
    doc: document,
    settings: () => ({ maxNodes: settings.maxNodes ?? 600 }),
    viewportHeight: () => 800,
    translate: async (batch: never) => {
      const value = batch as unknown as { texts: string[]; role: string; context: unknown };
      batches.push({ texts: value.texts, role: value.role, context: value.context });
      if (settings.failRole !== undefined && value.role === settings.failRole && !failedOnce) {
        failedOnce = true;
        throw new Error(`provider refused the ${value.role} batch`);
      }
      return value.texts.map((text) => `»${text}«`);
    }
  });
  return { translator, body, texts, batches };
}

test('one pass reads the page, plans it, and translates in plan order', async () => {
  const { translator, batches, body } = engine([
    { text: 'Home', top: 10, tag: 'a', attrs: { role: 'navigation' } },
    { text: 'Hello there', top: 100, tag: 'p', attrs: {} }
  ]);

  const result = await translator.translate();
  assert.equal(result.translated, 2);
  assert.deepEqual(
    batches.map((batch) => `${batch.role}:${batch.texts.join(',')}`),
    ['navigation:Home', 'unknown:Hello there'],
    'both are visible; the menu outranks unknown prose inside one priority'
  );
  assert.ok(batches[0]?.context, 'the page context travels with the batch');
  assert.equal(translator.context()?.site, null);
  assert.ok(body);
});

test('a paragraph below the fold is translated after the one on screen', async () => {
  const { translator, batches } = engine([
    { text: 'Far below', top: 4000 },
    { text: 'Here now', top: 120 }
  ]);
  await translator.translate();
  assert.deepEqual(
    batches.map((batch) => batch.texts.join(',')),
    ['Here now', 'Far below'],
    'the visible paragraph is paid for first'
  );
});

test('refresh only pays for what is new, and keeps the page context', async () => {
  const { translator, batches } = engine([{ text: 'First', top: 10 }]);

  const first = await translator.translate();
  assert.equal(first.requested, 1);
  assert.ok(translator.context(), 'the page context is read once per pass');

  const again = await translator.refresh();
  assert.equal(again.requested, 0, 'nothing new means nothing sent');
  assert.deepEqual(batches.map((batch) => batch.texts), [['First']]);

  const restored = translator.restore();
  assert.equal(restored.restored, 1);
  assert.equal(translator.stats().translated, 0, 'the records are gone with the text');
});

test('collection looks past the sidebar so the visible body is still in the plan', async () => {
  // DOM order puts the sidebar first; a cap applied to the walk would spend the
  // whole budget on the menu before the article is ever seen.
  const entries: Entry[] = [];
  // A long sidebar that comes first in DOM order but sits far down the page.
  for (let i = 0; i < 30; i += 1) entries.push({ text: `Menu ${i}`, top: 4000 + i, tag: 'a', attrs: { role: 'navigation' } });
  entries.push({ text: 'The article body', top: 120, tag: 'main' });

  const { translator, batches } = engine(entries, { maxNodes: 4 });
  await translator.translate();

  const sent = batches.flatMap((batch) => batch.texts);
  assert.ok(sent.includes('The article body'), 'the body is collected and translated');
  assert.ok(sent.length <= 4, 'but only the budget is paid for');
  assert.equal(batches[0]?.role, 'article', 'visible article text outranks visible menu labels');
});

test('a node the provider answered with nothing is retried, not marked done', async () => {
  // A 4B model returns an empty answer for some short labels. That is not a
  // translation: the node must stay eligible, or the page keeps that label in
  // the source language forever.
  const { document, texts } = page([{ text: 'Subspecies', top: 10 }, { text: 'The body', top: 40 }]);
  const asked: string[][] = [];
  let emptyFor: string | null = 'Subspecies';
  const translator = pipeline.create({
    doc: document,
    settings: () => ({ maxNodes: 600 }),
    viewportHeight: () => 800,
    translate: async (batch: never) => {
      const value = batch as unknown as { texts: string[] };
      asked.push([...value.texts]);
      return value.texts.map((text) => (text === emptyFor ? '' : `»${text}«`));
    }
  });

  const first = await translator.translate();
  assert.equal(first.translated, 1, 'only the paragraph landed');
  assert.equal(texts[0]!.nodeValue, 'Subspecies', 'the heading kept its source text');

  emptyFor = null;
  const second = await translator.refresh();
  assert.equal(second.requested, 1, 'the heading is asked again');
  assert.deepEqual(asked.at(-1), ['Subspecies'], 'and only the heading');
  assert.deepEqual(asked[1], ['The body'], 'the paragraph travelled in its own request');
  assert.equal(texts[0]!.nodeValue, '»Subspecies«');
  assert.equal(texts[1]!.nodeValue, '»The body«', 'the paragraph was not asked twice');
});

test('a background refresh takes only its slice of the page', async () => {
  // A page that keeps mutating (a video site re-rendering its feed) schedules
  // many small passes; each one must be small so another tab waiting on the
  // same model is not starved.
  const entries: Entry[] = Array.from({ length: 12 }, (_unused, index) => ({ text: `Block ${index}`, top: 100 + index * 40 }));
  const { translator, batches } = engine(entries);

  await translator.refresh(null, 3);
  assert.equal(
    batches.flatMap((batch) => batch.texts).length,
    3,
    'the pass translated its slice and stopped'
  );

  await translator.refresh(null, 3);
  const total = batches.flatMap((batch) => batch.texts).length;
  assert.equal(total, 6, 'the next pass continues where the last one stopped');
});

test('one refused role does not stop the rest of the page', async () => {
  // A provider that rate-limits a batch used to abort the whole pass: on YouTube
  // the title translated and the comments silently never did. The rest of the
  // page goes through, and the caller learns what failed.
  const { translator, texts, batches } = engine(
    [
      { text: 'Never Gonna Give You Up', top: 10, tag: 'h1', attrs: {} },
      { text: 'A comment far down', top: 4000, tag: 'p', attrs: {} }
    ],
    { failRole: 'unknown' }
  );

  const result = await translator.translate();
  assert.equal(result.failed, 1);
  assert.match(String(result.error), /provider refused/);
  assert.equal(result.translated, 1, 'what the provider answered is written');
  assert.equal(batches.length, 2, 'the later group was still attempted');
  assert.deepEqual(
    texts.map((node) => node.nodeValue),
    ['»Never Gonna Give You Up«', 'A comment far down'],
    'the refused group keeps its source text'
  );

  const again = await translator.translate();
  assert.equal(again.requested, 1, 'only the refused text is sent again');
  assert.equal(again.failed, 0, 'the retry went through');
  assert.deepEqual(texts[1]?.nodeValue, '»A comment far down«');
});

test('background passes advance through the page instead of re-translating the top', async () => {
  // A feed that rewrites its own headings on every tick used to eat the whole
  // budget: the comments at the bottom were never reached. A budgeted pass
  // starts where the last one stopped.
  const { translator, texts, batches } = engine(
    [
      { text: 'Headline', top: 10 },
      { text: 'Second line', top: 40 },
      { text: 'A comment', top: 3000 },
      { text: 'Another comment', top: 3060 }
    ],
    {}
  );

  const first = await translator.refresh(null, 2);
  assert.equal(first.requested, 2);
  assert.deepEqual(batches.map((batch) => batch.texts), [['Headline'], ['Second line']], 'one request per text');

  // The page rewrites the first heading: it is eligible again, but the cursor
  // has moved past it.
  const firstNode = texts[0]!;
  firstNode.nodeValue = 'Headline';
  const second = await translator.refresh(null, 2);
  assert.deepEqual(
    batches.map((batch) => batch.texts),
    [['Headline'], ['Second line'], ['A comment'], ['Another comment']],
    'the pass took the text it had not reached yet'
  );
  assert.equal(second.requested, 2);

  // The round is done; the next pass wraps and picks the rewritten heading up.
  // The page rewrote the heading; the next round reaches it again (from the
  // cache, so the provider is not asked a second time).
  const before = batches.length;
  const third = await translator.refresh(null, 2);
  assert.deepEqual(texts.map((node) => node.nodeValue), [
    '»Headline«',
    '»Second line«',
    '»A comment«',
    '»Another comment«'
  ]);
  assert.equal(third.failed, 0);
  assert.equal(batches.length, before, 'a rewritten node is answered from the cache');
});


test('initial work may yield so a moved viewport is replanned before the old offscreen tail', async () => {
  const e = engine(Array.from({ length: 90 }, (_, i) => ({ text: 'Article ' + i, top: i * 30 })));
  const initial = await e.translator.translate(8);
  assert.equal(initial.processedNodes, 8); assert.equal(initial.hasMore, true);
  for (let i = 8; i < 90; i++) e.texts[i]!.parentElement!.getBoundingClientRect = () => ({ top: -3000, bottom: -2980, width: 600, height: 20 });
  e.texts[89]!.parentElement!.getBoundingClientRect = () => ({ top: 100, bottom: 120, width: 600, height: 20 });
  const before = e.batches.length;
  const next = await e.translator.refresh(null, 8);
  assert.equal(e.batches[before]!.texts[0], 'Article 89');
  assert.equal(next.processedNodes, 8); assert.equal(next.hasMore, true);
  assert.ok(!e.texts[30]!.nodeValue.includes('»'), 'an old offscreen plan cannot consume the next slice first');
});


test('speed: 600 nodes over 38 continuations are measured once, not once per slice', async () => {
  const fixture = page(Array.from({ length: 600 }, (_, i) => ({ text: 'Unique phrase ' + i, top: i * 20 })));
  let measurements = 0, requests = 0;
  const translator = pipeline.create({ doc: fixture.document, settings: () => ({ maxNodes: 600 }),
    measure: (node: ATNamespace) => { measurements++; return node.parentElement.getBoundingClientRect(); },
    translate: async (batch: ATNamespace) => { requests += batch.texts.length; return batch.texts.map((s: string) => '»' + s + '«'); } });
  let result = await translator.translate(16), passes = 1;
  while (result.hasMore && passes < 50) { result = await translator.resume(16); passes++; }
  assert.equal(result.translated, 600); assert.equal(requests, 600); assert.equal(passes, 38);
  assert.equal(measurements, 600, 'existing queued candidates reuse their geometry and order');
  assert.equal(result.hasMore, false);
  assert.equal(translator.restore().restored, 600);
});

test('speed: an external change invalidates queued geometry and preserves new text on restore', async () => {
  const fixture = page([{ text: 'First original', top: 0 }, { text: 'Second original', top: 800 }, { text: 'Third original', top: 1600 }]);
  let measurements = 0;
  const translator = pipeline.create({ doc: fixture.document, settings: () => ({ maxNodes: 600 }),
    measure: (node: ATNamespace) => { measurements++; return node.parentElement.getBoundingClientRect(); },
    translate: async (batch: ATNamespace) => batch.texts.map((s: string) => '»' + s + '«') });
  await translator.translate(1);
  fixture.texts[1]!.nodeValue = 'Updated source'; translator.invalidatePlan();
  await translator.resume(1); await translator.resume(1);
  assert.equal(measurements, 5, 'remaining two nodes are measured exactly once after invalidation');
  translator.restore(); assert.equal(fixture.texts[1]!.nodeValue, 'Updated source');
});
