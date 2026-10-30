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

function harness(body: StubElement, provider: (texts: string[]) => string[], options: ATNamespace = {}) {
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
  // A provider that translates the whole sentence: the answer is spread back
  // over the three nodes by their share of the source, at word boundaries.
  const { calls, translator, body } = harness(el('div', {}, [paragraph]), (texts) =>
    texts.map(() => '합계 5개 항목 남음')
  );

  const result = await translator.translateRoot(body);

  assert.equal(calls.length, 1, 'one batch');
  assert.deepEqual(calls[0], ['Total 5 items left'], 'the run goes out as one plain sentence');
  assert.deepEqual(
    textNodes(paragraph).map((node) => node.nodeValue),
    ['합계 ', '5개 항목', ' 남음'],
    'each node keeps its own element, and words stay whole'
  );
  assert.equal(textContent(paragraph), '합계 5개 항목 남음');
  assert.equal(result.runs, 1, 'the run counts as merged');
  assert.equal(translator.stats().translated, 3);
});

test('a translation shorter than the run still fills every node', async () => {
  const paragraph = el('p', {}, [t('left side '), el('em', {}, [t('middle')]), t(' right side')]);
  const { translator, body } = harness(el('div', {}, [paragraph]), (texts) => texts.map(() => '짧은 답'));
  await translator.translateRoot(body);
  assert.deepEqual(
    textNodes(paragraph).map((node) => node.nodeValue),
    ['짧은 ', '답', ''],
    'no node keeps stale source text, and nothing is invented'
  );
  assert.equal(textContent(paragraph), '짧은 답');
});

test('a block element or a line break ends a run', async () => {
  const first = el('p', {}, [t('first half'), el('br', {}, []), t('second half')]);
  const second = el('p', {}, [t('other paragraph')]);
  const { calls, translator, body } = harness(el('div', {}, [first, second]), upcase);

  await translator.translateRoot(body);

  assert.deepEqual(calls, [['first half'], ['second half'], ['other paragraph']], 'each visual line is its own request');
  assert.ok(!calls.some((keys) => keys.length > 1), 'paragraphs are never glued');
  assert.equal(textContent(first), 'FIRST HALFSECOND HALF');
  assert.equal(textContent(second), 'OTHER PARAGRAPH');
});

test('an ignored inline element drops out but does not break the sentence', async () => {
  const code = el('code', {}, [t('npm test')]);
  const paragraph = el('p', {}, [t('Run '), code, t(' now')]);
  const { calls, translator, body } = harness(el('div', {}, [paragraph]), upcase);

  await translator.translateRoot(body);

  assert.equal(calls[0]!.length, 1, 'the sentence stays one run around the code');
  assert.ok(!calls[0]![0]!.includes('npm test'), 'the code text is never sent');
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

  assert.equal(calls[0]!.length, 1, 'deduplicated by the cache');
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

  assert.deepEqual(calls, [['one'], ['two']], 'each text node asked separately');
  assert.equal(translator.stats().runs, 0);
});

test('a long paragraph is translated sentence by sentence and rejoined', async () => {
  const paragraph = el('p', {}, [t('First sentence. Second sentence. Third sentence.')]);
  const { calls, translator } = harness(el('body', {}, [paragraph]), (texts) => texts.map((text) => `«${text}»`), {
    sentences: { split: (text: string) => text.match(/[^.]+\./g)?.map((part) => part.trim()) ?? [text], maxChars: 10 }
  });
  await translator.translateRoot();

  assert.equal(calls.length, 1, 'one request, three sentence keys');
  assert.deepEqual(calls[0], ['First sentence.', 'Second sentence.', 'Third sentence.']);
  assert.equal(
    (paragraph.childNodes[0] as { nodeValue?: string }).nodeValue,
    '«First sentence.» «Second sentence.» «Third sentence.»'
  );
});

test('a short paragraph is never split, and scripts without spaces stay tight', async () => {
  const shortParagraph = el('p', {}, [t('One. Two.')]);
  const short = harness(el('body', {}, [shortParagraph]), (texts) => texts, {
    sentences: { split: (text: string) => text.split('. '), maxChars: 200 }
  });
  await short.translator.translateRoot();
  assert.deepEqual(short.calls, [['One. Two.']], 'below the threshold the text goes whole');

  const cjkParagraph = el('p', {}, [t('最初の文。二番目の文。')]);
  const cjk = harness(el('body', {}, [cjkParagraph]), (texts) => texts.map((text) => `【${text}】`), {
    sentences: { split: (text: string) => text.match(/[^。]+。/g) ?? [text], maxChars: 1 }
  });
  await cjk.translator.translateRoot();
  assert.deepEqual(cjk.calls, [['最初の文。', '二番目の文。']]);
  assert.equal(
    (cjkParagraph.childNodes[0] as { nodeValue?: string }).nodeValue,
    '【最初の文。】【二番目の文。】',
    'no invented spaces between CJK sentences'
  );
});
