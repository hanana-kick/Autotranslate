// Content script: injected on demand by the background context, never
// declared in the manifest, so pages pay nothing until a translation is asked
// for. All provider traffic goes through the background context.
(() => {
  if (globalThis.__autotranslate) return;

  const AT = globalThis.AT;
  const C = AT.C;

  const state = {
    translator: null,
    settings: null,
    observer: null,
    timer: 0,
    card: null,
    busy: Promise.resolve()
  };

  globalThis.__autotranslate = {
    version: AT.runtime?.getManifest?.().version ?? 'dev',
    state
  };

  async function requestBatch(texts, settings) {
    const response = await AT.sendMessage({
      type: C.MSG.BATCH,
      texts,
      targetLang: settings.targetLang,
      sourceLang: settings.sourceLang,
      url: location.href
    });
    if (!response?.ok) {
      const error = new Error(response?.error ?? 'the background context rejected the batch');
      error.code = response?.code ?? null;
      throw error;
    }
    return response.translations;
  }

  function ensureTranslator(settings) {
    if (!state.translator) {
      state.translator = AT.dom.createTranslator({
        doc: document,
        maxNodes: settings.maxNodes,
        batchChars: settings.batchChars,
        // Read settings from state so a later target-language change applies
        // without re-injecting the script.
        translate: (texts) => requestBatch(texts, state.settings ?? settings)
      });
    }
    return state.translator;
  }

  // 'translate' always, 'skip' never, 'detect' compares the declared page
  // language with the target language.
  function shouldTranslate(decision, settings) {
    if (!settings.enabled) return false;
    if (decision.action === 'translate') return true;
    if (decision.action === 'skip') return false;
    if (settings.sourceLang && settings.sourceLang !== 'auto') return true;
    const declared = (document.documentElement?.lang ?? '').trim();
    if (!declared) return true;
    return !C.sameLanguage(declared, settings.targetLang);
  }

  function report(patch) {
    return AT.sendMessage({
      type: C.MSG.STATE_CHANGED,
      status: patch.status,
      translated: patch.translated ?? 0,
      error: patch.error ?? null
    }).catch(() => {});
  }

  function stopObserver() {
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    clearTimeout(state.timer);
    state.timer = 0;
  }

  function scheduleTick() {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = 0;
      runTick().catch((error) => AT.warn('dynamic translation failed', error));
    }, C.OBSERVER_DEBOUNCE_MS);
  }

  function startObserver() {
    if (state.observer || !state.translator) return;
    state.observer = new MutationObserver(scheduleTick);
    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  async function runTick() {
    if (!state.translator || !state.settings?.enabled) return;
    const root = document.body ?? document.documentElement;
    const nodes = state.translator.collect(root, C.OBSERVER_BATCH_NODES);
    if (nodes.length === 0) return;
    await state.translator.translateNodes(nodes);
    await report({ status: 'translated', translated: state.translator.stats().translated });
  }

  async function translate(message) {
    const settings = message.settings;
    if (!settings) throw new Error('translate request without settings');
    state.settings = settings;
    const decision = message.decision ?? { action: 'translate' };
    if (!shouldTranslate(decision, settings)) {
      await report({ status: 'idle' });
      return { status: 'idle', reason: decision.reason ?? 'language-matches-target' };
    }
    const translator = ensureTranslator(settings);
    const result = await translator.translateRoot(document.documentElement);
    startObserver();
    const translated = translator.stats().translated;
    await report({ status: 'translated', translated });
    return { status: 'translated', translated, requested: result.requested };
  }

  async function restore() {
    stopObserver();
    const restored = state.translator
      ? state.translator.restore(document.documentElement).restored
      : 0;
    await report({ status: 'idle' });
    return { status: 'idle', restored };
  }

  function closeCard() {
    if (state.card) {
      state.card.remove();
      state.card = null;
    }
  }

  function showCard(text, settings) {
    closeCard();
    const card = document.createElement('div');
    card.setAttribute('data-no-translate', '');
    card.setAttribute(
      'dir',
      C.RTL_LANGS.has(settings?.targetLang) ? 'rtl' : 'ltr'
    );
    card.setAttribute(
      'style',
      [
        'all:initial',
        'position:fixed',
        'z-index:2147483647',
        'inset:auto 16px 16px auto',
        'max-width:22rem',
        'padding:12px 14px',
        'border-radius:10px',
        'border:1px solid rgba(0,0,0,.18)',
        'background:#fffff8',
        'color:#1c1c1c',
        'font:14px/1.5 system-ui,sans-serif',
        'box-shadow:0 6px 24px rgba(0,0,0,.22)',
        'white-space:pre-wrap'
      ].join(';')
    );
    const body = document.createElement('p');
    body.setAttribute(
      'style',
      'all:unset;display:block;max-height:14rem;overflow:auto;white-space:pre-wrap'
    );
    body.textContent = text;
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '\u00d7';
    close.setAttribute('aria-label', AT.i18n.msg('content_close'));
    close.setAttribute(
      'style',
      'all:unset;position:absolute;inset:4px 6px auto auto;cursor:pointer;padding:2px 6px;font:16px/1 system-ui,sans-serif'
    );
    close.addEventListener('click', closeCard);
    card.append(body, close);
    document.documentElement.appendChild(card);
    state.card = card;
  }

  async function translateSelection(message) {
    const settings = message.settings ?? state.settings;
    if (!settings) throw new Error('selection request without settings');
    state.settings = settings;
    const selected = String(message.text ?? globalThis.getSelection?.()?.toString() ?? '').trim();
    if (selected.length < 2) {
      showCard(AT.i18n.msg('content_noSelection'), settings);
      return { status: 'empty' };
    }
    const [translated] = await requestBatch([selected], settings);
    showCard(translated || selected, settings);
    return { status: 'selection' };
  }

  AT.onMessage({
    [C.MSG.CONTENT_PING]: () => ({ pong: true }),
    [C.MSG.CONTENT_TRANSLATE]: (message) => {
      state.busy = state.busy.then(() => translate(message), () => translate(message));
      return state.busy;
    },
    [C.MSG.CONTENT_RESTORE]: () => {
      state.busy = state.busy.then(() => restore(), () => restore());
      return state.busy;
    },
    [C.MSG.CONTENT_TRANSLATE_SELECTION]: (message) => translateSelection(message)
  });
})();
