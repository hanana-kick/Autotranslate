// Privileged global settings UI. Credentials are sent only to the background.
namespace AT.glossaryoptions {
  type Status = {
    config: Omit<AT.notionsync.Config, 'token'>;
    hasToken: boolean;
    state: AT.notionsync.SyncState;
    snapshot: { version: number; revision: string; syncedAt: number; concepts: number; entries: number } | null;
  };
  const fields = () => document.getElementById('notionFields') as HTMLFieldSetElement;
  const input = (id: string) => document.getElementById(id) as HTMLInputElement;
  const mappings = new Map<keyof AT.notionsync.Mapping, HTMLInputElement>();
  let busy = false;
  /** The last status, so a save knows whether a token is already stored. */
  let latest: Status | undefined;

  function message(text: string, kind = 'info'): void {
    const node = document.getElementById('notionStatus')!;
    node.textContent = text;
    node.dataset.kind = kind;
  }

  async function call(type: string, patch?: unknown): Promise<Status> {
    const reply = await AT.sendMessage({ type, ...(patch === undefined ? {} : { patch }) });
    if (!reply?.ok) throw new Error(String(reply?.error ?? 'The glossary service is unavailable.'));
    return reply as unknown as Status;
  }

  function render(status: Status, config = false): void {
    latest = status;
    if (config) {
      const c = status.config;
      input('notionEnabled').checked = c.enabled;
      (document.getElementById('notionSource') as HTMLSelectElement).value = c.source;
      input('notionConceptUrl').value = c.conceptUrl;
      input('notionTermUrl').value = c.termUrl;
      input('notionConceptDatabase').value = c.conceptDatabaseId;
      input('notionTermDatabase').value = c.termDatabaseId;
      input('notionConceptSource').value = c.conceptDataSourceId;
      input('notionTermSource').value = c.termDataSourceId;
      (document.getElementById('notionInterval') as HTMLSelectElement).value = String(c.intervalMinutes);
      for (const [key, node] of mappings) node.value = c.mapping[key];
      input('notionToken').value = '';
      sourceFields();
      input('notionClearToken').checked = false;
    }
    document.getElementById('notionTokenHint')!.textContent = AT.i18n.msg(
      status.hasToken ? 'glossary_tokenSaved' : 'glossary_tokenMissing');
    const snapshot = status.snapshot;
    const summary = document.getElementById('notionSummary')!;
    summary.textContent = snapshot ? AT.i18n.msg('glossary_summary', [String(snapshot.concepts),
      String(snapshot.entries), new Date(snapshot.syncedAt).toLocaleString()]) : AT.i18n.msg('glossary_empty');
    summary.dataset.revision = snapshot?.revision ?? '';
    if (status.state.running) message(AT.i18n.msg('glossary_busy'));
    else if (status.state.error) message(status.state.error, 'error');
    else if (!busy) message('');
  }

  /** The two sources need different identifiers, so only one group is shown. */
  function sourceFields(): void {
    const source = (document.getElementById('notionSource') as HTMLSelectElement).value;
    document.getElementById('notionPublicFields')!.hidden = source !== 'public';
    document.getElementById('notionTokenFields')!.hidden = source === 'public';
  }

  function collect(): Partial<AT.notionsync.Config> {
    const token = input('notionToken').value.trim();
    const mapping = Object.fromEntries([...mappings].map(([key, node]) => [key, node.value.trim()])) as AT.notionsync.Mapping;
    return {
      enabled: input('notionEnabled').checked,
      source: (document.getElementById('notionSource') as HTMLSelectElement).value as 'api' | 'public',
      conceptUrl: input('notionConceptUrl').value.trim(),
      termUrl: input('notionTermUrl').value.trim(),
      conceptDatabaseId: input('notionConceptDatabase').value.trim(),
      termDatabaseId: input('notionTermDatabase').value.trim(),
      conceptDataSourceId: input('notionConceptSource').value.trim(),
      termDataSourceId: input('notionTermSource').value.trim(),
      intervalMinutes: Number((document.getElementById('notionInterval') as HTMLSelectElement).value),
      mapping,
      ...(input('notionClearToken').checked ? { token: '' } : token ? { token } : {})
    };
  }

  /** Each source names what it still needs, before any request leaves. */
  function missingFields(status?: Status): string | null {
    const source = (document.getElementById('notionSource') as HTMLSelectElement).value;
    const missing: string[] = [];
    if (source === 'public') {
      if (!input('notionConceptUrl').value.trim()) missing.push(AT.i18n.msg('glossary_conceptUrl'));
      if (!input('notionTermUrl').value.trim()) missing.push(AT.i18n.msg('glossary_termUrl'));
    } else {
      const saved = status?.hasToken === true;
      if (!input('notionToken').value.trim() && !saved) missing.push(AT.i18n.msg('glossary_token'));
      if (!input('notionConceptDatabase').value.trim()) missing.push(AT.i18n.msg('glossary_conceptDatabase'));
      if (!input('notionTermDatabase').value.trim()) missing.push(AT.i18n.msg('glossary_termDatabase'));
    }
    return missing.length ? AT.i18n.msg('glossary_missingUrls', [missing.join(', ')]) : null;
  }

  async function save(sync: boolean): Promise<void> {
    if (busy) return;
    const missing = missingFields(latest);
    if (missing) { message(missing, 'error'); return; }
    busy = true;
    fields().disabled = true;
    message(AT.i18n.msg(sync ? 'glossary_busy' : 'glossary_saved'));
    try {
      const saved = await call(AT.C.MSG.GLOSSARY_SAVE, collect());
      render(saved, true);
      if (sync) render(await call(AT.C.MSG.GLOSSARY_SYNC));
      message(AT.i18n.msg('glossary_saved'), 'ok');
    } catch (error) {
      // The service returns sanitized errors, never Notion response bodies or tokens.
      message(String((error as Error)?.message ?? error), 'error');
    } finally {
      busy = false;
      fields().disabled = false;
    }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    const container = document.getElementById('notionMapping');
    if (!container) return;
    for (const key of Object.keys(AT.notionsync.defaults().mapping) as (keyof AT.notionsync.Mapping)[]) {
      const field = document.createElement('div');
      field.className = 'field';
      const label = document.createElement('label');
      const node = document.createElement('input');
      node.type = 'text';
      node.id = `notionMap-${key}`;
      node.spellcheck = false;
      label.htmlFor = node.id;
      label.textContent = AT.i18n.msg(`glossary_map_${key}`);
      mappings.set(key, node);
      field.append(label, node);
      container.append(field);
    }
    document.getElementById('notionSource')!.addEventListener('change', sourceFields);
    document.getElementById('notionSave')!.addEventListener('click', () => { void save(false); });
    document.getElementById('notionSync')!.addEventListener('click', () => { void save(true); });
    try {
      render(await call(AT.C.MSG.GLOSSARY_STATUS), true);
      fields().disabled = false;
      document.getElementById('glossarySection')!.dataset.ready = 'true';
    } catch (error) {
      message(String((error as Error)?.message ?? error), 'error');
    }
    AT.storage?.onChanged?.addListener((changes, area) => {
      if (area !== 'local' || busy || !(changes[AT.notionsync.STATE_KEY] || changes[AT.notionsync.SNAPSHOT_KEY])) return;
      void call(AT.C.MSG.GLOSSARY_STATUS).then(status => render(status)).catch(() => {});
    });
  });
}
