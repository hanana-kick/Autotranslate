// Inline presentation only: source ownership and translated text stay in AT.dom.
namespace AT.translationtext {
  export type Presentation = {
    begin(node: Text): void;
    preview(node: Text, text: string): void;
    clearPreview(node: Text): void;
    applied(node: Text, complete: boolean): void;
    settled(node: Text, status: 'translated' | 'partial' | 'failed', interrupted?: boolean): void;
    forget(node: Text): void;
    restore(root?: Node): void;
    measureSource?<T>(node: Text, read: () => T): T;
    ownsMutation(record: MutationRecord): boolean;
  };

  const TAG = 'at-translation-text';
  const HTML = 'http://www.w3.org/1999/xhtml';
  const REGISTRATION = Symbol.for('autotranslate.translationtext.registration');
  // These elements do not accept ordinary phrasing content, or give text special
  // semantics. Translation still works there, without inserting a component.
  const UNSAFE: Record<string, true | undefined> = {
    html: true, head: true, title: true, base: true, link: true, meta: true,
    style: true, script: true, noscript: true, textarea: true, input: true,
    select: true, option: true, optgroup: true, datalist: true, template: true,
    table: true, thead: true, tbody: true, tfoot: true, tr: true, colgroup: true,
    col: true, ul: true, ol: true, menu: true, dl: true, picture: true,
    audio: true, video: true, iframe: true, object: true, embed: true,
    xmp: true, plaintext: true, noembed: true, noframes: true,
  };
  const STYLES = `
    :host {
      display: inline;
      color: inherit;
      font: inherit;
      white-space: inherit;
      letter-spacing: inherit;
      word-spacing: inherit;
      text-transform: inherit;
      vertical-align: baseline;
      padding: 0;
      margin: 0;
      border: 0;
    }
    .surface {
      display: inline;
      position: relative;
      color: inherit;
      font: inherit;
      padding: 0;
      margin: 0;
      border: 0;
      -webkit-box-decoration-break: clone;
      box-decoration-break: clone;
    }
    :host([data-state="translating"]) .surface {
      background-image: linear-gradient(110deg,
        rgba(103, 232, 249, .10), rgba(167, 139, 250, .14),
        rgba(216, 180, 254, .10), rgba(103, 232, 249, .10));
      background-size: 240% 100%;
      box-shadow: 0 0 7px rgba(139, 164, 245, .13);
    }
    :host([data-state="translating"]) .surface,
    :host([data-state="partial"]) .surface {
      /* Keep the timeline across quanta, but paint progress only while active. */
      animation: at-aurora 3.4s ease-in-out infinite;
    }
    :host([data-state="partial"]) .surface { animation-play-state: paused; }
    @keyframes at-aurora {
      0%, 100% { background-position: 0% 50%; }
      50% { background-position: 100% 50%; }
    }
    .preview { display: none; }
    :host([data-streaming="true"]) slot { display: none; }
    :host([data-streaming="true"]) .preview { display: inline; }
    :host([data-measuring]) slot { display: contents !important; }
    :host([data-measuring]) .preview {
      position: absolute !important;
      visibility: hidden !important;
    }
    .preview > span {
      animation: at-stream-reveal 160ms ease-out;
      -webkit-box-decoration-break: clone;
      box-decoration-break: clone;
    }
    @keyframes at-stream-reveal { from { opacity: .35; } to { opacity: 1; } }
    @media (prefers-reduced-motion: reduce), (forced-colors: active) {
      .surface, .preview > span {
        animation: none !important;
        background: none !important;
        box-shadow: none !important;
      }
    }
  `;

  type RegisteredConstructor = CustomElementConstructor & {
    [REGISTRATION]?: true;
  };
  type Preview = {
    source: string;
    parent: Node;
    pending: string;
    rendered: string;
    element: HTMLElement;
    stable: Text;
    tail: Text;
    spans: { element: HTMLElement; text: string; born: number }[];
    timer: number | undefined;
    frame: number | undefined;
  };
  type Entry = {
    node: Text;
    host: HTMLElement;
    previous: string;
    preview?: Preview | undefined;
    finishTimer?: number | undefined;
    settleTimer?: number | undefined;
  };
  type ExpectedMutation = {
    target: Node;
    added: Node | null;
    removed: Node | null;
    previous: Node | null;
    next: Node | null;
  };

