// Read-only nested-worker CPU observation. No debugger pause, Runtime.evaluate,
// network recording or production API replacement is performed.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function observeNativeCPU(context, output, redact = String, accepts = (url) => url.startsWith('chrome-extension://')) {
  const root = await context.browser().newBrowserCDPSession();
  const children = new Map(), attached = new Set(), profiles = [], events = [], processes = [];
  let sequence = 0, stopping = false, writes = Promise.resolve();
  const safe = (url) => { try { const u = new URL(url); return `${u.protocol}//${u.host}${u.pathname}`; } catch { return redact(String(url || '')); } };
  const flush = () => {
    const snapshot = redact(JSON.stringify({ events, processes, profiles }, null, 2));
    writes = writes.then(() => writeFile(join(output, 'native-cpu-observation.json'), snapshot)).catch(() => {});
  };
  function note(event) { if (events.length < 2000) events.push({ at: Date.now(), ...event }); flush(); }
  function makeSession(parent, id, info) {
    const requests = new Map(), nested = new Map();
    const session = {
      id, info, nested, recording: false, finishing: false,
      async send(method, params = {}, timeout = 5000) {
        const requestId = ++sequence;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { requests.delete(requestId); reject(new Error(`${method} observation deadline`)); }, timeout);
          requests.set(requestId, { resolve, reject, timer });
          parent.send('Target.sendMessageToTarget', { sessionId: id, message: JSON.stringify({ id: requestId, method, params }) })
            .catch((error) => { clearTimeout(timer); requests.delete(requestId); reject(error); });
        });
      },
      receive(message) {
        const data = JSON.parse(message);
        if (data.id && requests.has(data.id)) {
          const p = requests.get(data.id); clearTimeout(p.timer); requests.delete(data.id);
          if (data.error) p.reject(new Error(data.error.message)); else p.resolve(data.result || {});
          return;
        }
        if (data.method === 'Target.receivedMessageFromTarget') nested.get(data.params.sessionId)?.receive(data.params.message);
        if (data.method === 'Target.attachedToTarget') {
          const { sessionId, targetInfo } = data.params;
          if (nested.has(sessionId)) return;
          const child = makeSession(session, sessionId, targetInfo); nested.set(sessionId, child);
          void initialize(child);
        }
        if (data.method === 'Runtime.exceptionThrown') note({ target: safe(info.url), kind: 'exception', message: redact(data.params.exceptionDetails.text) });
      },
      close() { for (const p of requests.values()) { clearTimeout(p.timer); p.reject(new Error('observation closed')); } requests.clear(); for (const child of nested.values()) child.close(); }
    };
    return session;
  }
  async function initialize(session) {
    note({ kind: 'attached', type: session.info.type, url: safe(session.info.url) });
    await session.send('Runtime.enable').catch(() => {});
    await session.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: false }).catch(() => {});
    if (session.info.type !== 'worker' || !session.info.url.includes('inference-worker')) return;
    try {
      await session.send('Profiler.enable');
      await session.send('Profiler.setSamplingInterval', { interval: 10000 });
      await session.send('Profiler.start'); session.recording = true;
      note({ kind: 'profiling-started', url: safe(session.info.url) });
    } catch (error) { note({ kind: 'profiling-error', message: redact(error.message) }); }
  }
  async function attach(info) {
    if (stopping || attached.has(info.targetId) || !accepts(info.url)) return;
    attached.add(info.targetId);
    try { const { sessionId } = await root.send('Target.attachToTarget', { targetId: info.targetId, flatten: false });
      const session = makeSession(root, sessionId, info); children.set(sessionId, session); await initialize(session);
    } catch (error) { note({ kind: 'attach-error', message: redact(error.message) }); }
  }
  function sessions() { const all = []; const walk = (map) => { for (const s of map.values()) { all.push(s); walk(s.nested); } }; walk(children); return all; }
  async function collectProfile(session, restart = true) {
    if (!session.recording || session.finishing) return;
    session.finishing = true;
    try {
      const { profile } = await session.send('Profiler.stop', {}, 8000); session.recording = false;
      const name = `native-worker-${profiles.length}.cpuprofile`;
      for (const node of profile.nodes) node.callFrame.url = safe(node.callFrame.url);
      await writeFile(join(output, name), redact(JSON.stringify(profile)));
      const durations = new Map();
      for (let i = 0; i < (profile.samples || []).length; i++) durations.set(profile.samples[i], (durations.get(profile.samples[i]) || 0) + (profile.timeDeltas[i] || 0));
      const top = profile.nodes.map(n => ({ function: n.callFrame.functionName, url: n.callFrame.url, selfMs: (durations.get(n.id) || 0) / 1000 })).filter(n => n.selfMs).sort((a,b) => b.selfMs-a.selfMs).slice(0, 15);
      profiles.push({ file: name, start: profile.startTime, end: profile.endTime, top }); flush();
      if (restart && !stopping) { await session.send('Profiler.start'); session.recording = true; }
    } catch (error) { note({ kind: 'profile-stop-error', message: redact(error.message) }); }
    finally { session.finishing = false; }
  }
  root.on('Target.receivedMessageFromTarget', ({ sessionId, message }) => children.get(sessionId)?.receive(message));
  root.on('Target.targetCreated', ({ targetInfo }) => void attach(targetInfo));
  root.on('Target.targetInfoChanged', ({ targetInfo }) => void attach(targetInfo));
  await root.send('Target.setDiscoverTargets', { discover: true });
  const discover = async () => { const { targetInfos } = await root.send('Target.getTargets'); await Promise.all(targetInfos.map(attach)); };
  await discover();
  let tick = 0;
  const timer = setInterval(() => {
    if (stopping) return;
    void root.send('SystemInfo.getProcessInfo').then(({ processInfo }) => { if (processes.length < 600) processes.push({ at: Date.now(), items: processInfo }); flush(); }).catch(() => {});
    if (++tick % 6 === 0) for (const s of sessions()) void collectProfile(s);
    void discover().catch(() => {});
  }, 5000); timer.unref();
  return async () => { stopping = true; clearInterval(timer); await Promise.all(sessions().map(s => collectProfile(s, false))); for (const s of children.values()) s.close(); await writes; await root.detach().catch(() => {}); };
}
