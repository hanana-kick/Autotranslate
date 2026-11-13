import assert from 'node:assert/strict';
import test from 'node:test';
import { load, resetGlobals, type ATNamespace } from './helpers.ts';

// --- minimal DOM stand-in ---------------------------------------------------
// The engine only ever reads nodeType / nodeValue / parentElement / childNodes
// / tagName / isContentEditable / closest(), so a stub is enough to pin its
// behaviour without pulling in a DOM dependency.

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
  attrs: Record<string, unknown>;
  classes: string[];
  isContentEditable: boolean;
  nodeValue?: string;
  closest?: (matcher: string) => StubNode | null;
  contains?: (other: StubNode) => boolean;
};

type StubNode = StubText | StubElement;

type StubProps = { attrs?: Record<string, unknown>; classes?: string[]; editable?: boolean };

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

function el(tag: string, props: StubProps = {}, children: StubNode[] = []): StubElement {
  const { attrs = {}, classes = [], editable = false } = props;
  const node: StubElement = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    childNodes: [],
    parentElement: null,
    attrs,
    classes,
    isContentEditable: editable
  };
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
  for (const child of children) {
    child.parentElement = node;
    node.childNodes.push(child);
  }
  return node;
}

function textContent(node: StubNode) {
  let out = '';
  for (const child of node.childNodes ?? []) out += child.nodeType === 3 ? child.nodeValue : textContent(child);
  return out;
}

function textNodes(node: StubNode, out: StubText[] = []) {
  for (const child of node.childNodes ?? []) {
    if (child.nodeType === 3) out.push(child);
    else textNodes(child, out);
  }
  return out;
}

function harness(body: StubElement, provider: (texts: string[]) => string[] | Promise<string[]>, options: ATNamespace = {}) {
  resetGlobals();
  const AT = load('lib/constants.js', 'lib/dom.js');
  const document = { nodeType: 9, documentElement: body };
  const calls: string[][] = [];
  const translator = AT.dom.createTranslator({
    doc: document,
    translate: async (texts: string[]) => {
      calls.push([...texts]);
      return provider(texts);
    },
    ...options
  });
  return { AT, body, calls, translator };
}

const upcase = (texts: string[]) => texts.map((text) => text.toUpperCase());

// --- pure helpers ----------------------------------------------------------

test('splitWhitespace keeps the layout apart from the content', () => {
  resetGlobals();
  const AT = load('lib/constants.js', 'lib/dom.js');
  assert.deepEqual(AT.dom.splitWhitespace('  Hello \n'), { lead: '  ', core: 'Hello', trail: ' \n' });
  assert.deepEqual(AT.dom.splitWhitespace('one two'), { lead: '', core: 'one two', trail: '' });
  assert.deepEqual(AT.dom.splitWhitespace('   '), { lead: '   ', core: '', trail: '' });
});

// --- run merging -----------------------------------------------------------

test('a sentence split by inline elements is translated as one sentence', async () => {
  const strong = el('strong', {}, [t('5 items')]);
  const paragraph = el('p', {}, [t('Total '), strong, t(' left')]);
  // The existing numbered engine contract preserves each segment identity.
  const labels: Record<string, string> = { Total: '합계', '5 items': '5개 항목', left: '남음' };
  const { calls, translator, body } = harness(el('div', {}, [paragraph]), (texts) =>
    texts.map((value) => labels[value]!)
  );

  const result = await translator.translateRoot(body);

  assert.equal(calls.length, 1, 'one batch');
  assert.deepEqual(calls[0], ['Total', '5 items', 'left'], 'the indexed batch carries verifiable boundaries without a wasted marker attempt');
  assert.deepEqual(
    textNodes(paragraph).map((node) => node.nodeValue),
    ['합계 ', '5개 항목', ' 남음'],
    'each node keeps its own element, and words stay whole'
  );
  assert.equal(textContent(paragraph), '합계 5개 항목 남음');
  assert.equal(result.runs, 1, 'the run counts as merged');
  assert.equal(translator.stats().translated, 3);
});