  export function create(root: AT.dom.DocumentRoot): Presentation | undefined {
    const doc = root as Document;
    const view = doc.defaultView;
    if (doc.nodeType !== 9 || !view?.HTMLElement) return undefined;

    function attachSurface(host: HTMLElement): void {
      const shadow = host.attachShadow({ mode: 'open' });
      const style = doc.createElement('style');
      style.textContent = STYLES;
      const surface = doc.createElement('span');
      surface.className = 'surface';
      surface.appendChild(doc.createElement('slot'));
      shadow.append(style, surface);
    }

    // Chromium's extension isolated world exposes no custom-element registry.
    // Shadow DOM and slots still work natively there; initialize the same
    // component directly instead of injecting privileged code into page scope.
    const registry = view.customElements;
    let constructor = registry?.get(TAG) as RegisteredConstructor | undefined;
    if (registry && !constructor) {
      class TranslationText extends view.HTMLElement {
        constructor() {
          super();
          attachSurface(this);
        }
      }
      constructor = TranslationText;
      Object.defineProperty(constructor, REGISTRATION, { value: true });
      registry.define(TAG, constructor);
    }
    const registration = !registry || constructor?.[REGISTRATION];

    const entries = new Map<Text, Entry>();
    const expected = new Set<ExpectedMutation>();
    const previews = new Set<Entry>();
    // Shadow edits never enter this observer. Watch only during preview: a page
    // edit must reveal the site's current light DOM even if inference stalls.
    const observer = new view.MutationObserver((records) => {
      for (const entry of previews) {
        const preview = entry.preview!;
        if (!validPreview(entry, preview) || records.some((record) =>
          Array.from(record.removedNodes).some((node) => node === entry.host || node.contains(entry.host)))) {
          unwrap(entry);
        }
      }
    });

    function validPreview(entry: Entry, preview: Preview): boolean {
      return entry.host.isConnected && entry.host.parentNode === preview.parent &&
        entry.node.parentNode === entry.host && entry.host.childNodes.length === 1 &&
        entry.node.data === preview.source;
    }

    function clear(entry: Entry): void {
      if (entry.finishTimer !== undefined) view!.clearTimeout(entry.finishTimer);
      entry.finishTimer = undefined;
      const preview = entry.preview;
      if (!preview) return;
      if (preview.timer !== undefined) view!.clearTimeout(preview.timer);
      if (preview.frame !== undefined) view!.cancelAnimationFrame(preview.frame);
      preview.element.remove();
      entry.host.removeAttribute('data-streaming');
      entry.preview = undefined;
      previews.delete(entry);
      if (!previews.size) observer.disconnect();
    }

    function render(entry: Entry, preview: Preview): void {
      if (entry.preview !== preview) return;
      if (!validPreview(entry, preview)) {
        unwrap(entry);
        return;
      }
      const text = preview.pending;
      if (text === preview.rendered) return;
      const previous = preview.rendered || entry.previous;
      // Diff the painted flow, not just decoded output: the untouched source
      // suffix stays opaque in its own Text, never as a paragraph-sized overlay.
      let prefix = 0;
      while (prefix < previous.length && prefix < text.length &&
          previous.charCodeAt(prefix) === text.charCodeAt(prefix)) prefix++;
      const boundaries = new Set([...AT.dom.graphemes(text)].map(({ index }) => index));
      boundaries.add(text.length);
      const oldBoundaries = new Set([...AT.dom.graphemes(previous)].map(({ index }) => index));
      oldBoundaries.add(previous.length);
      while (prefix && (!boundaries.has(prefix) || !oldBoundaries.has(prefix))) prefix--;
      let end = text.length, oldEnd = previous.length;
      while (end > prefix && oldEnd > prefix && text.charCodeAt(end - 1) === previous.charCodeAt(oldEnd - 1)) {
        end--; oldEnd--;
      }
      while (end < text.length && (!boundaries.has(end) || !oldBoundaries.has(oldEnd))) {
        end++; oldEnd++;
      }
      let offset = preview.stable.length;
      if (offset > prefix) preview.stable.deleteData(prefix, offset - prefix);
      for (let index = 0; index < preview.spans.length;) {
        const span = preview.spans[index]!;
        const retained = Math.max(0, Math.min(span.text.length, prefix - offset));
        offset += span.text.length;
        if (!retained) {
          span.element.remove();
          preview.spans.splice(index, 1);
        } else {
          if (retained < span.text.length) {
            span.text = span.text.slice(0, retained);
            (span.element.firstChild as Text).data = span.text;
          }
          index++;
        }
      }
      // A later quantum may commit formerly untouched source unchanged.
      // Promote that shared prefix without starting a reveal on it.
      const retained = preview.stable.length + preview.spans.reduce((sum, span) => sum + span.text.length, 0);
      if (retained < prefix) {
        for (const span of preview.spans) {
          preview.stable.appendData(span.text);
          span.element.remove();
        }
        preview.spans.length = 0;
        preview.stable.appendData(previous.slice(retained, prefix));
      }
      const now = view!.performance.now();
      const suffix = text.slice(prefix, end);
      // Completed regions become one unanimated Text; at most five fading
      // spans exist. The aurora belongs to the persistent surface, not a token.
      while (preview.spans.length && (
        preview.spans[0]!.born + 160 <= now ||
        (suffix.length > 0 && preview.spans.length >= 5))) {
        const span = preview.spans.shift()!;
        preview.stable.appendData(span.text);
        span.element.remove();
      }
      if (suffix) {
        const element = doc.createElement('span');
        element.textContent = suffix;
        preview.element.insertBefore(element, preview.tail);
        preview.spans.push({ element, text: suffix, born: now });
      }
      preview.tail.data = text.slice(end);
      preview.rendered = text;
      if (!preview.element.parentNode) entry.host.shadowRoot!.querySelector('.surface')!.appendChild(preview.element);
      entry.host.setAttribute('data-streaming', 'true');
    }

    function startPreview(entry: Entry, text: string): Preview {
      const element = doc.createElement('span');
      element.className = 'preview';
      const stable = doc.createTextNode('');
      const tail = doc.createTextNode('');
      element.append(stable, tail);
      const preview: Preview = { source: entry.node.data, parent: entry.host.parentNode!, pending: text,
        rendered: '', element, stable, tail, spans: [], timer: undefined, frame: undefined };
      entry.preview = preview;
      if (!previews.size) observer.observe(doc, { subtree: true, childList: true, characterData: true });
      previews.add(entry);
      return preview;
    }

    function remember(mutations: ExpectedMutation[]): void {
      for (const mutation of mutations) expected.add(mutation);
      // DOM operations have already queued observer delivery. Each cleanup owns
      // its own entries: later operations (even inside an observer) cannot have
      // their records erased by an earlier cleanup. No observer retains a ledger.
      view!.queueMicrotask(() => {
        for (const mutation of mutations) expected.delete(mutation);
      });
    }

    function move(node: Node, parent: Node, before: Node | null): void {
      const mutations: ExpectedMutation[] = [];
      if (node.parentNode) {
        mutations.push({ target: node.parentNode, added: null, removed: node,
          previous: node.previousSibling, next: node.nextSibling });
      }
      const previous = before ? before.previousSibling : parent.lastChild;
      mutations.push({ target: parent, added: node, removed: null,
        previous: previous === node ? node.previousSibling : previous, next: before });
      parent.insertBefore(node, before);
      remember(mutations);
    }

    function remove(node: Node): void {
      const parent = node.parentNode;
      if (!parent) return;
      const mutation: ExpectedMutation = { target: parent, added: null, removed: node,
        previous: node.previousSibling, next: node.nextSibling };
      parent.removeChild(node);
      remember([mutation]);
    }

    function unwrap(entry: Entry): void {
      clear(entry);
      if (entry.settleTimer !== undefined) view!.clearTimeout(entry.settleTimer);
      entries.delete(entry.node);
      entry.host.removeAttribute('data-state');
      entry.host.removeAttribute('aria-busy');
      const parent = entry.host.parentNode;
      if (!parent) return;
      // Move what is there now, including site-added/replaced nodes. Never put
      // the saved Text back: the site may have moved or deleted it deliberately.
      while (entry.host.firstChild) move(entry.host.firstChild, parent, entry.host);
      remove(entry.host);
    }

    function owned(node: Text): Entry | undefined {
      const entry = entries.get(node);
      if (!entry) return undefined;
      if (node.parentNode !== entry.host || !entry.host.isConnected) {
        unwrap(entry);
        return undefined;
      }
      return entry;
    }

    const presentation: Presentation = {
      measureSource(node, read) {
        const entry = owned(node);
        if (!entry?.preview || entry.host.hasAttribute('data-measuring')) return read();
        entry.host.setAttribute('data-measuring', '');
        try { return read(); }
        finally { entry.host.removeAttribute('data-measuring'); }
      },
      begin(node) {
        const active = owned(node);
        if (active) {
          if (active.finishTimer === undefined &&
              (active.preview?.pending !== node.data || active.preview.rendered !== node.data)) clear(active);
          active.previous = node.data;
          if (active.settleTimer !== undefined) view!.clearTimeout(active.settleTimer);
          active.settleTimer = undefined;
          active.host.setAttribute('data-state', 'translating');
          active.host.setAttribute('aria-busy', 'true');
          return;
        }
        const parent = node.parentElement;
        if (!registration || !node.isConnected || node.ownerDocument !== doc || !parent ||
            parent.namespaceURI !== HTML || UNSAFE[parent.localName] || parent.closest(TAG)) return;
        for (let ancestor = parent.parentElement; ancestor; ancestor = ancestor.parentElement) {
          if (ancestor.namespaceURI !== HTML) return;
        }
        const host = doc.createElement(TAG);
        if (!registry) attachSurface(host);
        host.setAttribute('data-state', 'translating');
        host.setAttribute('aria-busy', 'true');
        entries.set(node, { node, host, previous: node.data });
        move(host, parent, node);
        move(node, host, null);
      },
      preview(node, text) {
        if (!text) {
          presentation.clearPreview(node);
          return;
        }
        const entry = owned(node);
        if (!entry || entry.host.getAttribute('data-state') !== 'translating') return;
        let preview = entry.preview;
        if (preview && !validPreview(entry, preview)) {
          unwrap(entry);
          return;
        }
        if (!preview) preview = startPreview(entry, text);
        preview.pending = text;
        if (entry.finishTimer !== undefined) view!.clearTimeout(entry.finishTimer);
        entry.finishTimer = undefined;
        if (preview.timer !== undefined || preview.frame !== undefined) return;
        const scheduled = preview;
        scheduled.timer = view!.setTimeout(() => {
          scheduled.timer = undefined;
          scheduled.frame = view!.requestAnimationFrame(() => {
            scheduled.frame = undefined;
            render(entry, scheduled);
          });
        }, 40);
      },
      clearPreview(node) {
        const entry = entries.get(node);
        if (entry) clear(entry);
      },
      applied(node, complete) {
        const entry = owned(node);
        if (!entry) return;
        const instant = view!.matchMedia('(prefers-reduced-motion: reduce), (forced-colors: active)').matches;
        if (instant) clear(entry);
        const preview = instant ? undefined :
          entry.preview ?? (node.data !== entry.previous ? startPreview(entry, node.data) : undefined);
        if (preview) {
          if (preview.timer !== undefined) view!.clearTimeout(preview.timer);
          if (preview.frame !== undefined) view!.cancelAnimationFrame(preview.frame);
          preview.timer = undefined;
          preview.frame = undefined;
          // Canonical ownership has committed. Keep partial flows mounted
          // across quanta/pauses; only the final reveal hands back to the slot.
          preview.source = node.data;
          preview.pending = node.data;
          render(entry, preview);
          if (entry.preview === preview) {
            if (entry.finishTimer !== undefined) view!.clearTimeout(entry.finishTimer);
            entry.finishTimer = complete ? view!.setTimeout(() => clear(entry), 160) : undefined;
          }
        }
        entry.previous = node.data;
        if (complete) {
          entry.host.setAttribute('data-state', 'translated');
          entry.host.removeAttribute('aria-busy');
        }
      },
      settled(node, status, interrupted = false) {
        const entry = owned(node);
        if (!entry) return;
        if (entry.settleTimer !== undefined) view!.clearTimeout(entry.settleTimer);
        entry.settleTimer = undefined;
        // Discard uncommitted progress, not the already committed partial flow.
        // A final reveal owns its independent handoff timer.
        if (entry.finishTimer === undefined &&
            (entry.preview?.pending !== node.data || entry.preview.rendered !== node.data)) clear(entry);
        if (status === 'failed') {
          unwrap(entry);
          return;
        }
        if (status === 'partial' && !interrupted) {
          // Bridge adjacent quanta without blinking. A genuinely parked unit
          // loses its paint after this bounded grace, retaining only its phase.
          entry.settleTimer = view!.setTimeout(() => {
            if (entries.get(node) !== entry) return;
            entry.settleTimer = undefined;
            entry.host.setAttribute('data-state', 'partial');
            entry.host.removeAttribute('aria-busy');
          }, 180);
        } else {
          entry.host.setAttribute('data-state', status);
          entry.host.removeAttribute('aria-busy');
        }
      },
      forget(node) {
        const entry = entries.get(node);
        if (entry) unwrap(entry);
      },
      restore(scope = doc) {
        for (const entry of entries.values()) {
          if (!entry.host.isConnected || scope === doc || scope === entry.node || scope.contains(entry.host) || scope.contains(entry.node)) {
            unwrap(entry);
          }
        }
      },
      ownsMutation(record) {
        if (record.type !== 'childList') return false;
        for (const mutation of expected) {
          if (record.target === mutation.target && record.previousSibling === mutation.previous &&
              record.nextSibling === mutation.next &&
              record.addedNodes.length === (mutation.added ? 1 : 0) &&
              record.removedNodes.length === (mutation.removed ? 1 : 0) &&
              (!mutation.added || record.addedNodes[0] === mutation.added) &&
              (!mutation.removed || record.removedNodes[0] === mutation.removed)) {
            expected.delete(mutation);
            return true;
          }
        }
        return false;
      },
    };
    return presentation;
  }
}
