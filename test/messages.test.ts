// Unit tests for the message plumbing in `src/lib/browser.ts`: the router that
// lets handlers be plain async functions, the Promise response lifetime (with
// a raw Chrome callback fallback), the failure
// envelope every caller branches on, and the handle selection between the
// promise-based `browser` and plain `chrome`.
import assert from 'node:assert/strict';
import test from 'node:test';
import { load, resetGlobals, type ATNamespace } from './helpers.ts';

type Message = { type?: string; [key: string]: unknown };
type Listener = (message: Message, sender: unknown, sendResponse: (response: unknown) => void) => boolean | Promise<unknown>;

type Harness = {
  AT: ATNamespace;
  listeners: Listener[];
  sent: Message[];
  warnings: unknown[][];
  api: Record<string, unknown>;
};

/**
 * Installs a fake extension API, loads the namespace and silences `AT.warn`
 * into a recorder so failures can be asserted without noise.
 */
function boot(runtime: Record<string, unknown>, options: { asBrowser?: boolean } = {}): Harness {
  resetGlobals();
  const listeners: Listener[] = [];
  const sent: Message[] = [];
  const warnings: unknown[][] = [];
  // Every outbound message is recorded, whatever a test scripts the answer to be.
  const answer = runtime['sendMessage'] as ((message: Message) => unknown) | undefined;
  const api = {
    runtime: {
      onMessage: { addListener: (listener: Listener) => listeners.push(listener) },
      sendMessage: (message: Message) => {
        sent.push(message);
        return answer?.(message);
      }
    }
  };
  const host = globalThis as unknown as Record<string, unknown>;
  host.browser = api;
  if (options.asBrowser === true) {
    // A decoy: the standard name must win, so nothing may reach for `chrome`.
    host.chrome = {
      runtime: {
        onMessage: { addListener: () => assert.fail('chrome should not be used when browser exists') },
        sendMessage: () => assert.fail('chrome should not be used when browser exists')
      }
    };
  }
  const AT = load('lib/constants.js', 'lib/browser.js');
  AT.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  return { AT, listeners, sent, warnings, api: api as unknown as Record<string, unknown> };
}

/**
 * Lets the handler chain (`Promise.resolve().then(handler).then(answer)`) run to
 * completion without a wall-clock timer: the nextTick queue drains only after
 * every pending microtask, so the answer has landed when this resolves.
 */
const flush = () => new Promise<void>((resolve) => process.nextTick(resolve));

/** Calls a registered listener and waits for its asynchronous answer. */
async function reply(
  listener: Listener,
  message: Message,
  sender: unknown = {}
): Promise<{ keptChannel: boolean; response: unknown; answered: boolean }> {
  let response: unknown;
  let answered = false;
  const result = listener(message, sender, (value) => {
    response = value;
    answered = true;
  });
  const keptChannel = result === true || result instanceof Promise;
  if (result instanceof Promise) { response = await result; answered = true; }
  await flush();
  return { keptChannel, response, answered };
}

const SENDER = { id: 'ext', tab: { id: 7 }, frameId: 0 };

test('a handler answers asynchronously while the listener keeps the channel open', async () => {
  const { AT, listeners } = boot({});
  AT.onMessage({ 'at/x': async () => ({ value: 1 }) });
  assert.equal(listeners.length, 1, 'one table registers exactly one runtime listener');

  const result = await reply(listeners[0]!, { type: 'at/x' });
  assert.equal(result.keptChannel, true, 'the standard API must own the asynchronous reply');
  assert.deepEqual(result.response, { ok: true, value: 1 });
});

test('a handler that answers with its own failure keeps it', async () => {
  const { AT, listeners } = boot({});
  AT.onMessage({ 'at/x': async () => ({ ok: false, error: 'provider is down', code: 'rate-limit' }) });

  const { response } = await reply(listeners[0]!, { type: 'at/x' });
  assert.deepEqual(
    response,
    { ok: false, error: 'provider is down', code: 'rate-limit' },
    'the injected ok:true must not overwrite what the handler decided'
  );
});