test('an indexed inline batch preserves each element without a preliminary generation', async () => {
  const paragraph = el('p', {}, [t('left side '), el('em', {}, [t('middle')]), t(' right side')]);
  const dictionary: Record<string, string> = { 'left side': '왼쪽', middle: '가운데', 'right side': '오른쪽' };
  const { translator, body, calls } = harness(el('div', {}, [paragraph]), (texts) => texts.map((value) => dictionary[value] ?? '짧은 답'));
  await translator.translateRoot(body);
  assert.equal(calls.length, 1, 'aligned fragments share one request and no speculative marker generation');
  assert.deepEqual(textNodes(paragraph).map((node) => node.nodeValue), ['왼쪽 ', '가운데', ' 오른쪽']);
  assert.equal(textContent(paragraph), '왼쪽 가운데 오른쪽');
});

test('a block element or a line break ends a run', async () => {
  const first = el('p', {}, [t('first half'), el('br', {}, []), t('second half')]);
  const second = el('p', {}, [t('other paragraph')]);
  const { calls, translator, body } = harness(el('div', {}, [first, second]), upcase);

  await translator.translateRoot(body);

  assert.deepEqual(calls.flat(), ['first half', 'second half', 'other paragraph'], 'each visual line is its own segment');
  assert.ok(!calls.flat().includes('first halfsecond half'), 'paragraphs are never glued');
  assert.ok(!calls.flat().includes('second halfother paragraph'), 'paragraphs are never glued');
  assert.equal(textContent(first), 'FIRST HALFSECOND HALF');
  assert.equal(textContent(second), 'OTHER PARAGRAPH');
});

test('an ignored inline element is a protected boundary', async () => {
  const code = el('code', {}, [t('npm test')]);
  const paragraph = el('p', {}, [t('Run '), code, t(' now')]);
  const { calls, translator, body } = harness(el('div', {}, [paragraph]), upcase);

  await translator.translateRoot(body);

  assert.deepEqual(calls.flat(), ['Run', 'now'], 'do not merge around omitted code');
  assert.ok(!calls.flat().join(' ').includes('npm test'), 'the code text is never sent');
  assert.equal(textContent(code), 'npm test', 'code is untouched');
  assert.equal(textContent(paragraph), 'RUN npm test NOW');
});

test('useless or forbidden text is never sent', async () => {
  const kept = el('pre', {}, [t('const x = 1;')]);
  const box = el('textarea', {}, [t('type here')]);
  const note = el('p', { classes: ['notranslate'] }, [t('keep me')]);
  const explicit = el('p', { attrs: { translate: 'no' } }, [t('also keep')]);
  const editable = el('div', { editable: true }, [t('user draft')]);
  const empty = el('span', {}, [t(' ! ')]);
  const wanted = el('p', {}, [t('translate me')]);
  const root = el('div', {}, [kept, box, note, explicit, editable, empty, wanted]);
  const { calls, translator } = harness(root, upcase);

  await translator.translateRoot(root);

  assert.deepEqual(calls[0], ['TRANSLATE ME'.toLowerCase()], 'only the wanted sentence is requested');
  assert.equal(textContent(kept), 'const x = 1;');
  assert.equal(textContent(box), 'type here');
  assert.equal(textContent(note), 'keep me');
  assert.equal(textContent(explicit), 'also keep');
  assert.equal(textContent(editable), 'user draft');
  assert.equal(textContent(empty), ' ! ');
});

test('maxNodes caps how much is walked', async () => {
  const paragraphs = Array.from({ length: 5 }, (_, index) => el('p', {}, [t(`sentence ${index}`)]));
  const root = el('div', {}, paragraphs);
  const { translator } = harness(root, upcase, { maxNodes: 2 });

  await translator.translateRoot(root);

  assert.deepEqual(
    paragraphs.map((node) => textContent(node)),
    ['SENTENCE 0', 'SENTENCE 1', 'sentence 2', 'sentence 3', 'sentence 4']
  );
});

// --- originals, idempotency, restore ---------------------------------------

test('restore puts back the original bytes and clears the state', async () => {
  const node = t('Caf\u00e9  \u00a0open  ');
  const paragraph = el('p', {}, [node]);
  const { translator, body } = harness(el('div', {}, [paragraph]), upcase);
  const before = node.nodeValue;

  await translator.translateRoot(body);
  assert.equal(node.nodeValue, 'CAF\u00c9  \u00a0OPEN  ', 'whitespace envelope is re-applied');

  const result = translator.restore(body);
  assert.equal(result.restored, 1);
  assert.equal(node.nodeValue, before);
  assert.equal(translator.stats().translated, 0);
});

