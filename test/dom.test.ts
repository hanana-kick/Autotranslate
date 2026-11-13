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
  assert.deepEqual(calls.slice(before).flat(), ['Second sentence.', 'Third sentence.']);
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
  assert.deepEqual(calls.slice(before).flat(), ['Third sentence.', 'Fourth sentence.']);
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

// Unit geometry pins source-offset bookkeeping; browser/clipped.test.mjs covers
// actual Range rects, nested clipping, line clamps, bidi and expansion.
function clipping(node: StubText, visible: number) {
  let count = visible;
  const parent = node.parentElement!;
  Object.assign(parent, {
    clientLeft: 0, clientTop: 0, clientWidth: 200, clientHeight: 20,
    offsetWidth: 200, offsetHeight: 20,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 20 })
  });
  Object.assign(node, { ownerDocument: {
    defaultView: { getComputedStyle: (element: StubElement) => ({
      overflowX: 'visible', overflowY: element === parent ? 'hidden' : 'visible',
      display: 'block', getPropertyValue: () => ''
    }) },
    createRange: () => {
      let start = 0;
      return {
        setStart: (_node: StubText, value: number) => { start = value; },
        setEnd: () => {},
        getClientRects: () => start < count
          ? [{ left: 0, right: 10, top: 0, bottom: 20, width: 10, height: 20 }]
          : [{ left: 0, right: 10, top: 40, bottom: 60, width: 10, height: 20 }]
      };
    }
  } });
  return { expand: () => { count = Number.MAX_SAFE_INTEGER; } };
}

test('clipped text returns after its visible prefix and resumes exact source offsets', async () => {
  const source = '  First sentence.\n\nSecond sentence.  Third sentence.\t';
  const node = t(source);
  const body = el('body', {}, [el('p', {}, [node])]);
  const { translator, calls } = harness(body, upcase, { sentences: sentenceOptions });
  const geometry = clipping(node, source.indexOf('\n'));
  const first = await translator.translateRoot();
  assert.deepEqual(calls, [['First sentence.']]);
  assert.equal(node.nodeValue, '  FIRST SENTENCE.\n\nSecond sentence.  Third sentence.\t');
  assert.deepEqual(first.pending, [node]);
  assert.equal(translator.deferred(node), true);
  assert.equal(translator.has(node), false);
  assert.equal(body.childNodes[0]!.childNodes![0], node);
  const second = await translator.translateNodes(first.pending);
  assert.equal(calls.flat().filter((part) => part === 'First sentence.').length, 1);
  assert.ok(second.pending.includes(node));
  geometry.expand();
  assert.equal(translator.deferred(node), false);
  for (let remaining = second.pending, count = 0; remaining.length && count < 10; count++) {
    remaining = (await translator.translateNodes(remaining)).pending;
  }
  assert.equal(node.nodeValue, source.toUpperCase());
  assert.equal(translator.has(node), true);
  translator.restore();
  assert.equal(node.nodeValue, source);
});

test('a clipped prefix restores safely and page edits discard its continuation', async () => {
  const source = 'First sentence. Second sentence. Third sentence.';
  const node = t(source);
  const { translator, calls } = harness(el('body', {}, [el('p', {}, [node])]), upcase);
  const geometry = clipping(node, 'First sentence.'.length);
  await translator.translateRoot();
  assert.equal(translator.restore().restored, 1);
  assert.equal(node.nodeValue, source);
  await translator.translateRoot();
  node.nodeValue = 'New page-owned comment.';
  geometry.expand();
  const before = calls.length;
  await translator.translateRoot();
  assert.deepEqual(calls.slice(before), [['New page-owned comment.']]);
  translator.restore();
  assert.equal(node.nodeValue, 'New page-owned comment.');
});

