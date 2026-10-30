// Drives the sample. The page talks to AT.dom.createTranslator directly — the
// same call content.ts makes — so what you see here is the engine itself, with
// an offline dictionary standing in for a translation provider.
namespace AT.demoPage {
  type Captured = {
    texts: (string | null)[];
    structure: string[];
    styles: string[];
    kept: (string | null)[];
  };

  type Call = { sent: readonly string[]; received: string[]; ms: number };

  const STYLE_PROPS = [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing',
    'color', 'backgroundColor', 'textAlign', 'textTransform', 'display', 'opacity',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
    'borderTopWidth', 'borderBottomWidth', 'borderTopLeftRadius'
  ];
  const MUST_STAY = 'pre, code, kbd, textarea, select, .notranslate, [translate="no"], [contenteditable="true"]';

  function elementAs<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    // The sample owns these ids, so a missing one is a broken page, not data.
    if (!element) throw new Error(`sample is missing #${id}`);
    return element as T;
  }

  const els = {
    toggle: elementAs<HTMLButtonElement>('toggle'),
    probe: elementAs<HTMLButtonElement>('probe'),
    merge: elementAs<HTMLInputElement>('merge'),
    provider: elementAs<HTMLSelectElement>('provider'),
    status: elementAs<HTMLElement>('status'),
    verdict: elementAs<HTMLElement>('verdict'),
    calls: elementAs<HTMLElement>('calls'),
    mapping: elementAs<HTMLElement>('mapping'),
    sample: elementAs<HTMLElement>('sample')
  };

  const textNodes = (root: Node): Text[] => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    // SHOW_TEXT means every node handed back is a Text.
    let node = walker.nextNode() as Text | null;
    const found: Text[] = [];
    while (node) {
      found.push(node);
      node = walker.nextNode() as Text | null;
    }
    return found;
  };
  const elements = (root: Element): Element[] => [root, ...root.querySelectorAll('*')];
  const show = (value: unknown): string =>
    String(value).replace(/\uE000(\d+)\uE001/g, '⟦$1⟧').replace(/\s+/g, ' ').trim();
  const describe = (node: Node): string => node.parentElement?.tagName.toLowerCase() ?? '?';
  const computedValue = (style: CSSStyleDeclaration, prop: string): string =>
    style.getPropertyValue(prop.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`));

  function capture(): Captured {
    return {
      texts: textNodes(els.sample).map((node) => node.nodeValue),
      structure: elements(els.sample).map((el) =>
        `${el.tagName}|${el.className}|${[...el.attributes].map((a) => `${a.name}=${a.value}`).join(',')}`
      ),
      styles: elements(els.sample).map((el) => {
        const computed = getComputedStyle(el);
        return STYLE_PROPS.map((prop) => `${prop}:${computedValue(computed, prop)}`).join(';');
      }),
      kept: [...els.sample.querySelectorAll(MUST_STAY)].map((el) => el.textContent)
    };
  }

  const differences = (values: readonly string[], other: readonly string[]): number =>
    values.filter((value, index) => value !== other[index]).length + Math.abs(values.length - other.length);

  let translator: AT.dom.Translator | null = null;
  let calls: Call[] = [];
  let translated = false;
  let before: Captured | null = null;

  function renderCalls(): void {
    els.calls.textContent = '';
    if (!calls.length) {
      els.calls.textContent = '아직 요청 없음';
      return;
    }
    calls.forEach((call, index) => {
      const item = document.createElement('li');
      item.textContent = `요청 ${String(index + 1)} · 문자열 ${String(call.sent.length)}개 · ${String(call.ms)}ms`;
      call.sent.forEach((sent, position) => {
        const line = document.createElement('span');
        const marker = document.createElement('em');
        marker.textContent = show(sent);
        line.append(marker);
        const received = call.received[position];
        if (received !== undefined) line.append(` → ${show(received)}`);
        item.append(line);
      });
      els.calls.append(item);
    });
  }

  function renderMapping(): void {
    els.mapping.textContent = '';
    if (!before) {
      els.mapping.textContent = '번역하면 변경된 텍스트 노드가 여기 나열됩니다';
      return;
    }
    const baseline = before;
    let changed = 0;
    textNodes(els.sample).forEach((node, index) => {
      const original = baseline.texts[index];
      if (node.nodeValue === original || !AT.dom.hasText(original)) return;
      changed += 1;
      const item = document.createElement('li');
      const from = document.createElement('s');
      from.textContent = show(original);
      const to = document.createElement('mark');
      to.textContent = show(node.nodeValue);
      item.append(`${describe(node)}: `);
      item.append(from, to);
      els.mapping.append(item);
    });
    if (!changed) els.mapping.textContent = '변경된 텍스트 노드 없음';
  }

  function report(kind: 'pass' | 'fail', lines: string[]): void {
    els.verdict.hidden = false;
    els.verdict.className = `verdict ${kind}`;
    els.verdict.textContent = lines.join('\n');
  }

  function statusLine(extra?: string): void {
    const stats = translator?.stats() ?? { translated: 0, cached: 0, runs: 0 };
    els.status.textContent = [
      `provider 호출 ${String(calls.length)}회`,
      `번역 ${String(stats.translated)}`,
      `캐시 ${String(stats.cached)}`,
      `병합 런 ${String(stats.runs)}`,
      `인라인 병합 ${els.merge.checked ? '켜짐' : '꺼짐'}`,
      `provider ${els.provider.value === 'lossy' ? '마커 유실 시뮬레이션' : '마커 보존'}`,
      extra
    ].filter(Boolean).join(' · ');
  }

  function build(): AT.dom.Translator {
    calls = [];
    const created = AT.dom.createTranslator({
      doc: document,
      mergeInline: els.merge.checked,
      maxNodes: 600,
      batchChars: 900,
      translate: async (texts) => {
        const started = performance.now();
        const out = await AT.demo.translate(texts, {
          lossy: els.provider.value === 'lossy',
          latencyMs: 140
        });
        calls.push({ sent: texts, received: out, ms: Math.round(performance.now() - started) });
        renderCalls();
        return out;
      }
    });
    translator = created;
    return created;
  }

  async function translate(): Promise<void> {
    els.toggle.disabled = true;
    try {
      const current = build();
      before = capture();
      const started = performance.now();
      const result = await current.translateRoot(els.sample);
      translated = true;
      els.toggle.textContent = '원문으로';
      const unknown = AT.demo.unknownCount();
      report('pass', [
        `요청 ${String(calls.length)}회 · 병합 런 ${String(result.runs)}개 · 텍스트 노드 ${String(result.translated)}개 변경 · ${String(Math.round(performance.now() - started))}ms`,
        unknown
          ? `사전에 없는 조각 ${String(unknown)}개는 원문 그대로 남았습니다(오프라인 사전 스텁의 한계이며, DOM 엔진과 무관합니다).`
          : '모든 조각이 오프라인 사전에 있었습니다.'
      ]);
      renderMapping();
      statusLine();
    } finally {
      els.toggle.disabled = false;
    }
  }

  function restore(): void {
    translator?.restore(els.sample);
    translated = false;
    els.toggle.textContent = '번역하기';
    const now = textNodes(els.sample).map((node) => node.nodeValue);
    const baseline = before;
    const mismatches = baseline ? now.filter((value, index) => value !== baseline.texts[index]).length : -1;
    report(mismatches === 0 ? 'pass' : 'fail', [
      `원문 복원: 텍스트 노드 ${String(now.length)}개 중 불일치 ${String(mismatches)}개`,
      mismatches === 0
        ? '번역 전 값과 바이트 단위로 같습니다.'
        : '값이 다릅니다 — 아래 매핑에서 어떤 노드가 남았는지 확인하세요.'
    ]);
    renderMapping();
    statusLine('복원됨');
  }

  function verify(): void {
    const baseline = before;
    if (!baseline) {
      report('fail', ['먼저 번역하기 눌러 주세요. 번역 전 상태를 기준으로 비교합니다.']);
      return;
    }
    const now = capture();
    const structureDiff = differences(now.structure, baseline.structure);
    const styleDiff = differences(now.styles, baseline.styles);
    const keptDiff = differences(
      now.kept.map((value) => value ?? ''),
      baseline.kept.map((value) => value ?? '')
    );
    const changedNodes = now.texts.filter((value, index) => value !== baseline.texts[index]).length;
    report(structureDiff === 0 && styleDiff === 0 && keptDiff === 0 ? 'pass' : 'fail', [
      `요소 구조(태그·클래스·속성): ${String(now.structure.length)}개 중 차이 ${String(structureDiff)}개`,
      `컴퓨티드 스타일 ${String(STYLE_PROPS.length)}종: ${String(now.styles.length)}개 요소 중 차이 ${String(styleDiff)}개`,
      `코드/편집 영역/표식 원문 유지: ${String(now.kept.length)}개 중 차이 ${String(keptDiff)}개`,
      `변경된 것: 텍스트 노드 ${String(changedNodes)}개의 값만`
    ]);
  }

  function rerun(): void {
    if (!translated) {
      statusLine();
      return;
    }
    translator?.restore(els.sample);
    translated = false;
    void translate();
  }

  els.toggle.addEventListener('click', () => {
    if (translated) restore();
    else void translate();
  });
  els.probe.addEventListener('click', verify);
  els.merge.addEventListener('change', rerun);
  els.provider.addEventListener('change', rerun);

  renderCalls();
  renderMapping();
  statusLine('대기 중');
}