test('translated text is skipped next time, re-translated after a page rewrite', async () => {
  const node = t('fresh news');
  const paragraph = el('p', {}, [node]);
  const { calls, translator, body } = harness(el('div', {}, [paragraph]), upcase);

  await translator.translateRoot(body);
  assert.equal(node.nodeValue, 'FRESH NEWS');

  const second = await translator.translateRoot(body);
  assert.equal(second.requested, 0, 'nothing to redo');
  assert.equal(calls.length, 1);

  node.nodeValue = 'inserted by the page';
  const third = await translator.translateRoot(body);
  assert.equal(third.requested, 1, 'the rewritten node is picked up again');
  assert.equal(node.nodeValue, 'INSERTED BY THE PAGE');
});

test('the same sentence is requested once and reused', async () => {
  const make = () => el('p', {}, [t('sold out')]);
  const { calls, translator, body } = harness(el('div', {}, [make(), make(), make()]), upcase);

  await translator.translateRoot(body);

  assert.equal(calls.length, 1, 'deduplicated by the cache');
  assert.equal(calls[0]!.length, 1, 'the repeated sentence is sent once');
  assert.equal(translator.stats().translated, 3);
});

test('restore can be limited to a subtree', async () => {
  const inside = t('inside text');
  const outside = t('outside text');
  const panel = el('section', {}, [el('p', {}, [inside])]);
  const root = el('div', {}, [panel, el('p', {}, [outside])]);
  const { translator } = harness(root, upcase);

  await translator.translateRoot(root);
  assert.equal(inside.nodeValue, 'INSIDE TEXT');

  const result = translator.restore(panel);
  assert.equal(result.restored, 1);
  assert.equal(inside.nodeValue, 'inside text');
  assert.equal(outside.nodeValue, 'OUTSIDE TEXT', 'the rest stays translated');

  const rest = translator.restore(root);
  assert.equal(rest.restored, 1, 'a node left translated can still be restored later');
  assert.equal(outside.nodeValue, 'outside text');
});

test('mergeInline can be turned off', async () => {
  const paragraph = el('p', {}, [t('one'), el('em', {}, [t('two')])]);
  const { calls, translator, body } = harness(el('div', {}, [paragraph]), upcase, { mergeInline: false });

  await translator.translateRoot(body);

  assert.deepEqual(calls.flat(), ['one', 'two'], 'each text node is its own segment');
  assert.equal(translator.stats().runs, 0);
});

test('a long paragraph is translated sentence by sentence and rejoined', async () => {
  const paragraph = el('p', {}, [t('First sentence. Second sentence. Third sentence.')]);
  const { calls, translator } = harness(el('body', {}, [paragraph]), (texts) => texts.map((text) => `«${text}»`), {
    sentences: { split: (text: string) => text.match(/[^.]+\./g)?.map((part) => part.trim()) ?? [text], maxChars: 10 }
  });
  await translator.translateRoot();

  assert.deepEqual(calls[0], ['First sentence.'], 'the first sentence can land before the remaining paragraph');
  assert.deepEqual(calls.flat(), ['First sentence.', 'Second sentence.', 'Third sentence.']);
  assert.equal(
    (paragraph.childNodes[0] as { nodeValue?: string }).nodeValue,
    '«First sentence.» «Second sentence.» «Third sentence.»'
  );
});