test('a handler with nothing to report still answers with ok', async () => {
  const { AT, listeners } = boot({});
  AT.onMessage({ 'at/x': async () => undefined });
  const { response } = await reply(listeners[0]!, { type: 'at/x' });
  assert.deepEqual(response, { ok: true });
});

test('an unknown type is refused so another listener can answer', async () => {
  const { AT, listeners } = boot({});
  AT.onMessage({ 'at/x': async () => ({ value: 1 }) });

  let answered = false;
  const kept = listeners[0]!({ type: 'at/unknown' }, SENDER, () => {
    answered = true;
  });
  await flush();

  assert.equal(kept, false, 'answering false lets the runtime try the next listener');
  assert.equal(answered, false, 'nothing may be sent for a message the table does not own');
});

test('a rejecting handler becomes a failure envelope and is logged', async () => {
  const { AT, listeners, warnings } = boot({});
  AT.onMessage({
    'at/x': async () => {
      throw Object.assign(new Error('quota exceeded'), { code: 'rate-limit' });
    }
  });

  const { response } = await reply(listeners[0]!, { type: 'at/x' }, SENDER);
  assert.deepEqual(response, { ok: false, error: 'quota exceeded', code: 'rate-limit' });
  assert.equal(warnings.length, 1, 'the rejection must be reported, not swallowed');
  assert.equal(warnings[0]![0], 'at/x', 'the log line names the message that failed');
});

test('a thrown value that is not an Error still yields a readable envelope', async () => {
  const { AT, listeners } = boot({});
  AT.onMessage({
    'at/x': async () => {
      throw 'boom';
    }
  });

  const { response } = await reply(listeners[0]!, { type: 'at/x' });
  assert.deepEqual(response, { ok: false, error: 'boom', code: null });
});

test('a handler that throws synchronously is reported like a rejection', async () => {
  const { AT, listeners } = boot({});
  AT.onMessage({
    'at/x': () => {
      throw new Error('sync failure');
    }
  });

  const { keptChannel, response } = await reply(listeners[0]!, { type: 'at/x' });
  assert.equal(keptChannel, true);
  assert.deepEqual(response, { ok: false, error: 'sync failure', code: null });
});

test('the sender is handed to the handler untouched', async () => {
  const { AT, listeners } = boot({});
  let seen: unknown;
  AT.onMessage({ 'at/x': async (_message: Message, sender: unknown) => { seen = sender; return null; } });

  await reply(listeners[0]!, { type: 'at/x' }, SENDER);
  assert.deepEqual(seen, SENDER, 'tab identity must survive the wrapper');
});

test('sendMessage hands an object reply over untouched', async () => {
  const nested = { depth: 2 };
  const { AT } = boot({ sendMessage: async () => ({ ok: true, nested }) });
  const response = await AT.sendMessage({ type: 'at/x' });
  assert.equal(response.ok, true);
  assert.equal(response.nested, nested, 'the payload is not copied or reshaped');
});

test('a non-object reply becomes a no-response failure naming the type', async () => {
  const { AT, sent } = boot({ sendMessage: async () => undefined });
  const response = await AT.sendMessage({ type: 'at/missing' });
  assert.deepEqual(response, { ok: false, error: 'no listener answered at/missing', code: 'no-response' });
  assert.deepEqual(sent, [{ type: 'at/missing' }], 'the message is forwarded as it was built');
});

test('a runtime rejection keeps its own code when it has one', async () => {
  const { AT } = boot({
    sendMessage: async () => {
      throw Object.assign(new Error('message channel closed'), { code: 'channel-closed' });
    }
  });
  const response = await AT.sendMessage({ type: 'at/x' });
  assert.deepEqual(response, { ok: false, error: 'message channel closed', code: 'channel-closed' });
});

