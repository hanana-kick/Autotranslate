// Single entry point to the extension APIs.
// Load after vendor/browser-polyfill.js and lib/constants.js.
(() => {
  const AT = (globalThis.AT ??= {});

  // The vendored polyfill installs a promise-based `browser`; fall back to
  // `chrome` so the file also works in plain pages used by the smoke tests.
  const api = globalThis.browser ?? globalThis.chrome;
  if (!api) {
    throw new Error('Autotranslate: no browser/chrome API available');
  }

  AT.api = api;
  AT.runtime = api.runtime ?? null;
  AT.tabs = api.tabs ?? null;
  AT.storage = api.storage ?? null;
  AT.action = api.action ?? null;
  AT.scripting = api.scripting ?? null;
  AT.contextMenus = api.contextMenus ?? null;

  AT.getURL = (path) => AT.runtime.getURL(path);

  AT.i18n = {
    msg(key, subs) {
      const text = api.i18n?.getMessage?.(key, subs);
      return text || `[${key}]`;
    },
    // Fills textContent for [data-i18n], placeholder for [data-i18n-placeholder]
    // and title for [data-i18n-title].
    apply(root = document) {
      for (const el of root.querySelectorAll('[data-i18n]')) {
        el.textContent = AT.i18n.msg(el.dataset.i18n);
      }
      for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
        el.setAttribute('placeholder', AT.i18n.msg(el.dataset.i18nPlaceholder));
      }
      for (const el of root.querySelectorAll('[data-i18n-title]')) {
        el.setAttribute('title', AT.i18n.msg(el.dataset.i18nTitle));
      }
    }
  };

  // Wraps a message listener table so handlers can be plain async functions.
  // Returns true from the listener and answers via sendResponse, which works
  // identically in Chrome and Firefox.
  AT.onMessage = (handlers) => {
    api.runtime.onMessage.addListener((message, sender, sendResponse) => {
      const handler = handlers[message?.type];
      if (!handler) return false;
      Promise.resolve()
        .then(() => handler(message, sender))
        .then((result) => sendResponse({ ok: true, ...(result ?? {}) }))
        .catch((error) => {
          AT.warn(message.type, error);
          sendResponse({
            ok: false,
            error: error?.message ?? String(error),
            code: error?.code ?? null
          });
        });
      return true;
    });
  };

  AT.sendMessage = (message) => api.runtime.sendMessage(message);
})();