test('a short paragraph is never split, and scripts without spaces stay tight', async () => {
  const shortParagraph = el('p', {}, [t('One. Two.')]);
  const short = harness(el('body', {}, [shortParagraph]), (texts) => texts.map((text) => `«${text}»`), {
    sentences: { split: (text: string) => text.split('. '), maxChars: 200 }
  });
  await short.translator.translateRoot();
  assert.deepEqual(short.calls, [['One. Two.']], 'below the threshold the text goes whole');

  const cjkParagraph = el('p', {}, [t('最初の文。二番目の文。')]);
  const cjk = harness(el('body', {}, [cjkParagraph]), (texts) => texts.map((text) => `【${text}】`), {
    sentences: { split: (text: string) => text.match(/[^。]+。/g) ?? [text], maxChars: 1 }
  });
  await cjk.translator.translateRoot();
  assert.deepEqual(cjk.calls.flat(), ['最初の文。', '二番目の文。']);
  assert.equal(
    (cjkParagraph.childNodes[0] as { nodeValue?: string }).nodeValue,
    '【最初の文。】【二番目の文。】',
    'no invented spaces between CJK sentences'
  );
});

test('a pass that only ever got the source back is a failure, and writes nothing', async () => {
  // Measured in a real browser: with the target language equal to the page's,
  // every answer was an echo and the tab reported `translated` with 0 nodes
  // changed — the page sat in English with no error anywhere to read.
  const paragraph = el('p', {}, [t('Batteries keep the grid stable')]);
  const { translator, body } = harness(el('div', {}, [paragraph]), (texts) => texts);

  await assert.rejects(() => translator.translateRoot(body), /answered with the page's own text/);
  assert.equal(translator.stats().translated, 0, 'an echo is not a translation');
  assert.equal(textContent(paragraph), 'Batteries keep the grid stable');
});

test('a pass with one echo and one real answer still succeeds', async () => {
  const first = el('p', {}, [t('Batteries keep the grid stable')]);
  const second = el('p', {}, [t('Wind turbines produce more power in winter')]);
  const { translator, body } = harness(el('div', {}, [first, second]), (texts) =>
    texts.map((text) => (text.startsWith('Batteries') ? text : '풍력 터빈은 겨울에 더 많은 전력을 생산합니다.'))
  );

  await translator.translateRoot(body);

  assert.equal(translator.stats().translated, 1, 'the echo is not counted and does not fail the pass');
  assert.equal(textContent(second), '풍력 터빈은 겨울에 더 많은 전력을 생산합니다.');
});

// --- pack concurrency ------------------------------------------------------

/** A provider that holds every request until the test releases it, so "how
 *  many packs are in flight" is observed rather than guessed. */
function gatedProvider() {
  let running = 0;
  let peak = 0;
  const gates: (() => void)[] = [];
  const translate = async (texts: string[]): Promise<string[]> => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise<void>((release) => gates.push(release));
    running -= 1;
    return texts.map((text) => text.toUpperCase());
  };
  return { translate, gates, peak: () => peak };
}

test('packs run side by side up to the window the caller allows', async () => {
  resetGlobals();
  const AT = load('lib/constants.js', 'lib/dom.js');
  // Enough ordinary paragraphs to keep both sessions busy across several packs.
  const body = el('div', {}, Array.from({ length: 16 }, (_unused, index) => el('p', {}, [t(`line ${index}`)])));
  const document = { nodeType: 9, documentElement: body };
  const provider = gatedProvider();
  const translator = AT.dom.createTranslator({ doc: document, translate: provider.translate, concurrency: () => 2 });
  const nodes = textNodes(body);
  const pending = translator.translateNodes(nodes);
  for (let attempt = 0; attempt < 200 && provider.gates.length < 2; attempt += 1) {
    await new Promise((done) => setTimeout(done, 5));
  }
  assert.equal(provider.gates.length, 2, 'both sessions are handed a pack');
  assert.equal(provider.peak(), 2, 'and no more than the window');
  assert.equal(nodes.every((node) => /^LINE \d+$/.test(node.nodeValue)), false, 'nothing is written before an answer');
  const result = await (async () => {
    for (let attempt = 0; attempt < 200 && provider.gates.length; attempt += 1) {
      provider.gates.shift()?.();
      await new Promise((done) => setTimeout(done, 2));
    }
    return await pending;
  })();
  assert.equal(result.failed, 0);
  assert.equal(nodes.every((node) => /^LINE \d+$/.test(node.nodeValue)), true, 'every pack still wrote its own nodes');
});