test('source eligibility precedes presentation and preserves mixed inline owners', async () => {
  const first = t('English before ');
  const korean = t('이미 한국어입니다');
  const last = t(' English after');
  const body = el('body', {}, [el('p', {}, [first, el('strong', {}, [korean]), last])]);
  const begun: StubText[] = [];
  const settled: StubText[] = [];
  const { translator, calls } = harness(body, upcase, {
    shouldTranslate: (text: string) => !/[가-힣]/u.test(text),
    presentation: {
      begin: (node: StubText) => begun.push(node),
      applied: () => {},
      settled: (node: StubText) => settled.push(node),
      forget: () => {},
      restore: () => {}
    }
  });
  const result = await translator.translateRoot();
  assert.deepEqual(calls.flat(), ['English before', 'English after']);
  assert.deepEqual(begun, [first, last]);
  assert.deepEqual(settled, [first, last]);
  assert.equal(korean.nodeValue, '이미 한국어입니다');
  assert.equal(translator.has(korean), false);
  assert.equal(translator.holds(korean), false);
  assert.equal(result.failed, 0);
  assert.equal(result.translated, 2);
  translator.restore();
  assert.equal(first.nodeValue, 'English before ');
  assert.equal(last.nodeValue, ' English after');
});

test('ineligible sentences keep their exact bytes and never enter model requests', async () => {
  const source = '이미 한국어입니다.\nEnglish sentence.  역시 한국어입니다. Last sentence.';
  const node = t(source);
  const { translator, calls } = harness(el('body', {}, [el('p', {}, [node])]), upcase, {
    sentences: sentenceOptions,
    shouldTranslate: (text: string) => !/[가-힣]/u.test(text)
  });
  const result = await translator.translateRoot();
  assert.deepEqual(calls.flat(), ['English sentence.', 'Last sentence.']);
  assert.equal(node.nodeValue, source.toUpperCase());
  assert.equal(result.failed, 0);
  translator.restore();
  assert.equal(node.nodeValue, source);
});

test('yield resumes sentence progress without cancelling or retranslating its prefix', async () => {
  const node = t('First sentence. Second sentence. Third sentence.');
  let yieldWork = false;
  const { translator, calls } = harness(el('body', {}, [el('p', {}, [node])]), upcase, {
    sentences: sentenceOptions,
    shouldYield: () => yieldWork,
    onApply: () => { yieldWork = true; }
  });
  const first = await translator.translateRoot();
  assert.deepEqual(calls, [['First sentence.']]);
  assert.deepEqual(first.pending, [node]);
  assert.equal(first.failed, 0);
  yieldWork = false;
  await translator.translateNodes(first.pending);
  assert.deepEqual(calls[1], ['Second sentence.']);
  assert.equal(node.nodeValue, 'FIRST SENTENCE. SECOND SENTENCE. Third sentence.');
  translator.restore();
  assert.equal(node.nodeValue, 'First sentence. Second sentence. Third sentence.');
});

test('yield drains active packs but returns unattempted nodes without failures', async () => {
  const provider = controlledProvider();
  const nodes = Array.from({ length: 30 }, (_, index) => t(`Comment number ${index}.`));
  let yieldWork = false;
  const { translator } = harness(el('body', {}, nodes.map((node) => el('p', {}, [node]))), provider.translate, {
    concurrency: () => 2, shouldYield: () => yieldWork
  });
  const pending = translator.translateRoot();
  await turn();
  assert.equal(provider.requests.length, 2);
  yieldWork = true;
  provider.requests[1]!.resolve(upcase(provider.requests[1]!.texts));
  provider.requests[0]!.resolve(upcase(provider.requests[0]!.texts));
  const result = await pending;
  const attempted = provider.requests.reduce((sum, request) => sum + request.texts.length, 0);
  assert.equal(provider.requests.length, 2);
  assert.equal(result.failed, 0);
  assert.deepEqual(result.pending, nodes.slice(attempted));
  assert.ok(nodes.slice(0, attempted).every((node) => translator.has(node)));
});

test('an entirely ineligible source has no request, presentation, restore record or failure', async () => {
  const node = t('이미 한국어인 댓글입니다.');
  const events: string[] = [];
  const { translator, calls } = harness(el('body', {}, [el('p', {}, [node])]), upcase, {
    shouldTranslate: () => false,
    presentation: {
      begin: () => events.push('begin'), applied: () => events.push('applied'),
      settled: () => events.push('settled'), forget: () => {}, restore: () => {}
    }
  });
  const result = await translator.translateNodes([node]);
  assert.deepEqual(calls, []);
  assert.deepEqual(events, []);
  assert.equal(result.requested, 0);
  assert.equal(result.translated, 0);
  assert.equal(result.failed, 0);
  assert.deepEqual(result.pending, []);
  assert.equal(translator.holds(node), false);
  assert.equal(translator.restore().restored, 0);
});

