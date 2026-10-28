// Options page controller. Reads and writes storage directly; the background
// context picks the change up through storage.onChanged.
(() => {
  const AT = globalThis.AT;
  const C = AT.C;

  const el = (id) => document.getElementById(id);
  let settings = null;

  function option(value, label) {
    const node = document.createElement('option');
    node.value = value;
    node.textContent = label;
    return node;
  }

  function setStatus(node, text, kind) {
    node.textContent = text ?? '';
    node.dataset.kind = kind ?? 'info';
  }

  function selectedEngine() {
    return C.getEngineMeta(el('engine').value) ?? C.ENGINES[0];
  }

  function buildSelects() {
    el('engine').replaceChildren(...C.ENGINES.map((engine) => option(engine.id, engine.label)));
    el('targetLang').replaceChildren(
      ...C.LANGS.map((lang) => option(lang.code, `${lang.native} (${lang.code})`))
    );
    el('sourceLang').replaceChildren(
      option('auto', AT.i18n.msg('options_sourceAuto')),
      ...C.LANGS.map((lang) => option(lang.code, `${lang.native} (${lang.code})`))
    );
  }

  function renderRules() {
    const list = el('ruleList');
    if (settings.siteRules.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = AT.i18n.msg('options_noRules');
      list.replaceChildren(empty);
      return;
    }
    list.replaceChildren(
      ...settings.siteRules.map((rule) => {
        const item = document.createElement('li');
        item.className = 'rule';
        const code = document.createElement('code');
        code.textContent = rule.pattern;
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.dataset.action = rule.action;
        tag.textContent = AT.i18n.msg(rule.action === 'never' ? 'options_ruleNever' : 'options_ruleAlways');
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'ghost danger';
        remove.textContent = AT.i18n.msg('options_remove');
        remove.addEventListener('click', () => writeRules(rule.pattern, null));
        item.append(code, tag, remove);
        return item;
      })
    );
  }

  function render() {
    el('enabled').checked = settings.enabled;
    el('autoDetect').checked = settings.autoDetect;
    el('showBadge').checked = settings.showBadge;
    el('debug').checked = settings.debug;
    el('engine').value = settings.engine;
    el('endpoint').value = settings.endpoints[settings.engine] ?? '';
    el('apiKey').value = settings.apiKey;
    el('targetLang').value = settings.targetLang;
    el('sourceLang').value = settings.sourceLang;
    el('batchChars').value = String(settings.batchChars);
    el('maxNodes').value = String(settings.maxNodes);
    el('apiKeyField').hidden = !selectedEngine().supportsKey;
    el('engineDocs').textContent = selectedEngine().docs;
    renderRules();
  }

  function collect() {
    const engine = el('engine').value;
    return {
      enabled: el('enabled').checked,
      autoDetect: el('autoDetect').checked,
      showBadge: el('showBadge').checked,
      debug: el('debug').checked,
      engine,
      endpoints: { ...settings.endpoints, [engine]: el('endpoint').value },
      apiKey: el('apiKey').value,
      targetLang: el('targetLang').value,
      sourceLang: el('sourceLang').value,
      batchChars: el('batchChars').value,
      maxNodes: el('maxNodes').value,
      siteRules: settings.siteRules
    };
  }

  async function persist(nextSettings) {
    settings = await AT.settings.save(nextSettings);
    render();
    setStatus(el('saveStatus'), AT.i18n.msg('options_saved'), 'ok');
    return settings;
  }

  async function writeRules(pattern, action) {
    const canonical = AT.rules.canonical(pattern);
    if (!canonical) {
      setStatus(el('saveStatus'), AT.i18n.msg('options_badRule'), 'error');
      return;
    }
    const kept = settings.siteRules.filter((rule) => rule.pattern !== canonical);
    await persist({ ...collect(), siteRules: action ? [...kept, { pattern: canonical, action }] : kept });
  }

  function wire() {
    el('engine').addEventListener('change', () => {
      const engine = selectedEngine();
      el('endpoint').value = settings.endpoints[engine.id] ?? engine.endpoint;
      el('apiKeyField').hidden = !engine.supportsKey;
      el('engineDocs').textContent = engine.docs;
    });

    el('save').addEventListener('click', () => persist(collect()));

    el('reset').addEventListener('click', async () => {
      settings = await AT.settings.reset();
      render();
      setStatus(el('saveStatus'), AT.i18n.msg('options_resetDone'), 'ok');
    });

    el('addRule').addEventListener('click', async () => {
      await writeRules(el('rulePattern').value, el('ruleAction').value);
      el('rulePattern').value = '';
    });

    el('rulePattern').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') el('addRule').click();
    });

    el('testEngine').addEventListener('click', async () => {
      setStatus(el('testStatus'), AT.i18n.msg('options_testing'), 'info');
      const response = await AT.sendMessage({
        type: C.MSG.TEST_ENGINE,
        engine: el('engine').value,
        endpoint: el('endpoint').value,
        apiKey: el('apiKey').value,
        target: el('targetLang').value
      });
      if (!response?.ok) {
        setStatus(el('testStatus'), `${response?.code ? `[${response.code}] ` : ''}${response?.error}`, 'error');
        return;
      }
      setStatus(
        el('testStatus'),
        AT.i18n.msg('options_testOk', response.result.output, String(response.result.ms)),
        'ok'
      );
    });
  }

  document.addEventListener('DOMContentLoaded', async () => {
    AT.i18n.apply(document);
    buildSelects();
    settings = await AT.settings.load();
    wire();
    render();
  });
})();