test('one window keeps the historical order: a pack starts when the last one landed', async () => {
  resetGlobals();
  const AT = load('lib/constants.js', 'lib/dom.js');
  const body = el('div', {}, Array.from({ length: 16 }, (_unused, index) => el('p', {}, [t(`line ${index}`)])));
  const document = { nodeType: 9, documentElement: body };
  const provider = gatedProvider();
  const translator = AT.dom.createTranslator({ doc: document, translate: provider.translate });
  const pending = translator.translateNodes(textNodes(body));
  for (let attempt = 0; attempt < 40; attempt += 1) await new Promise((done) => setTimeout(done, 5));
  assert.equal(provider.gates.length, 1, 'the default is one request at a time');
  assert.equal(provider.peak(), 1);
  const result = await (async () => {
    for (let attempt = 0; attempt < 200 && provider.gates.length; attempt += 1) {
      provider.gates.shift()?.();
      await new Promise((done) => setTimeout(done, 2));
    }
    return await pending;
  })();
  assert.equal(result.failed, 0);
  assert.equal(provider.peak(), 1, 'and it never overlaps');
});

function controlledProvider() {
  const requests: {
    texts: string[];
    resolve: (answers: string[]) => void;
    reject: (error: Error) => void;
  }[] = [];
  const translate = (texts: string[]) => new Promise<string[]>((resolve, reject) => {
    requests.push({ texts: [...texts], resolve, reject });
  });
  return { requests, translate };
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const sentenceOptions = {
  split: (text: string) => text.match(/[^.]+\./g)?.map((part) => part.trim()) ?? [text],
  maxChars: 1
};

test('concurrent replies commit in reading order and the first result is bounded', async () => {
  const provider = controlledProvider();
  const nodes = Array.from({ length: 12 }, (_, index) => t(`reading line ${index}`));
  const progress: string[][] = [];
  const { translator } = harness(el('body', {}, nodes.map((node) => el('p', {}, [node]))), provider.translate, {
    concurrency: () => 3,
    onApply: () => progress.push(nodes.map((node) => node.nodeValue))
  });
  const pending = translator.translateNodes(nodes);
  assert.equal(provider.requests.length, 3, 'inference is not serialized to order writes');
  assert.deepEqual(provider.requests[0]!.texts, ['reading line 0']);
  provider.requests[1]!.resolve(upcase(provider.requests[1]!.texts));
  await turn();
  assert.equal(progress.length, 0, 'a lower reply must wait for the upper result');
  assert.ok(nodes.every((node) => node.nodeValue.startsWith('reading')));
  provider.requests[0]!.resolve(upcase(provider.requests[0]!.texts));
  await turn();
  assert.equal(progress[0]![0], 'READING LINE 0');
  assert.ok(progress[0]!.slice(1).every((value) => value.startsWith('reading')), 'the first commit is only one ordinary node');
  assert.ok(nodes.some((node) => node.nodeValue.startsWith('reading')), 'first text is readable while later inference is pending');
  for (let index = 2; index < provider.requests.length; index++) {
    provider.requests[index]!.resolve(upcase(provider.requests[index]!.texts));
    await turn();
  }
  await pending;
  assert.ok(nodes.every((node) => node.nodeValue.startsWith('READING')));
});

test('ordinary packs obey source character and node bounds with an oversized singleton', async () => {
  const sources = ['first result', ...Array.from({ length: 7 }, (_, index) => `${index} ${'a'.repeat(190)}`), 'b'.repeat(700), 'last result'];
  const { AT, translator, calls } = harness(el('body', {}, sources.map((source) => el('p', {}, [t(source)]))), upcase);
  await translator.translateRoot();
  assert.deepEqual(calls[0], [sources[0]]);
  for (const call of calls) {
    assert.ok(call.length <= AT.C.PACKED_TEXT_NODES);
    assert.ok(call.length === 1 || call.reduce((sum, text) => sum + text.length, 0) <= AT.C.PACKED_TEXT_CHARS);
  }
  assert.deepEqual(calls.flat(), sources);
  assert.ok(calls.some((call) => call.length === 1 && call[0] === sources[8]), 'oversized text stays an unsplittable job');
});

test('a failed upper request releases lower commits without losing reading order', async () => {
  const provider = controlledProvider();
  const nodes = [t('upper line'), t('lower line')];
  const { translator } = harness(el('body', {}, nodes.map((node) => el('p', {}, [node]))), provider.translate, { concurrency: () => 2 });
  const pending = translator.translateNodes(nodes);
  provider.requests[1]!.resolve(['LOWER LINE']);
  await turn();
  assert.equal(nodes[1]!.nodeValue, 'lower line');
  provider.requests[0]!.reject(new Error('upper failed'));
  const result = await pending;
  assert.equal(result.failed, 1);
  assert.equal(nodes[0]!.nodeValue, 'upper line');
  assert.equal(nodes[1]!.nodeValue, 'LOWER LINE');
});

test('concurrent duplicate text shares one request across the first-pack boundary', async () => {
  const provider = controlledProvider();
  const nodes = [t('same words'), t('same words'), t('same words')];
  const { translator } = harness(el('body', {}, nodes.map((node) => el('p', {}, [node]))), provider.translate, { concurrency: () => 2 });
  const pending = translator.translateNodes(nodes);
  assert.equal(provider.requests.length, 1);
  provider.requests[0]!.resolve(['SAME WORDS']);
  await pending;
  assert.equal(translator.stats().translated, nodes.length);
});

test('sentence chunks apply an exact prefix and original suffix with progress before completion', async () => {
  const provider = controlledProvider();
  const source = '  First sentence.\n\nSecond sentence.  Third sentence.\t';
  const node = t(source);
  const progress: string[] = [];
  const { translator } = harness(el('body', {}, [el('p', {}, [node])]), provider.translate, {
    sentences: sentenceOptions,
    onApply: () => progress.push(node.nodeValue)
  });
  const pending = translator.translateRoot();
  await turn();
  assert.deepEqual(provider.requests[0]!.texts, ['First sentence.']);
  provider.requests[0]!.resolve(['FIRST SENTENCE.']);
  await turn();
  assert.equal(node.nodeValue, '  FIRST SENTENCE.\n\nSecond sentence.  Third sentence.\t');
  assert.equal(translator.has(node), false);
  assert.equal(translator.holds(node), true);
  assert.deepEqual(progress, [node.nodeValue]);
  for (let index = 1; index < provider.requests.length; index++) {
    provider.requests[index]!.resolve(upcase(provider.requests[index]!.texts));
    await turn();
  }
  await pending;
  assert.equal(node.nodeValue, source.toUpperCase());
  assert.equal(translator.has(node), true);
  assert.ok(progress.length >= 2);
  translator.restore();
  assert.equal(node.nodeValue, source);
});

test('sentence chunks are bounded and retain a safe prefix on cancellation or restore', async () => {
  for (const restore of [false, true]) {
    const provider = controlledProvider();
    const parts = Array.from({ length: 8 }, (_, index) =>
      `Section ${index} explains how storage operators monitor demand throughout the winter, inspect transmission equipment before storms, and reserve enough energy to keep hospitals and railway stations supplied.`);
    const source = parts.join('  ');
    const node = t(source);
    let cancelled = false;
    const { AT, translator } = harness(el('body', {}, [el('p', {}, [node])]), provider.translate, {
      sentences: sentenceOptions,
      shouldAbort: () => cancelled
    });
    const pending = translator.translateRoot();
    await turn();
    provider.requests[0]!.resolve(upcase(provider.requests[0]!.texts));
    await turn();
    const partial = parts[0]!.toUpperCase() + source.slice(parts[0]!.length);
    assert.equal(node.nodeValue, partial);
    const next = provider.requests[1]!;
    assert.ok(next.texts.length <= AT.C.PACKED_TEXT_NODES);
    assert.ok(next.texts.reduce((sum, text) => sum + text.length, 0) <= AT.C.PACKED_TEXT_CHARS);
    if (restore) translator.restore();
    else cancelled = true;
    next.resolve(upcase(next.texts));
    await pending;
    assert.equal(node.nodeValue, restore ? source : partial);
    assert.equal(translator.has(node), false);
    assert.equal(translator.stats().cached, 0, 'an incomplete or stale paragraph never enters the cache');
    translator.restore();
    assert.equal(node.nodeValue, source);
  }
});

test('restore discards buffered lower replies and the upper in-flight reply', async () => {
  const provider = controlledProvider();
  const nodes = [t('upper source'), t('lower source')];
  const { translator } = harness(el('body', {}, nodes.map((node) => el('p', {}, [node]))), provider.translate, { concurrency: () => 2 });
  const pending = translator.translateNodes(nodes);
  provider.requests[1]!.resolve(['LOWER SOURCE']);
  await turn();
  translator.restore();
  provider.requests[0]!.resolve(['UPPER SOURCE']);
  await pending;
  assert.deepEqual(nodes.map((node) => node.nodeValue), ['upper source', 'lower source']);
  assert.equal(translator.stats().cached, 0);
});

test('a malformed sentence chunk is not cached and retries use the original source', async () => {
  const node = t('First sentence.  Second sentence. Third sentence.');
  let malformed = true;
  const { translator, calls } = harness(el('body', {}, [el('p', {}, [node])]), (texts) =>
    malformed && texts[0] === 'Second sentence.' ? [] : upcase(texts), { sentences: sentenceOptions });
  const result = await translator.translateRoot();
  assert.equal(result.failed, 1);
  assert.equal(node.nodeValue, 'FIRST SENTENCE.  Second sentence. Third sentence.');
  assert.equal(translator.has(node), false);
  assert.equal(translator.stats().cached, 0);
  const before = calls.length;
  malformed = false;
  await translator.translateRoot();
  assert.deepEqual(calls.slice(before).flat(), ['First sentence.', 'Second sentence.', 'Third sentence.']);
  assert.equal(node.nodeValue, 'FIRST SENTENCE.  SECOND SENTENCE. THIRD SENTENCE.');
  assert.equal(translator.has(node), true);
});

test('oversized inline runs remain aligned semantic units', async () => {
  const first = Array.from({ length: 60 }, (_, index) => `first segment ${index} `).join('');
  const second = Array.from({ length: 60 }, (_, index) => `second segment ${index} `).join('');
  const paragraph = el('p', {}, [t(first), el('strong', {}, [t(second)])]);
  const { translator, calls } = harness(el('body', {}, [paragraph]), upcase, { sentences: sentenceOptions });
  await translator.translateRoot();
  assert.deepEqual(calls, [[first.trim(), second.trim()]]);
  assert.equal(textContent(paragraph), (first + second).toUpperCase());
  assert.equal(translator.stats().runs, 1);
});

test('an empty sentence answer retains only a contiguous translated prefix and can retry', async () => {
  const source = 'First sentence.\nSecond sentence.  Third sentence. Fourth sentence.';
  const node = t(source);
  let empty = true;
  const { translator, calls } = harness(el('body', {}, [el('p', {}, [node])]), (texts) =>
    texts.map((text) => empty && text === 'Third sentence.' ? '' : text.toUpperCase()), { sentences: sentenceOptions });
  const result = await translator.translateRoot();
  assert.equal(result.failed, 1);
  assert.equal(node.nodeValue, 'FIRST SENTENCE.\nSECOND SENTENCE.  Third sentence. Fourth sentence.');
  assert.equal(translator.has(node), false);
  assert.equal(translator.stats().cached, 0);
  const before = calls.length;
  empty = false;
  await translator.translateRoot();
  assert.deepEqual(calls.slice(before).flat(), ['First sentence.', 'Second sentence.', 'Third sentence.', 'Fourth sentence.']);
  assert.equal(node.nodeValue, source.toUpperCase());
});

test('a page rewrite during a sentence request keeps ownership through completion and restore', async () => {
  const provider = controlledProvider();
  const node = t('First sentence. Second sentence.');
  const { translator } = harness(el('body', {}, [el('p', {}, [node])]), provider.translate, { sentences: sentenceOptions });
  const pending = translator.translateRoot();
  await turn();
  provider.requests[0]!.resolve(['FIRST SENTENCE.']);
  await turn();
  node.nodeValue = 'The page replaced this paragraph.';
  provider.requests[1]!.resolve(['SECOND SENTENCE.']);
  await pending;
  assert.equal(node.nodeValue, 'The page replaced this paragraph.');
  assert.equal(translator.has(node), false);
  translator.restore();
  assert.equal(node.nodeValue, 'The page replaced this paragraph.');
});