test('failed suffixes are not pending work and direct calls skip completed sources', async () => {
  const node = t('First sentence. Second sentence.');
  let fail = true;
  const { translator, calls } = harness(el('body', {}, [el('p', {}, [node])]), (texts) =>
    texts.map((text) => fail && text === 'Second sentence.' ? '' : text.toUpperCase()),
  { sentences: sentenceOptions });
  const first = await translator.translateRoot();
  assert.equal(first.failed, 1);
  assert.deepEqual(first.pending, []);
  fail = false;
  await translator.translateNodes([node]);
  assert.deepEqual(calls.flat(), ['First sentence.', 'Second sentence.', 'Second sentence.']);
  const before = calls.length;
  await translator.translateNodes([node]);
  assert.equal(calls.length, before);
});

test('skipped clipped prefixes advance without being marked translated or presented', async () => {
  const source = '이미 한국어입니다.\nEnglish comment follows. Last English sentence.';
  const node = t(source);
  const events: string[] = [];
  const { translator, calls } = harness(el('body', {}, [el('p', {}, [node])]), upcase, {
    sentences: sentenceOptions,
    shouldTranslate: (text: string) => !/[가-힣]/u.test(text),
    presentation: {
      begin: () => events.push('begin'), applied: () => events.push('applied'),
      settled: () => events.push('settled'), forget: () => {}, restore: () => {}
    }
  });
  const geometry = clipping(node, source.indexOf('\n'));
  const first = await translator.translateRoot();
  assert.deepEqual(calls, []);
  assert.deepEqual(events, []);
  assert.equal(first.translated, 0);
  assert.equal(first.failed, 0);
  assert.deepEqual(first.pending, [node]);
  assert.equal(translator.holds(node), false);
  geometry.expand();
  await translator.translateNodes(first.pending);
  assert.deepEqual(calls.flat(), ['English comment follows.', 'Last English sentence.']);
  assert.equal(node.nodeValue, source.toUpperCase());
  translator.restore();
  assert.equal(node.nodeValue, source);
});

test('interactive short comments bypass always-split sentences and finish in one request', async () => {
  const node = t('  First sentence. Second sentence.\n');
  let splits = 0;
  const { translator, calls } = harness(el('body', {}, [el('p', {}, [node])]), upcase, {
    workLimit: () => ({ maxChars: 64, maxTexts: 1 }),
    sentences: { always: true, maxChars: 1, split: (text: string) => {
      splits++;
      return sentenceOptions.split(text);
    } }
  });
  const result = await translator.translateRoot();
  assert.deepEqual(calls, [['First sentence. Second sentence.']]);
  assert.equal(splits, 0);
  assert.equal(translator.has(node), true);
  assert.deepEqual(result.pending, []);
  assert.equal(node.nodeValue, '  FIRST SENTENCE. SECOND SENTENCE.\n');
});

test('unclipped unpunctuated source resumes bounded prefixes without duplicates or lost Unicode', async () => {
  const prefix = 'abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz0';
  const source = ' \t' + prefix + '😀' + Array.from({ length: 90 }, (_, i) => `bc${i}`).join('') + '𐐨tail' + '\n';
  const node = t(source);
  const { translator, calls } = harness(el('body', {}, [el('p', {}, [node])]), upcase, {
    workLimit: () => ({ maxChars: 64, maxTexts: 1 }),
    sentences: { ...sentenceOptions, always: true }
  });
  let result = await translator.translateRoot();
  assert.deepEqual(calls, [[prefix]]);
  assert.equal(node.nodeValue, ' \t' + prefix.toUpperCase() + source.slice(65));
  assert.deepEqual(result.pending, [node]);
  assert.equal(translator.has(node), false);
  assert.equal(translator.deferred(node), false, 'the suffix is pending work, not clipped content');
  for (let count = 0; result.pending.length && count < 20; count++) {
    result = await translator.translateNodes(result.pending);
  }
  assert.deepEqual(result.pending, []);
  assert.ok(calls.every((call) => call.length === 1 && call[0]!.length <= 64));
  assert.equal(calls.flat().join(''), source.trim(), 'every original source unit is requested exactly once');
  assert.ok(calls.flat().every((part) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(part)));
  assert.equal(node.nodeValue, source.toUpperCase());
  assert.equal(translator.has(node), true);
  assert.equal(translator.restore().restored, 1);
  assert.equal(node.nodeValue, source);
});

