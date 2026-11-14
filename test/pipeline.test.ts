import test from 'node:test';
import assert from 'node:assert/strict';
import { load, type ATNamespace } from './helpers.ts';

// The page translation engine ties pagecontext + targets + dom together. The
// document stand-in is deliberately small: a parent element, a rect, two
// attributes and `contains` are all the engine may ask of a page.
const AT = load('lib/constants.js', 'lib/pagecontext.js', 'lib/targets.js', 'lib/dom.js', 'lib/pipeline.js');
const { pipeline } = AT;

function nextTurn(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

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
    ['unknown:Hello there', 'navigation:Home'],
    'generic prose is primary content even without an article landmark'
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
  const second = await translator.translate();
  assert.equal(second.requested, 1, 'the heading is asked again');
  assert.deepEqual(asked.at(-1), ['Subspecies'], 'and only the heading');
  assert.deepEqual(asked.flat(), ['Subspecies', 'The body', 'Subspecies'],
    'only the empty segment is paid for again');
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
  assert.deepEqual(batches.flatMap((batch) => batch.texts), ['Headline', 'Second line']);

  // The page rewrites the first heading: it is eligible again, but the cursor
  // has moved past it.
  const firstNode = texts[0]!;
  firstNode.nodeValue = 'Headline';
  const second = await translator.refresh(null, 2);
  assert.deepEqual(
    batches.flatMap((batch) => batch.texts),
    ['Headline', 'Second line', 'A comment', 'Another comment'],
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


test('a scroll re-ranks the queue instead of re-collecting the page', async () => {
  const e = engine(Array.from({ length: 90 }, (_, i) => ({ text: 'Article ' + i, top: i * 30 })));
  const first = await e.translator.translate(8);
  assert.equal(first.processedNodes, 8);
  assert.equal(first.hasMore, true);
  // The reader scrolls to the end of the page: the queue above is behind them.
  for (let i = 8; i < 90; i++) {
    e.texts[i]!.parentElement!.getBoundingClientRect = () => ({ top: -3000, bottom: -2980, width: 600, height: 20 });
  }
  e.texts[89]!.parentElement!.getBoundingClientRect = () => ({ top: 100, bottom: 120, width: 600, height: 20 });
  const ranked = e.translator.reprioritize();
  assert.equal(ranked.queued, 82, 'only what is still waiting is in the queue');
  assert.equal(ranked.visible, 1, 'exactly what scrolled into view is on screen now');
  const before = e.batches.length;
  await e.translator.resume(8);
  assert.equal(e.batches[before]!.texts[0], 'Article 89', 'what scrolled into view is translated first');
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

test('scrolling during an active request preserves and reorders the unsent tail', async () => {
  const fixture = page([
    { text: 'Page title', tag: 'h1', top: 10 },
    { text: 'Old first paragraph', tag: 'main', top: 100 },
    { text: 'Newly visible paragraph', tag: 'main', top: 3000 }
  ]);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const asked: string[] = [];
  const translator = pipeline.create({
    doc: fixture.document,
    settings: () => ({ maxNodes: 600 }),
    viewportHeight: () => 800,
    translate: async (batch: { texts: string[] }) => {
      asked.push(...batch.texts);
      if (batch.texts.includes('Page title')) { started.resolve(); await release.promise; }
      return batch.texts.map((text) => `»${text}«`);
    }
  });
  const active = translator.translate();
  await started.promise;
  fixture.texts[1]!.parentElement!.getBoundingClientRect = () => ({ top: -3000, bottom: -2980, width: 600, height: 20 });
  fixture.texts[2]!.parentElement!.getBoundingClientRect = () => ({ top: 100, bottom: 120, width: 600, height: 20 });
  assert.deepEqual(translator.reprioritize(), { visible: 1, queued: 2 });
  release.resolve();
  assert.equal((await active).hasMore, true);
  assert.deepEqual(asked, ['Page title'], 'the old unsent order is interrupted');
  const rest = await translator.resume();
  assert.deepEqual(asked, ['Page title', 'Newly visible paragraph', 'Old first paragraph']);
  assert.equal(rest.translated, 3);
  assert.equal(rest.hasMore, false);
  assert.equal(translator.restore().restored, 3);
});

test('viewport invalidation finishes one active quantum and parks the old window until scrolling back', async () => {
  const fixture = page(Array.from({ length: 21 }, (_, index) => ({
    text: `Reader comment ${index}`, tag: 'main', top: index === 20 ? 3000 : index * 30
  })));
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const asked: string[] = [];
  let calls = 0;
  const translator = pipeline.create({
    doc: fixture.document, settings: () => ({ maxNodes: 100 }), readingWindow: true,
    translate: async ({ texts }: { texts: string[] }) => {
      asked.push(...texts);
      if (++calls === 1) started.resolve();
      await release.promise;
      return texts.map((text) => `»${text}«`);
    }
  });
  const active = translator.translate();
  await started.promise;
  const dispatched = asked.length;
  for (const node of fixture.texts) {
    node.parentElement!.getBoundingClientRect = () => ({ top: -3000, bottom: -2980, width: 600, height: 20 });
  }
  fixture.texts[20]!.parentElement!.getBoundingClientRect = () => ({ top: 100, bottom: 120, width: 600, height: 20 });
  translator.invalidatePlan();
  release.resolve();
  const interrupted = await active;
  assert.equal(interrupted.hasMore, true);
  assert.equal(interrupted.failed, 0);
  assert.equal(asked.length, dispatched, 'in-flight requests commit, but no old-window refill starts');
  const result = await translator.resume();
  assert.equal(asked[dispatched], 'Reader comment 20');
  assert.equal(result.translated, 2, 'the active source committed after scrolling out');
  assert.equal(fixture.texts[0]!.nodeValue, '»Reader comment 0«');
  assert.equal(fixture.texts[1]!.nodeValue, 'Reader comment 1', 'unsent sources stay intact');
  assert.equal(result.hasMore, false, 'offscreen sources do not keep the continuation loop alive');
  for (let index = 0; index < 20; index++) {
    fixture.texts[index]!.parentElement!.getBoundingClientRect = () => ({ top: index * 30, bottom: index * 30 + 20, width: 600, height: 20 });
  }
  translator.invalidatePlan();
  let resumed = await translator.resume();
  for (let pass = 0; resumed.hasMore && pass < 30; pass++) resumed = await translator.resume();
  assert.equal(new Set(asked).size, 21);
  assert.equal(asked.length, 21, 'returning to the old window resumes without re-requesting completed sources');
  assert.equal(resumed.translated, 21);
  assert.equal(translator.restore().restored, 21);
});

test('target-language prose is left untouched without an echo failure', async () => {
  const fixture = page([
    { text: '행복해지셨으면 좋겠습니다', top: 10, tag: 'main' },
    { text: 'I hope you find happiness.', top: 50, tag: 'main' }
  ]);
  const asked: string[] = [];
  const translator = pipeline.create({
    doc: fixture.document, settings: () => ({ maxNodes: 100 }),
    shouldTranslate: (text: string) => !AT.isTargetLanguage(text, 'ko'),
    translate: async ({ texts }: { texts: string[] }) => {
      asked.push(...texts);
      return texts.map(() => '행복을 찾으시길 바랍니다.');
    }
  });
  const result = await translator.translate();
  assert.deepEqual(asked, ['I hope you find happiness.']);
  assert.equal(fixture.texts[0]!.nodeValue, '행복해지셨으면 좋겠습니다');
  assert.equal(result.failed, 0);
  assert.equal(result.hasMore, false);
  assert.equal(translator.restore().restored, 1);
});

test('generic div prose parks unread work and wakes it on reprioritization without a retry loop', async () => {
  const fixture = page([
    { text: 'Visible reply', top: 100, tag: 'div' },
    { text: 'Next-screen reply', top: 1000, tag: 'div' },
    { text: 'Unread distant reply', top: 5000, tag: 'div' },
    { text: 'Reader author', top: 60, tag: 'time' },
    { text: 'Distant recommendation', top: 4000, tag: 'aside' }
  ]);
  const asked: string[] = [];
  const translator = pipeline.create({
    doc: fixture.document, settings: () => ({ maxNodes: 100 }), readingWindow: true,
    translate: async ({ texts }: { texts: string[] }) => {
      asked.push(...texts);
      return texts.map(text => `»${text}«`);
    }
  });
  let result = await translator.translate();
  for (let pass = 0; result.hasMore && pass < 20; pass++) result = await translator.resume();
  assert.equal(result.hasMore, false, 'parked work does not keep an empty continuation spinning');
  assert.deepEqual(asked, ['Visible reply', 'Reader author']);
  assert.equal(fixture.texts[2]!.nodeValue, 'Unread distant reply');
  const before = asked.length;
  assert.equal((await translator.resume()).hasMore, false);
  assert.equal(asked.length, before);
  for (const node of fixture.texts) {
    node.parentElement!.getBoundingClientRect = () => ({ top: -4000, bottom: -3980, width: 600, height: 20 });
  }
  fixture.texts[2]!.parentElement!.getBoundingClientRect = () => ({ top: 100, bottom: 120, width: 600, height: 20 });
  assert.deepEqual(translator.reprioritize(), { visible: 1, queued: 3 });
  result = await translator.resume();
  assert.equal(asked[before], 'Unread distant reply');
  assert.equal(result.hasMore, false);
  assert.equal(translator.restore().restored, 3);
});

test('generic article work keeps one request active and lets newly visible prose overtake pending work', async () => {
  const fixture = page([
    { text: 'First visible reply', top: 100, tag: 'article' },
    { text: 'Old pending reply', top: 200, tag: 'article' },
    { text: 'New visible reply', top: 4000, tag: 'article' }
  ]);
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const asked: string[][] = [];
  let active = 0, maximum = 0;
  const translator = pipeline.create({
    doc: fixture.document, settings: () => ({ maxNodes: 100 }), readingWindow: true,
    translate: async ({ texts }: { texts: string[] }) => {
      asked.push(texts); maximum = Math.max(maximum, ++active);
      if (asked.length === 1) { started.resolve(); await release.promise; }
      active--;
      return texts.map(text => `»${text}«`);
    }
  });
  const running = translator.translate();
  await started.promise;
  assert.deepEqual(asked, [['First visible reply']]);
  fixture.texts[1]!.parentElement!.getBoundingClientRect = () => ({ top: -4000, bottom: -3980, width: 600, height: 20 });
  fixture.texts[2]!.parentElement!.getBoundingClientRect = () => ({ top: 150, bottom: 170, width: 600, height: 20 });
  translator.invalidatePlan();
  release.resolve();
  assert.equal((await running).hasMore, true);
  let result = await translator.resume();
  for (let pass = 0; result.hasMore && pass < 10; pass++) result = await translator.resume();
  assert.deepEqual(asked, [['First visible reply'], ['New visible reply']]);
  assert.equal(maximum, 1);
  assert.equal(fixture.texts[1]!.nodeValue, 'Old pending reply');
  assert.equal(result.failed, 0);
});

test('long card text retains exact source through bounded work and completes every suffix', async () => {
  const source = Array.from({ length: 20 }, (_, index) => `Reader ${index} describes the changing weather and power network. `).join('');
  const fixture = page([{ text: source, top: 100, tag: 'div', attrs: { class: 'card' } }]);
  const asked: string[] = [];
  const translator = pipeline.create({
    doc: fixture.document, settings: () => ({ maxNodes: 100 }), readingWindow: true,
    translate: async ({ texts }: { texts: string[] }) => {
      asked.push(...texts);
      return texts.map(text => text.toUpperCase());
    }
  });
  let result = await translator.translate();
  assert.equal(result.hasMore, true);
  assert.equal(result.translated, 0, 'a prefix is not a completed comment');
  for (let pass = 0; result.hasMore && pass < 50; pass++) result = await translator.resume();
  assert.equal(result.hasMore, false);
  assert.equal(result.translated, 1);
  assert.ok(asked.every(text => text.length <= AT.C.PACKED_TEXT_CHARS));
  assert.equal(fixture.texts[0]!.nodeValue, source.toUpperCase());
  translator.restore();
  assert.equal(fixture.texts[0]!.nodeValue, source);
});

test('unchanged failed comment fragments do not consume every mutation tick', async () => {
  const fixture = page([{ text: 'A refused reader comment', top: 100, attrs: { class: 'comment-body' } }]);
  let calls = 0;
  const translator = pipeline.create({
    doc: fixture.document, settings: () => ({ maxNodes: 100 }), readingWindow: true,
    translate: async ({ texts }: { texts: string[] }) => {
      if (++calls === 1) throw new Error('provider refused this comment');
      return texts.map(text => `»${text}«`);
    }
  });
  await assert.rejects(translator.translate(), /provider refused/);
  translator.invalidatePlan();
  const parked = await translator.refresh();
  assert.equal(calls, 1);
  assert.equal(parked.hasMore, false);
  assert.equal(parked.failed, 1, 'parking is not successful translation or suppressed error');
  fixture.texts[0]!.nodeValue = 'The reader edited this comment';
  translator.invalidatePlan();
  const edited = await translator.refresh();
  assert.equal(calls, 2);
  assert.equal(edited.failed, 0);
  assert.equal(fixture.texts[0]!.nodeValue, '»The reader edited this comment«');
});

test('a failed bounded request does not discard the unattempted comments behind it', async () => {
  for (const failure of ['throw', 'echo']) {
    const fixture = page([
      { text: 'First reader comment', top: 100, attrs: { class: 'comment-body' } },
      { text: 'Second reader comment', top: 200, attrs: { class: 'comment-body' } }
    ]);
    const asked: string[] = [];
    const translator = pipeline.create({
      doc: fixture.document, settings: () => ({ maxNodes: 100 }), readingWindow: true,
      translate: async ({ texts }: { texts: string[] }) => {
        asked.push(...texts);
        if (asked.length === 1) {
          if (failure === 'throw') throw new Error('refused first comment');
          return texts;
        }
        return texts.map(text => `»${text}«`);
      }
    });
    const first = await translator.translate();
    assert.equal(first.failed, 1, failure);
    assert.equal(first.hasMore, true, failure);
    const second = await translator.resume();
    assert.deepEqual(asked, ['First reader comment', 'Second reader comment'], failure);
    assert.equal(second.hasMore, false, failure);
    assert.equal(second.failed, 1, 'the original failure remains visible');
    assert.equal(fixture.texts[1]!.nodeValue, '»Second reader comment«');
  }
});

test('a sole active card commits offscreen and invalidation wakes newly visible parked work', async () => {
  const fixture = page([
    { text: 'First original card', top: 100, tag: 'div' },
    { text: 'Second original card', top: 4000, tag: 'div' }
  ]);
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const asked: string[] = [];
  const translator = pipeline.create({
    doc: fixture.document, settings: () => ({ maxNodes: 100 }), readingWindow: true,
    translate: async ({ texts }: { texts: string[] }) => {
      asked.push(...texts);
      if (asked.length === 1) { started.resolve(); await release.promise; }
      return texts.map(text => `»${text}«`);
    }
  });
  const running = translator.translate();
  await started.promise;
  fixture.texts[0]!.parentElement!.getBoundingClientRect = () => ({ top: -4000, bottom: -3980, width: 600, height: 20 });
  fixture.texts[1]!.parentElement!.getBoundingClientRect = () => ({ top: 100, bottom: 120, width: 600, height: 20 });
  translator.invalidatePlan();
  release.resolve();
  assert.equal((await running).hasMore, true);
  assert.equal(fixture.texts[0]!.nodeValue, '»First original card«', 'scrolling cannot revoke an active answer');
  assert.equal((await translator.resume()).hasMore, false);
  assert.deepEqual(asked, ['First original card', 'Second original card']);
  assert.equal(translator.restore().restored, 2);
  assert.deepEqual(fixture.texts.map(node => node.nodeValue), ['First original card', 'Second original card']);
});

test('an offscreen partial card retains its committed prefix and resumes its original suffix on return', async () => {
  const source = 'The first card contains a long explanation of changing energy systems. '.repeat(15);
  const fixture = page([{ text: source, top: 100, tag: 'div' }]);
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const asked: string[] = [];
  const translator = pipeline.create({
    doc: fixture.document, settings: () => ({ maxNodes: 100 }), readingWindow: true,
    translate: async ({ texts }: { texts: string[] }) => {
      asked.push(...texts);
      if (asked.length === 1) { started.resolve(); await release.promise; }
      return texts.map(text => text.toUpperCase());
    }
  });
  const running = translator.translate();
  await started.promise;
  fixture.texts[0]!.parentElement!.getBoundingClientRect = () => ({ top: -4000, bottom: -3980, width: 600, height: 20 });
  translator.invalidatePlan();
  release.resolve();
  await running;
  const committed = fixture.texts[0]!.nodeValue;
  assert.notEqual(committed, source);
  assert.ok(committed.includes('changing energy systems.'), 'the untranslated suffix remains readable');
  const parked = await translator.resume();
  assert.equal(parked.hasMore, false);
  assert.equal(asked.length, 1);
  assert.equal(fixture.texts[0]!.nodeValue, committed, 'parking never restores or drops committed text');
  fixture.texts[0]!.parentElement!.getBoundingClientRect = () => ({ top: 100, bottom: 120, width: 600, height: 20 });
  translator.reprioritize();
  let resumed = await translator.resume();
  for (let pass = 0; resumed.hasMore && pass < 30; pass++) resumed = await translator.resume();
  assert.equal(resumed.hasMore, false);
  assert.equal(resumed.translated, 1);
  assert.equal(fixture.texts[0]!.nodeValue, source.toUpperCase());
  translator.restore();
  assert.equal(fixture.texts[0]!.nodeValue, source);
});

test('visible support precedes near body in both initial and reprioritized plans', async () => {
  const fixture = page([
    { text: 'First main heading', tag: 'h1', top: 10 },
    { text: 'Visible navigation', tag: 'nav', top: 100 },
    { text: 'Next screen body', tag: 'article', top: 1000 }
  ]);
  const asked: string[] = [];
  const translator = pipeline.create({
    doc: fixture.document, settings: () => ({ maxNodes: 100 }), readingWindow: true,
    translate: async ({ texts }: { texts: string[] }) => { asked.push(...texts); return texts.map(text => `»${text}«`); }
  });
  await translator.translate();
  translator.reprioritize();
  await translator.resume();
  await translator.resume();
  assert.deepEqual(asked, ['First main heading', 'Visible navigation']);
  await translator.prefetch();
  assert.deepEqual(asked, ['First main heading', 'Visible navigation', 'Next screen body']);
});

test('visible partial prose completes an ordinary reading unit without comment ping-pong', async () => {
  const source = Array.from({ length: 24 }, (_, index) => `A long original paragraph ${index} explains the winter power network. `).join('');
  const fixture = page([{ text: source, top: 100 }, { text: 'Another visible paragraph', top: 200 }]);
  const asked: string[] = [];
  const translator = pipeline.create({
    doc: fixture.document, settings: () => ({ maxNodes: 100 }), readingWindow: true,
    translate: async ({ texts }: { texts: string[] }) => { asked.push(...texts); return texts.map(text => text.toUpperCase()); }
  });
  await translator.translate();
  await translator.resume();
  assert.equal(asked.length, 2);
  assert.ok(asked.every(text => text !== 'Another visible paragraph'));
  let result = await translator.resume();
  assert.notEqual(asked[2], 'Another visible paragraph', 'ordinary prose keeps its reading unit beyond two quanta');
  for (let pass = 0; result.hasMore && pass < 30; pass++) result = await translator.resume();
  assert.equal(result.translated, 2, 'the long paragraph is not abandoned or starved');
  assert.equal(asked.at(-1), 'Another visible paragraph', 'the next unit starts after the first completes');
  assert.equal(fixture.texts[0]!.nodeValue, source.toUpperCase());
  translator.restore();
  assert.equal(fixture.texts[0]!.nodeValue, source);
});

test('explicit reader engagement is bounded and never cancels an active quantum', async () => {
  const source = Array.from({ length: 24 }, (_, index) => `Selected sidebar explanation ${index} of the energy storage system. `).join('');
  const fixture = page([
    { text: 'Active reading paragraph', top: 10 },
    { text: 'Unfinished main reading', top: 100 },
    { text: source, top: 200, tag: 'aside' }
  ]);
  const selected = fixture.texts[2]!.parentElement!;
  selected.contains = ((node: unknown) => node === fixture.texts[2]) as typeof selected.contains;
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const asked: string[] = [];
  const translator = pipeline.create({
    doc: fixture.document, settings: () => ({ maxNodes: 100 }), readingWindow: true,
    translate: async ({ texts }: { texts: string[] }) => {
      asked.push(...texts);
      if (asked.length === 1) { started.resolve(); await release.promise; }
      return texts.map(text => text.toUpperCase());
    }
  });
  const active = translator.translate();
  await started.promise;
  translator.engage(selected);
  release.resolve();
  await active;
  assert.equal(fixture.texts[0]!.nodeValue, 'ACTIVE READING PARAGRAPH');
  await translator.resume();
  await translator.resume();
  assert.ok(asked.slice(1, 3).every(text => source.includes(text)), 'the selected visible subtree gets two quanta');
  await translator.resume();
  assert.equal(asked[3], 'Unfinished main reading', 'persistent focus does not monopolize the model');
  translator.restore();
  assert.equal(fixture.texts[2]!.nodeValue, source);
});

test('pathological reading units yield after a generous cap and viewport changes override continuity', async () => {
  const source = Array.from({ length: 350 }, (_, index) => `Original explanation number ${index} of winter energy systems. `).join('');
  const fixture = page([{ text: source, top: 100 }, { text: 'Other visible prose', top: 200 }]);
  const asked: string[] = [];
  const translator = pipeline.create({
    doc: fixture.document, settings: () => ({ maxNodes: 100 }), readingWindow: true,
    translate: async ({ texts }: { texts: string[] }) => { asked.push(...texts); return texts.map(text => text.toUpperCase()); }
  });
  await translator.translate();
  for (let pass = 1; pass < 32; pass++) await translator.resume();
  assert.equal(asked.length, 32);
  assert.ok(!asked.includes('Other visible prose'));
  await translator.resume();
  assert.equal(asked[32], 'Other visible prose');
  fixture.texts[1]!.nodeValue = 'Newly visible reader priority';
  fixture.texts[1]!.parentElement!.getBoundingClientRect = () => ({ top: 0, bottom: 20, width: 600, height: 20 });
  translator.invalidatePlan(true);
  await translator.resume();
  assert.equal(asked.at(-1), 'Newly visible reader priority');
});

test('parallel mode dispatches two independent bounded comments, orders commits and aborts both on OFF', async () => {
  const sources = ['First', 'Second'].map(label =>
    Array.from({ length: 18 }, (_, index) => `${label} original comment ${index} has many interesting observations. `).join(''));
  const fixture = page(sources.map((text, index) => ({ text, top: 100 + index * 100, attrs: { class: 'comment-body' } })));
  const gates: { texts: string[]; signal: AbortSignal; fragmentConcurrency: number; resolve: (value: string[]) => void }[] = [];
  const translator = pipeline.create({
    doc: fixture.document, settings: () => ({ maxNodes: 100, translationConcurrency: 2 }), readingWindow: true,
    translate: ({ texts, signal, fragmentConcurrency }: { texts: string[]; signal: AbortSignal; fragmentConcurrency: number }) => {
      const { promise, resolve } = Promise.withResolvers<string[]>();
      gates.push({ texts, signal, fragmentConcurrency, resolve });
      return promise;
    }
  });
  const running = translator.translate();
  for (let turn = 0; gates.length < 2 && turn < 20; turn++) await Promise.resolve();
  assert.equal(gates.length, 2, 'both first fragments start before either whole comment completes');
  assert.ok(gates.every(gate => gate.texts.length === 1 && gate.texts[0]!.length <= AT.C.PACKED_TEXT_CHARS));
  assert.ok(gates.every(gate => gate.fragmentConcurrency === 2), 'each visible unit can borrow a released background generation slot');
  assert.ok(gates[0]!.texts[0]!.startsWith('First'));
  assert.ok(gates[1]!.texts[0]!.startsWith('Second'));
  gates[1]!.resolve(gates[1]!.texts.map(text => text.toUpperCase()));
  for (let turn = 0; turn < 10; turn++) await Promise.resolve();
  assert.deepEqual(fixture.texts.map(node => node.nodeValue), sources, 'lower completion cannot overtake upper commit');
  gates[0]!.resolve(gates[0]!.texts.map(text => text.toUpperCase()));
  assert.equal((await running).hasMore, true);
  assert.ok(fixture.texts.every((node, index) => node.nodeValue !== sources[index]));
  const resumed = translator.resume();
  for (let turn = 0; gates.length < 4 && turn < 20; turn++) await Promise.resolve();
  assert.equal(gates.length, 4, 'exactly two suffix requests, not concurrent suffixes of one comment');
  translator.restore();
  assert.ok(gates.slice(2).every(gate => gate.signal.aborted));
  gates.slice(2).forEach(gate => gate.resolve(['LATE TRANSLATION']));
  await resumed;
  assert.deepEqual(fixture.texts.map(node => node.nodeValue), sources);
  assert.equal(translator.stats().translated, 0);
});

test('parallel failure releases the next independent unit and preserves immutable roles', async () => {
  const fixture = page([{ text: 'Upper article paragraph', top: 10, tag: 'article' },
    { text: 'Lower reader reply', top: 100, attrs: { class: 'comment-body' } }]);
  const gates: { role: string; texts: string[]; resolve: (texts: string[]) => void; reject: (error: Error) => void }[] = [];
  const translator = pipeline.create({
    doc: fixture.document, settings: () => ({ maxNodes: 100, translationConcurrency: 2 }), readingWindow: true,
    translate: ({ texts, role }: { texts: string[]; role: string }) => {
      const { promise, resolve, reject } = Promise.withResolvers<string[]>();
      gates.push({ texts, role, resolve, reject });
      return promise;
    }
  });
  const running = translator.translate();
  for (let turn = 0; gates.length < 2 && turn < 20; turn++) await Promise.resolve();
  assert.deepEqual(Object.fromEntries(gates.map(gate => [gate.role, gate.texts])), {
    article: ['Upper article paragraph'], comment: ['Lower reader reply']
  });
  gates.find(gate => gate.role === 'comment')!.resolve(['LOWER READER REPLY']);
  gates.find(gate => gate.role === 'article')!.reject(new Error('upper refused'));
  const result = await running;
  assert.equal(result.failed, 1);
  assert.equal(result.translated, 1);
  assert.equal(result.hasMore, false);
  assert.equal(fixture.texts[1]!.nodeValue, 'LOWER READER REPLY');
});

test('idle prefetch reaches distant next content one quantum at a time without retrying failures', async () => {
  const fixture = page([{ text: 'Visible source', top: 10 },
    { text: 'Farther source', top: 6000 }, { text: 'Nearest distant source', top: 4000 }]);
  const asked: string[] = [];
  const translator = pipeline.create({
    doc: fixture.document, settings: () => ({ maxNodes: 100, translationConcurrency: 2 }), readingWindow: true,
    translate: async ({ texts }: { texts: string[] }) => {
      asked.push(...texts);
      if (texts[0] === 'Farther source') throw new Error('offscreen refused');
      return texts.map(text => text.toUpperCase());
    }
  });
  assert.equal((await translator.translate()).hasMore, false);
  assert.deepEqual(asked, ['Visible source']);
  assert.equal((await translator.prefetch()).hasMore, true);
  assert.deepEqual(asked, ['Visible source', 'Nearest distant source']);
  await assert.rejects(translator.prefetch(), /offscreen refused/);
  assert.equal((await translator.prefetch()).hasMore, false);
  assert.equal(asked.length, 3);
});

test('a many-node comment does not hide the independent second lane behind the node budget', async () => {
  const fixture = page([
    { text: 'First original comment fragment', top: 100, attrs: { class: 'comment' } },
    { text: 'Another fragment in the first comment', top: 110 },
    { text: 'Third fragment in the first comment', top: 120 },
    { text: 'Independent second comment', top: 200, attrs: { class: 'comment' } }
  ]);
  const first = fixture.texts[0]!.parentElement!;
  for (const node of fixture.texts.slice(1, 3)) {
    const previous = node.parentElement!;
    previous.childNodes = [];
    node.parentElement = first;
    first.childNodes.push(node);
  }
  const gates: { texts: string[]; resolve: (texts: string[]) => void }[] = [];
  const translator = pipeline.create({
    doc: fixture.document, settings: () => ({ maxNodes: 2, translationConcurrency: 2 }), readingWindow: true,
    translate: ({ texts }: { texts: string[] }) => {
      const { promise, resolve } = Promise.withResolvers<string[]>();
      gates.push({ texts, resolve });
      return promise;
    }
  });
  const running = translator.translate();
  for (let turn = 0; gates.length < 2 && turn < 20; turn++) await Promise.resolve();
  assert.deepEqual(gates.map(gate => gate.texts), [
    ['First original comment fragment'], ['Independent second comment']
  ]);
  gates.forEach(gate => gate.resolve(gate.texts.map(text => text.toUpperCase())));
  assert.equal((await running).hasMore, true, 'the first comment retains its unattempted siblings');
  assert.equal(fixture.texts[1]!.nodeValue, 'Another fragment in the first comment');
});

test('one visible reading unit borrows both fragment slots, idle prefetch stays serial', async () => {
  const fixture = page([{ text: '図書館は電子書籍の貸し出しを始めます。利用期間は十四日です。', top: 100 },
    { text: '説明会は毎週土曜日に開かれます。', top: 4000 }]);
  const widths: number[] = [];
  const translator = pipeline.create({
    doc: fixture.document, settings: () => ({ maxNodes: 100, translationConcurrency: 2 }), readingWindow: true,
    translate: async ({ texts, fragmentConcurrency }: { texts: string[]; fragmentConcurrency: number }) => {
      widths.push(fragmentConcurrency);
      return texts.map(() => '도서관 안내 번역입니다.');
    }
  });
  await translator.translate();
  await translator.prefetch();
  assert.deepEqual(widths, [2, 1]);
});

test('whole-document admission bounds each selected width and commits independent ready units', async () => {
  for (const width of [1, 2, 4, 8]) {
    const sources = Array.from({ length: 12 }, (_, index) => `Independent paragraph ${index}`);
    const fixture = page(sources.map((text, index) => ({ text, top: index * 1000 })));
    const gates: { texts: string[]; resolve: (answers: string[]) => void }[] = [];
    let active = 0, peak = 0;
    const translator = pipeline.create({
      doc: fixture.document, settings: () => ({ maxNodes: 100, translationConcurrency: width }),
      translate: async ({ texts, fragmentConcurrency }: { texts: string[]; fragmentConcurrency: number }) => {
        assert.equal(fragmentConcurrency, width);
        peak = Math.max(peak, ++active);
        const gate = Promise.withResolvers<string[]>();
        gates.push({ texts, resolve: gate.resolve });
        try { return await gate.promise; } finally { active--; }
      }
    });
    const running = translator.translate();
    await nextTurn();
    assert.equal(gates.length, width);
    if (width > 1) {
      gates[1]!.resolve(gates[1]!.texts.map(text => text.toUpperCase()));
      await nextTurn();
      assert.equal(fixture.texts[0]!.nodeValue, sources[0]);
      assert.equal(fixture.texts[1]!.nodeValue, sources[1]!.toUpperCase());
      assert.equal(gates.length, width + 1, 'a completed lower unit refills without waiting for the first');
    }
    for (let index = 0; index < sources.length; index++) {
      const gate = gates[index];
      assert.ok(gate, `request ${index} is eventually admitted at width ${width}`);
      gate.resolve(gate.texts.map(text => text.toUpperCase()));
      await nextTurn();
    }
    const result = await running;
    assert.equal(peak, width);
    assert.equal(result.translated, sources.length);
    assert.equal(result.hasMore, false);
    assert.deepEqual(fixture.texts.map(node => node.nodeValue), sources.map(text => text.toUpperCase()));
    assert.equal(translator.restore().restored, sources.length);
    assert.deepEqual(fixture.texts.map(node => node.nodeValue), sources);
  }
});

test('whole-document slices finish offscreen support and exclude unmeasurable or editable sources', async () => {
  const fixture = page([
    { text: 'Below the document view', top: 4000 },
    { text: 'Above the document view', top: -4000 },
    { text: 'Visible paragraph', top: 100 },
    { text: 'Distant footer text', top: 8000, tag: 'footer' },
    { text: 'Clipped source', top: Infinity },
    { text: 'Editable source', top: 200 }
  ]);
  const sources = fixture.texts.map(node => node.nodeValue);
  fixture.texts[5]!.parentElement!.isContentEditable = true;
  const asked: string[] = [];
  const translator = pipeline.create({
    doc: fixture.document, settings: () => ({ maxNodes: 1, translationConcurrency: 8 }),
    translate: async ({ texts }: { texts: string[] }) => { asked.push(...texts); return texts.map(text => text.toUpperCase()); }
  });
  let result = await translator.translate();
  assert.deepEqual(asked, ['Visible paragraph']);
  for (let pass = 0; result.hasMore && pass < 10; pass++) result = await translator.resume();
  assert.equal(result.hasMore, false);
  assert.equal(result.translated, 4);
  assert.deepEqual(new Set(asked), new Set(sources.slice(0, 4)));
  assert.equal(fixture.texts[4]!.nodeValue, 'Clipped source');
  assert.equal(fixture.texts[5]!.nodeValue, 'Editable source');
  assert.equal((await translator.resume()).hasMore, false);
  assert.equal(asked.length, 4);
  assert.equal(translator.restore().restored, 4);
});

test('whole-document duplicate units share in-flight work while context remains isolated', async () => {
  const fixture = page([
    { text: 'Repeated source', top: 100 },
    { text: 'Repeated source', top: 200 },
    { text: 'Repeated source', top: 300, tag: 'nav' }
  ]);
  const gates: { role: string; resolve: (answers: string[]) => void }[] = [];
  const translator = pipeline.create({
    doc: fixture.document, settings: () => ({ maxNodes: 100, translationConcurrency: 4 }),
    translate: ({ role }: { role: string }) => {
      const gate = Promise.withResolvers<string[]>();
      gates.push({ role, resolve: gate.resolve });
      return gate.promise;
    }
  });
  const running = translator.translate();
  await nextTurn();
  assert.deepEqual(gates.map(gate => gate.role), ['unknown', 'navigation']);
  gates.forEach(gate => gate.resolve(['REPEATED SOURCE']));
  const result = await running;
  assert.equal(result.translated, 3);
  assert.equal(result.hasMore, false);
  assert.equal(translator.restore().restored, 3);
});

test('whole-page admission preserves bounded source partitions and exact restoration', async () => {
  const source = Array.from({ length: 20 }, (_, index) =>
    `Sentence ${index} keeps the original context and never drops the remaining source.`
  ).join(' ');
  const requests: string[][] = [];
  for (const readingWindow of [true, false]) {
    const fixture = page([{ text: source, top: 100 }]);
    const asked: string[] = [];
    const translator = pipeline.create({
      doc: fixture.document, settings: () => ({ maxNodes: 100, translationConcurrency: 8 }),
      readingWindow,
      ...(!readingWindow ? { workLimit: () => ({ maxChars: AT.C.PACKED_TEXT_CHARS, maxTexts: 1 }) } : {}),
      sentences: { split: AT.targets.sentences, maxChars: AT.C.SENTENCE_MAX_CHARS, always: false },
      translate: async ({ texts }: { texts: string[] }) => {
        asked.push(...texts);
        return texts.map(text => text.toUpperCase());
      }
    });
    let result = await translator.translate();
    for (let pass = 0; result.hasMore && pass < 20; pass++) result = await translator.resume();
    assert.equal(result.hasMore, false);
    assert.equal(fixture.texts[0]!.nodeValue, source.toUpperCase());
    assert.ok(asked.every(text => text.length <= AT.C.PACKED_TEXT_CHARS));
    assert.equal(asked.join(' ').replace(/\s+/g, ' '), source);
    requests.push(asked);
    translator.restore();
    assert.equal(fixture.texts[0]!.nodeValue, source);
  }
  assert.deepEqual(requests[1], requests[0], 'admission must not change model inputs');
});