test('a message with no type is still reported by a fallback name', async () => {
  const { AT } = boot({ sendMessage: async () => undefined });
  const response = await AT.sendMessage(null);
  assert.equal(response.error, 'no listener answered message');
  assert.equal(response.code, 'no-response');
});

test('the promise-based browser object wins over chrome', async () => {
  const { AT, api } = boot({ sendMessage: async () => ({ ok: true, via: 'browser' }) }, { asBrowser: true });
  assert.equal(AT.api, api, 'the captured handle is the one the code uses');
  const response = await AT.sendMessage({ type: 'at/x' });
  assert.equal(response.via, 'browser');
});

test('a context without a runtime answers with a failure object, not a crash', async () => {
  resetGlobals();
  const host = globalThis as unknown as Record<string, unknown>;
  host.browser = { i18n: { getMessage: () => '' } };
  const AT = load('lib/constants.js', 'lib/browser.js');
  const response = await AT.sendMessage({ type: 'at/x' });
  assert.equal(response.ok, false);
  assert.equal(response.code, 'no-response');
  assert.match(String(response.error), /sendMessage/, 'the reason mentions the missing call');
});

// The on-device engine adds a second hop: the background forwards a message to
// the offscreen document by tagging it, and only that document answers. The
// router must treat the tag as payload it never touches.
test('a message tagged for the on-device host is dispatched like any other', async () => {
  const { AT, listeners } = boot({});
  const seen: Message[] = [];
  AT.onMessage({
    [AT.C.MSG.LOCAL_TRANSLATE]: (message: Message) => {
      seen.push(message);
      return { translations: ['\uc548\ub155'] };
    }
  });

  const result = await reply(
    listeners[0]!,
    { type: AT.C.MSG.LOCAL_TRANSLATE, to: 'offscreen', modelId: 'model-a', texts: ['Hello'] },
    SENDER
  );
  assert.equal(result.keptChannel, true, 'the host answer also arrives asynchronously');
  assert.deepEqual(result.response, { ok: true, translations: ['\uc548\ub155'] });
  assert.deepEqual(
    seen,
    [{ type: AT.C.MSG.LOCAL_TRANSLATE, to: 'offscreen', modelId: 'model-a', texts: ['Hello'] }],
    'the routing tag and the payload reach the handler untouched'
  );
});

test('sendMessage forwards the routing tag so the right context can answer', async () => {
  const { AT, sent } = boot({ sendMessage: (message: Message) => ({ ok: true, answeredBy: message.to }) });
  const response = await AT.sendMessage({ type: AT.C.MSG.LOCAL_UNLOAD, to: 'offscreen' });
  assert.deepEqual(sent, [{ type: AT.C.MSG.LOCAL_UNLOAD, to: 'offscreen' }], 'the tag is sent as it was built');
  assert.equal(response.ok, true);
  assert.equal(response.answeredBy, 'offscreen', 'the answer comes from whoever claimed the tag');
});

test('the offscreen placement reports its status through the abstraction', async () => {
  // offscreen.js is plumbing: it installs the host and lets status changes out
  // as a broadcast. It must not hold the API object itself, or the Chrome-only
  // surface would leak into the shared code.
  resetGlobals();
  const sent: Message[] = [];
  const host = globalThis as unknown as Record<string, unknown>;
  host.browser = {
    runtime: {
      getURL: (path: string) => path,
      sendMessage: async (message: Message) => {
        sent.push(message);
        return { ok: true };
      },
      onMessage: { addListener: () => {} }
    },
    i18n: { getMessage: () => '' }
  };
  const AT = load(
    'lib/constants.js',
    'lib/browser.js',
    'lib/local.js',
    'lib/modelstore.js',
    'lib/localhost.js',
    'offscreen.js'
  );

  const status = await AT.localhost.status();
  assert.equal(status.target, 'offscreen', 'the host knows it is the Chrome placement');
  const pushes = sent.filter((entry) => entry.type === AT.C.MSG.LOCAL_STATUS);
  assert.ok(pushes.length >= 1, 'a status change leaves the document');
  assert.equal('to' in pushes[0]!, false, 'the push is a broadcast the background listens for');
});