test('bounded prefixes prefer sentence, newline and word boundaries without dropping whitespace', async () => {
  for (const [source, expected] of [
    ['First sentence. next words continue until well beyond the budget', 'First sentence.'],
    ['First line\nsecond words continue until well beyond the budget', 'First line'],
    ['first words continuewithalongunbrokenwordpastthebudget', 'first words']
  ]) {
    const node = t(source!);
    const { translator, calls } = harness(el('body', {}, [el('p', {}, [node])]), upcase, {
      workLimit: () => ({ maxChars: 24, maxTexts: 1 })
    });
    let result = await translator.translateRoot();
    assert.deepEqual(calls, [[expected]]);
    assert.equal(node.nodeValue, expected!.toUpperCase() + source!.slice(expected!.length));
    for (let count = 0; result.pending.length && count < 20; count++) result = await translator.translateNodes(result.pending);
    assert.ok(calls.flat().every((part) => part.length <= 24));
    assert.equal(node.nodeValue, source!.toUpperCase());
    translator.restore();
    assert.equal(node.nodeValue, source);
  }
});

test('ordinary interactive packs obey both source and text budgets and yield after one request', async () => {
  const nodes = ['first comment', 'second comment', 'third comment', 'fourth comment'].map(t);
  let yieldWork = false;
  let limit = { maxChars: 64, maxTexts: 1 };
  const { translator, calls } = harness(el('body', {}, nodes.map((node) => el('p', {}, [node]))),
    (texts) => { yieldWork = true; return upcase(texts); }, {
      workLimit: () => limit, shouldYield: () => yieldWork, concurrency: () => 3
    });
  let result = await translator.translateRoot();
  assert.deepEqual(calls, [['first comment']]);
  assert.deepEqual(result.pending, nodes.slice(1));
  while (result.pending.length) {
    yieldWork = false;
    result = await translator.translateNodes(result.pending);
  }
  assert.ok(calls.every((call) => call.length === 1));
  translator.restore();
  yieldWork = false;
  limit = { maxChars: 25, maxTexts: 3 };
  // Disable the yield between these requests to exercise aggregate pack limits.
  const packed = harness(el('body', {}, nodes.map((node) => el('p', {}, [node]))), upcase, {
    workLimit: () => limit
  });
  await packed.translator.translateRoot();
  assert.ok(packed.calls.every((call) => call.length <= 3 && call.join('').length <= 25));
  assert.deepEqual(packed.calls.flat(), nodes.map((node) => node.nodeValue.toLowerCase()));
});

test('oversized mixed inline runs fall back to resumable element-owned fragments', async () => {
  const words = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
  const sources = ['  opening ' + words + ' ', 'link ' + words, '\nfinal ' + words + '\t'];
  const nodes = sources.map(t);
  const link = el('a', { attrs: { href: '/original' } }, [nodes[1]!]);
  const paragraph = el('p', {}, [nodes[0]!, link, el('em', {}, [nodes[2]!])]);
  let yieldWork = false;
  const { translator, calls } = harness(el('body', {}, [paragraph]),
    (texts) => { yieldWork = true; return upcase(texts); }, {
      workLimit: () => ({ maxChars: 64, maxTexts: 1 }),
      shouldYield: () => yieldWork,
      sentences: { ...sentenceOptions, always: true }
    });
  let result = await translator.translateRoot();
  assert.equal(calls.length, 1);
  assert.equal(translator.has(nodes[0]), false);
  assert.deepEqual(nodes.slice(1).map((node) => node.nodeValue), sources.slice(1));
  for (let count = 0; result.pending.length && count < 30; count++) {
    yieldWork = false;
    const before: number = calls.length;
    result = await translator.translateNodes(result.pending);
    assert.equal(calls.length - before, 1);
  }
  assert.deepEqual(result.pending, []);
  assert.ok(calls.every((call) => call.length === 1 && call[0]!.length <= 64));
  assert.deepEqual(nodes.map((node) => node.nodeValue), sources.map((source) => source.toUpperCase()));
  assert.equal(link.childNodes[0], nodes[1]);
  assert.equal(link.attrs.href, '/original');
  assert.equal(translator.stats().runs, 0);
  assert.equal(translator.restore().restored, 3);
  assert.deepEqual(nodes.map((node) => node.nodeValue), sources);
});

