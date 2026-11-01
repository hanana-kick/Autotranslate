// CDP observation only: no Runtime.evaluate, debugger pauses, API patches,
// network capture, or model substitution. Credentials never enter this module.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function observeExtensionRuntime(context, output, redact) {
  const cdp = await context.browser().newBrowserCDPSession();
  const sessions = new Map(), attached = new Set(), events = [];
  let nextId = 0, stopped = false, flushing = Promise.resolve();
  const safeUrl = (value) => {
    try { const u = new URL(value); return u.origin + u.pathname; }
    catch { return redact(String(value || '')).slice(0, 300); }
  };
  function record(event) {
    if (events.length >= 4000) return;
    events.push({ at: new Date().toISOString(), ...event });
    const json = redact(JSON.stringify(events, null, 2));
    flushing = flushing.then(() => writeFile(join(output, 'runtime-events.json'), json)).catch(() => {});
    if (['error', 'warning', 'exception'].includes(event.level)) console.log(redact(JSON.stringify({ runtimeDiagnostic: event })));
  }
  const command = (sessionId, method) => cdp.send('Target.sendMessageToTarget', {
    sessionId, message: JSON.stringify({ id: ++nextId, method })
  });
  async function attach(info) {
    if (stopped || attached.has(info.targetId) || !info.url.startsWith('chrome-extension://')) return;
    attached.add(info.targetId);
    try {
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: info.targetId, flatten: false });
      sessions.set(sessionId, { type: info.type, url: safeUrl(info.url) });
      await command(sessionId, 'Runtime.enable');
      await command(sessionId, 'Log.enable').catch(() => {});
      record({ kind: 'attached', ...sessions.get(sessionId) });
    } catch (error) { record({ kind: 'attach-error', url: safeUrl(info.url), message: redact(error.message) }); }
  }
  cdp.on('Target.receivedMessageFromTarget', ({ sessionId, message }) => {
    const origin = sessions.get(sessionId);
    if (!origin) return;
    const data = JSON.parse(message), p = data.params;
    if (data.method === 'Runtime.consoleAPICalled') {
      const values = p.args.map((v) => v.value ?? v.description ?? v.type);
      record({ ...origin, kind: 'console', level: p.type, message: redact(values.join(' ')).slice(0, 3000) });
    } else if (data.method === 'Runtime.exceptionThrown') {
      record({ ...origin, kind: 'exception', level: 'exception', message: redact(p.exceptionDetails.exception?.description || p.exceptionDetails.text).slice(0, 3000) });
    } else if (data.method === 'Log.entryAdded') {
      record({ ...origin, kind: 'browser-log', level: p.entry.level, message: redact(p.entry.text).slice(0, 3000) });
    }
  });
  cdp.on('Target.targetCreated', ({ targetInfo }) => void attach(targetInfo));
  cdp.on('Target.targetInfoChanged', ({ targetInfo }) => void attach(targetInfo));
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  const discover = async () => {
    if (stopped) return;
    const { targetInfos } = await cdp.send('Target.getTargets');
    await Promise.all(targetInfos.map(attach));
  };
  await discover();
  const poll = setInterval(() => void discover().catch(() => {}), 3000);
  poll.unref();
  return async () => { stopped = true; clearInterval(poll); await flushing; await cdp.detach().catch(() => {}); };
}
