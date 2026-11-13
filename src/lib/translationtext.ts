// Inline presentation only: source ownership and translated text stay in AT.dom.
namespace AT.translationtext {
  export type Presentation = {
    begin(node: Text): void;
    applied(node: Text, complete: boolean): void;
    settled(node: Text, status: 'translated' | 'partial' | 'failed'): void;
    forget(node: Text): void;
    restore(root?: Node): void;
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
      animation: at-aurora 3.4s ease-in-out infinite;
    }
    :host([data-reveal="a"]) .surface {
      animation: at-reveal-a 200ms ease-out;
    }
    :host([data-reveal="b"]) .surface {
      animation: at-reveal-b 200ms ease-out;
    }
    :host([data-state="translating"][data-reveal="a"]) .surface {
      animation: at-aurora 3.4s ease-in-out infinite, at-reveal-a 200ms ease-out;
    }
    :host([data-state="translating"][data-reveal="b"]) .surface {
      animation: at-aurora 3.4s ease-in-out infinite, at-reveal-b 200ms ease-out;
    }
    @keyframes at-aurora {
      0%, 100% { background-position: 0% 50%; }
      50% { background-position: 100% 50%; }
    }
    @keyframes at-reveal-a { from { opacity: .84; } to { opacity: 1; } }
    @keyframes at-reveal-b { from { opacity: .84; } to { opacity: 1; } }
    @media (prefers-reduced-motion: reduce), (forced-colors: active) {
      .surface {
        animation: none !important;
        background: none !important;
        box-shadow: none !important;
      }
    }
  `;

  type RegisteredConstructor = CustomElementConstructor & {
    [REGISTRATION]?: true;
  };
  type Entry = { node: Text; host: HTMLElement };
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
      entries.delete(entry.node);
      entry.host.removeAttribute('data-state');
      entry.host.removeAttribute('data-reveal');
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
      begin(node) {
        const active = owned(node);
        if (active) {
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
        entries.set(node, { node, host });
        move(host, parent, node);
        move(node, host, null);
      },
      applied(node, complete) {
        const entry = owned(node);
        if (!entry) return;
        entry.host.setAttribute('data-reveal', entry.host.getAttribute('data-reveal') === 'a' ? 'b' : 'a');
        if (complete) {
          entry.host.setAttribute('data-state', 'translated');
          entry.host.removeAttribute('aria-busy');
        }
      },
      settled(node, status) {
        const entry = owned(node);
        if (!entry) return;
        if (status === 'failed') {
          unwrap(entry);
          return;
        }
        entry.host.setAttribute('data-state', status);
        entry.host.removeAttribute('aria-busy');
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