test('bounded continuations discard stale source offsets after page edits and restore', async () => {
  const source = 'original ' + Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
  const node = t(source);
  const provider = controlledProvider();
  const { translator, calls } = harness(el('body', {}, [el('p', {}, [node])]), provider.translate, {
    workLimit: () => ({ maxChars: 64, maxTexts: 1 })
  });
  const first = translator.translateRoot();
  await turn();
  provider.requests[0]!.resolve(upcase(provider.requests[0]!.texts));
  const prefix = await first;
  assert.deepEqual(prefix.pending, [node]);
  const continuation = translator.translateNodes(prefix.pending);
  await turn();
  node.nodeValue = 'The page replaced this comment.';
  provider.requests[1]!.resolve(upcase(provider.requests[1]!.texts));
  await continuation;
  assert.equal(node.nodeValue, 'The page replaced this comment.');
  translator.restore();
  assert.equal(node.nodeValue, 'The page replaced this comment.');
  const replacement = translator.translateNodes([node]);
  await turn();
  assert.deepEqual(calls[2], ['The page replaced this comment.']);
  provider.requests[2]!.resolve(upcase(provider.requests[2]!.texts));
  await replacement;
  assert.equal(translator.has(node), true);
  translator.restore();
  assert.equal(node.nodeValue, 'The page replaced this comment.');
  node.nodeValue = source;
  const again = translator.translateNodes([node]);
  await turn();
  provider.requests[3]!.resolve(upcase(provider.requests[3]!.texts));
  const partial = await again;
  const outstanding = translator.translateNodes(partial.pending);
  await turn();
  assert.equal(translator.restore().restored, 1);
  provider.requests[4]!.resolve(upcase(provider.requests[4]!.texts));
  await outstanding;
  assert.equal(node.nodeValue, source);
  assert.equal(translator.has(node), false);
});

test('a quantum smaller than one Unicode code point never splits its surrogate pair', async () => {
  const source = '𐐨𐐩';
  const node = t(source);
  const { translator, calls } = harness(el('body', {}, [el('p', {}, [node])]), upcase, {
    workLimit: () => ({ maxChars: 1, maxTexts: 1 })
  });
  const first = await translator.translateRoot();
  assert.deepEqual(first.pending, [node]);
  const second = await translator.translateNodes(first.pending);
  assert.deepEqual(calls, [['𐐨'], ['𐐩']], 'only an indivisible code point may exceed the UTF-16 budget');
  assert.deepEqual(second.pending, []);
  assert.equal(node.nodeValue, source.toUpperCase());
  translator.restore();
  assert.equal(node.nodeValue, source);
});

test('a zero character quantum preserves whole sources while honoring the configured pack count', async () => {
  const sources = ['first comment', 'second comment', 'third comment', 'fourth comment', 'fifth comment', 'a'.repeat(700)];
  const { translator, calls } = harness(el('body', {}, sources.map((source) => el('p', {}, [t(source)]))), upcase, {
    workLimit: () => ({ maxChars: 0, maxTexts: 2 })
  });
  await translator.translateRoot();
  assert.ok(calls.every((call) => call.length <= 2));
  assert.ok(calls.some((call) => call.length === 2));
  assert.deepEqual(calls.flat(), sources);
});
