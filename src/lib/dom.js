// DOM text extraction and in-place replacement. Content-context only.
// Load after lib/constants.js, lib/browser.js.
(() => {
  const AT = (globalThis.AT ??= {});
  const C = AT.C;
  const dom = (AT.dom = {});

  const EDITABLE_SELECTOR = '[contenteditable=""], [contenteditable="true"]';

  dom.hasText = (text) =>
    typeof text === 'string' && text.trim().length > 1 && /[\p{L}\p{N}]/u.test(text);

  dom.isIgnoredElement = (element) => {
    if (!element || element.nodeType !== 1) return true;
    if (element.isContentEditable || element.closest(EDITABLE_SELECTOR)) return true;
    return Boolean(element.closest(C.IGNORE_SELECTOR));
  };

  function chunkByChars(items, limit) {
    const chunks = [];
    let current = [];
    let size = 0;
    for (const item of items) {
      const cost = item.length + 1;
      if (current.length && size + cost > limit) {
        chunks.push(current);
        current = [];
        size = 0;
      }
      current.push(item);
      size += cost;
    }
    if (current.length) chunks.push(current);
    return chunks;
  }

  /**
   * @param {object} options
   * @param {Document} options.doc
   * @param {number} [options.maxNodes]
   * @param {number} [options.batchChars]
   * @param {(texts: string[]) => Promise<string[]>} options.translate provider call
   */
  dom.createTranslator = ({
    doc,
    maxNodes = C.DEFAULT_MAX_NODES,
    batchChars = C.DEFAULT_BATCH_CHARS,
    translate
  }) => {
    if (typeof translate !== 'function') {
      throw new TypeError('AT.dom.createTranslator: translate(texts) is required');
    }
    // node -> {source, text, applied}. Presence means "currently translated":
    // `text` is what the node held before we touched it, `applied` is what we
    // wrote, so a later page rewrite is detectable.
    const originals = new Map();
    // source string -> translated string, reused across nodes and runs.
    const cache = new Map();

    function collect(root, limit) {
      const nodes = [];
      if (!root) return nodes;
      const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!dom.hasText(node.nodeValue)) return NodeFilter.FILTER_REJECT;
          const parent = node.parentElement;
          if (!parent || dom.isIgnoredElement(parent)) return NodeFilter.FILTER_REJECT;
          const known = originals.get(node);
          // Already translated and untouched since: leave it alone. If the page
          // rewrote the text, forget the record and treat it as new.
          if (known) {
            if (known.applied === node.nodeValue) return NodeFilter.FILTER_REJECT;
            originals.delete(node);
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      while (walker.nextNode() && nodes.length < limit) nodes.push(walker.currentNode);
      return nodes;
    }

    function apply(node, source, translated) {
      if (typeof translated !== 'string' || translated === source) return;
      if (!originals.has(node)) originals.set(node, { source, text: node.nodeValue });
      const entry = originals.get(node);
      entry.applied = translated;
      node.nodeValue = translated;
    }

    async function run(nodes) {
      const pending = [];
      const seen = new Set();
      const sources = [];
      for (const node of nodes) {
        const source = node.nodeValue;
        if (cache.has(source)) {
          apply(node, source, cache.get(source));
          continue;
        }
        pending.push({ node, source });
        if (!seen.has(source)) {
          seen.add(source);
          sources.push(source);
        }
      }
      for (const chunk of chunkByChars(sources, batchChars)) {
        const result = await translate(chunk);
        if (!Array.isArray(result) || result.length !== chunk.length) {
          throw new Error('translation provider returned an unexpected number of results');
        }
        chunk.forEach((source, index) => cache.set(source, result[index] ?? source));
      }
      for (const { node, source } of pending) apply(node, source, cache.get(source) ?? source);
      return { requested: sources.length, translated: originals.size };
    }

    return {
      collect,
      async translateRoot(root, { limit = maxNodes } = {}) {
        return run(collect(root ?? doc.documentElement, limit));
      },
      translateNodes(nodes) {
        return run(Array.from(nodes));
      },
      restore(root) {
        let restored = 0;
        for (const [node, entry] of [...originals]) {
          if (!root || root.contains(node)) {
            node.nodeValue = entry.text;
            restored += 1;
          }
          originals.delete(node);
        }
        return { restored };
      },
      stats() {
        return { translated: originals.size, cached: cache.size };
      }
    };
  };
})();