test('the browser detector answers with a code, and nothing else is invented', async () => {
  // i18n.detectLanguage is CLD: both Chrome and Firefox ship it (MV3 promise
  // form). The wrapper sorts nothing, it reads the first entry the API ranked.
  resetGlobals();
  const host = globalThis as unknown as Record<string, unknown>;
  const calls: string[] = [];
  let answer: unknown = {
    isReliable: true,
    languages: [
      { language: 'de', percentage: 71 },
      { language: 'en', percentage: 29 }
    ]
  };
  host.browser = {
    runtime: { sendMessage: async () => undefined, onMessage: { addListener: () => {} }, getURL: (path: string) => path },
    i18n: {
      detectLanguage: async (text: string) => {
        calls.push(text);
        return answer;
      }
    }
  };
  const AT = load('lib/constants.js', 'lib/browser.js');

  assert.deepEqual(await AT.detectLanguage('  Guten Morgen  '), { code: 'de', reliable: true });
  assert.deepEqual(calls, ['  Guten Morgen  '], 'the text goes out as the caller wrote it');

  answer = { isReliable: false, languages: [{ language: 'und', percentage: 100 }] };
  assert.equal(await AT.detectLanguage('...'), null, 'an undetermined answer is no answer');

  answer = { isReliable: true, languages: [] };
  assert.equal(await AT.detectLanguage('hi'), null);

  answer = { languages: [{ language: 'ko', percentage: 100 }] };
  assert.deepEqual(await AT.detectLanguage('안녕'), { code: 'ko', reliable: false }, 'reliability is reported, not assumed');

  assert.equal(await AT.detectLanguage('   '), null, 'empty text is never sent to the detector');
  assert.equal(calls.length, 4, 'the four real texts were asked, the blank one was not');

  delete (host.browser as Record<string, unknown>).i18n;
  assert.equal(await AT.detectLanguage('hello'), null, 'a browser without a detector answers nothing');
});

test('a detector that throws is a missing answer, not a failed translation', async () => {
  resetGlobals();
  const host = globalThis as unknown as Record<string, unknown>;
  host.browser = {
    runtime: { sendMessage: async () => undefined, onMessage: { addListener: () => {} }, getURL: (path: string) => path },
    i18n: {
      detectLanguage: async () => {
        throw new Error('detector exploded');
      }
    }
  };
  const AT = load('lib/constants.js', 'lib/browser.js');
  assert.equal(await AT.detectLanguage('hello'), null);
});


test('standard browser listener returns the real pending operation, not a detached callback', async () => {
  const { AT, listeners } = boot({});
  let finish!: (value: unknown) => void;
  const operation = new Promise((resolve) => { finish = resolve; });
  AT.onMessage({ 'at/long': () => operation });
  const response = listeners[0]!({type:'at/long'}, {}, () => assert.fail('standard API must not call sendResponse'));
  assert.ok(response instanceof Promise);
  let settled=false;
  void response.then(()=>{settled=true;});
  await flush(); assert.equal(settled,false);
  finish({ status:'ready' });
  assert.deepEqual(await response,{ok:true,status:'ready'});
});

test('raw Chrome listener preserves its asynchronous callback fallback', async () => {
  resetGlobals();
  const listeners: Listener[]=[];
  const host=globalThis as unknown as Record<string,unknown>;
  host.chrome={runtime:{onMessage:{addListener:(listener:Listener)=>listeners.push(listener)}}};
  const AT=load('lib/constants.js','lib/browser.js');
  AT.onMessage({'at/x':async()=>({value:4})});
  let answer:unknown;
  assert.equal(listeners[0]!({type:'at/x'}, {}, value=>{answer=value;}),true);
  await flush(); assert.deepEqual(answer,{ok:true,value:4});
});
