// Read-only host supervision must not share the Options tab navigated by QA.
// This uses another copy of the shipped UI, never an injected/runtime double.
import { setTimeout as delay } from 'node:timers/promises';

async function closePage(page) {
  let timer;
  try {
    await Promise.race([page.close().catch(() => {}), new Promise((resolve) => { timer = setTimeout(resolve, 5000); })]);
  } finally { clearTimeout(timer); }
}

export async function withNativeHostMonitor({ context, optionsURL, readHost, run, label,
  intervalMs = 1000, beforeClose = async () => {} }) {
  const originalPages = new Set(context.pages());
  const probe = await context.newPage();
  const stop = new AbortController();
  let monitorFailure = false;
  let task;
  try {
    await probe.goto(optionsURL, { waitUntil: 'load', timeout: 30000 });
    await probe.waitForFunction(() => typeof AT !== 'undefined' && typeof AT.sendMessage === 'function');
    const monitor = (async () => {
      let previousError = null;
      while (!stop.signal.aborted) {
        try {
          await delay(intervalMs, undefined, { signal: stop.signal });
          const reply = await readHost(probe);
          if (stop.signal.aborted) return;
          if (!reply?.ok) throw new Error(label + ': host unavailable: ' + (reply?.error || 'no response'));
          const status = reply.status;
          const key = status?.state === 'error' ? JSON.stringify([status.reason, status.lastError, status.recoveries]) : null;
          if (key && key === previousError) throw new Error(label + ': native host failed: ' + status.lastError);
          previousError = key;
        } catch (error) {
          if (stop.signal.aborted) return;
          monitorFailure = true;
          throw error;
        }
      }
    })();
    task = Promise.resolve().then(run);
    return await Promise.race([task, monitor]);
  } finally {
    stop.abort();
    if (monitorFailure) {
      // Unblock outstanding fixture waits before final failure evidence is saved.
      // A failed native host stays a failed run; no scenario is marked successful.
      await beforeClose();
      const fixturePages = context.pages().filter((p) => p !== probe && !originalPages.has(p));
      await Promise.all(fixturePages.map(closePage));
      await Promise.race([task?.catch(() => {}), delay(2000, undefined, { ref: false })]);
    }
    await closePage(probe);
  }
}
