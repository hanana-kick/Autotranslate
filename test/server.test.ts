import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { load } from './helpers.ts';

const AT = load('lib/constants.js', 'lib/pagecontext.js', 'lib/targets.js', 'lib/rules.js', 'lib/local.js', 'lib/settings.js', 'lib/engines.js');
AT.detectLanguage = async () => null;
AT.local.callHost = async () => { throw new Error('server mode must never touch local model/tokenizer/WebGPU'); };
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });
const response = (content: unknown, extra = {}) => ({ choices: [{ message: { content }, finish_reason: 'stop', ...extra }] });
async function endpoint(t: test.TestContext, handler: (req: IncomingMessage, res: ServerResponse, body: any) => void) {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let text = ''; for await (const part of req) text += part;
    const body = text ? JSON.parse(text) : null;
    requests.push({ url: req.url, method: req.method, headers: req.headers, body });
    handler(req, res, body);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  return { requests, config: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: '', model: 'big', timeoutMs: 5000 } };
}
const json = (res: ServerResponse, data: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
const translate = (server: unknown, texts: string[] = ['Hello.'], extra = {}) => AT.engines.translate({ engine: 'openai', server, source: 'en', target: 'ko', texts, ...extra });

test('server URL normalizes root, trailing slash and full completion URL; preserves API prefixes', () => {
  for (const [input, expected] of [
    ['http://localhost:8000', 'http://localhost:8000/v1'],
    ['http://127.0.0.1:11434/v1/', 'http://127.0.0.1:11434/v1'],
    ['https://example.com/proxy/v1/chat/completions', 'https://example.com/proxy/v1'],
    ['http://[::1]:8000', 'http://[::1]:8000/v1']
  ]) assert.equal(AT.settings.normalizeServerBaseUrl(input), expected);
  for (const value of ['file:///etc/passwd', 'javascript:alert(1)', 'https://key:secret@example.com', 'https://example.com/?key=secret', 'https://example.com/#secret']) {
    assert.throws(() => AT.settings.normalizeServerBaseUrl(value));
  }
});

test('real HTTP: standard Chat Completions body, optional key, no local model required', async t => {
  const { requests, config } = await endpoint(t, (_req, res) => json(res, response('안녕하세요.')));
  const result = await translate(config);
  assert.deepEqual(result.translations, ['안녕하세요.']);
  assert.equal(requests[0].url, '/v1/chat/completions');
  assert.equal(requests[0].headers.authorization, undefined);
  assert.equal(requests[0].body.model, 'big'); assert.equal(requests[0].body.stream, false);
  assert.deepEqual(Object.keys(requests[0].body).sort(), ['messages', 'model', 'stream']);
  assert.equal(requests[0].body.messages[1].content, 'Hello.');
});

test('real HTTP: bearer credential is used only at the configured endpoint', async t => {
  const { requests, config } = await endpoint(t, (_req, res) => json(res, response('안녕하세요.')));
  await translate({ ...config, apiKey: 'test-only-key' });
  assert.equal(requests[0].headers.authorization, 'Bearer test-only-key');
  assert.equal(requests[0].headers.cookie, undefined);
  assert.equal(JSON.stringify(requests[0].body).includes('test-only-key'), false);
});

test('real HTTP: multi-segment JSON result keeps order and deduplicates input', async t => {
  const { requests, config } = await endpoint(t, (_req, res) => json(res, response('```json\n["안녕", "고마워"]\n```')));
  const r = await translate(config, ['hello', 'thanks', 'hello', '!']);
  assert.deepEqual(r.translations, ['안녕', '고마워', '안녕', '!']);
  assert.deepEqual(JSON.parse(requests[0].body.messages[1].content), ['hello', 'thanks']);
  assert.equal(r.requested, 2); assert.equal(requests.length, 1);
});

test('real HTTP: Korean-only fragments never request inference', async t => {
  const { requests, config } = await endpoint(t, () => assert.fail('target-language input reached the server'));
  const texts = ['이 노래 정말 좋아요!!', '감사합니다', '네'];
  const result = await translate(config, texts);
  assert.deepEqual(result.translations, texts);
  assert.equal(result.requested, 0);
  assert.equal(requests.length, 0);
});

test('real HTTP: target-language exclusion preserves mixed-batch positions and counts', async t => {
  const mixed = '좋아요 Please translate this';
  const { requests, config } = await endpoint(t, (_req, res) => json(res, response('["안녕", "혼합 번역"]')));
  const korean = '이 노래 정말 좋아요!!';
  const result = await translate(config, [korean, 'Hello', mixed, korean, 'Hello']);
  assert.deepEqual(JSON.parse(requests[0].body.messages[1].content), ['Hello', mixed]);
  assert.deepEqual(result.translations, [korean, '안녕', '혼합 번역', korean, '안녕']);
  assert.equal(result.requested, 2);
  assert.equal(requests.length, 1);
});

// Measured against qwen2.5:7b: asked for only a JSON array, it answered
// `["읽으세요","튜토리얼을","지금mediately."];` — a trailing semicolon that cost the
// whole chunk, and with it the page, which then waited on a retry.
for (const [name, answer] of [
  ['a trailing semicolon', '["읽으세요","튜토리얼을","지금mediately."];'],
  ['a leading sentence', 'Here are the translations: ["읽으세요","튜토리얼을","지금mediately."]'],
  ['a trailing period', '["읽으세요","튜토리얼을","지금mediately."].']
] as const) {
  test(`real HTTP: an array wrapped in ${name} is still the answer`, async t => {
    const { config } = await endpoint(t, (_req, res) => json(res, response(answer)));
    const r = await translate(config, ['Read', 'the guide', 'carefully.']);
    assert.deepEqual(r.translations, ['읽으세요', '튜토리얼을', '지금mediately.']);
  });
}

test('real HTTP: an answer with no array at all is still a format error', async t => {
  const { config } = await endpoint(t, (_req, res) => json(res, response('I am not able to translate that.')));
  await assert.rejects(() => translate(config, ['Read', 'the guide', 'carefully.']), /JSON string per input segment/);
});

test('real HTTP: an array of the wrong length is still refused', async t => {
  const { config } = await endpoint(t, (_req, res) => json(res, response('["읽으세요"]')));
  await assert.rejects(() => translate(config, ['Read', 'the guide', 'carefully.']), /unexpected result count/);
});

test('real HTTP: models endpoint is independent of model selection and supports manual IDs', async t => {
  const { requests, config } = await endpoint(t, (_req, res) => json(res, { data: [{ id: 'small' }, { id: 'big' }, { id: 'big' }, { id: 1 }] }));
  assert.deepEqual(await AT.engines.listServerModels({ ...config, model: '' }), ['big', 'small']);
  assert.equal(requests[0].url, '/v1/models'); assert.equal(requests[0].method, 'GET');
});

test('real HTTP: text content parts supported; separate reasoning ignored', async t => {
  const { config } = await endpoint(t, (_req, res) => json(res, { choices: [{ finish_reason: 'stop', message: { content: [{ type: 'text', text: '안녕하세요.' }], reasoning_content: 'private reasoning' } }] }));
  assert.deepEqual((await translate(config)).translations, ['안녕하세요.']);
});

for (const [status, code] of [[401, 'config'], [403, 'config'], [404, 'http'], [429, 'rate-limit'], [500, 'http'], [504, 'timeout']] as const) {
  test(`real HTTP: ${status} has actionable category and does not echo secrets`, async t => {
    const { config } = await endpoint(t, (_req, res) => json(res, { error: { message: 'secret-key private page text' } }, status));
    await assert.rejects(translate({ ...config, apiKey: 'secret-key' }), (err: any) => err.code === code && !/secret-key|private page/.test(err.message));
  });
}

for (const [name, content, extra] of [
  ['empty', '', {}], ['control token', '<pad>'.repeat(50), {}],
  ['truncated', '잘린 문장', { finish_reason: 'length' }], ['refused', null, { message: { refusal: 'No' } }]
] as const) {
  test('real HTTP: reject ' + name + ' without writing identity translations', async t => {
    const { config } = await endpoint(t, (_req, res) => json(res, response(content, extra)));
    await assert.rejects(translate(config), (err: any) => ['format', 'provider'].includes(err.code));
  });
}

test('real HTTP: rejects malformed JSON and mismatched counts', async t => {
  const { config } = await endpoint(t, (_req, res) => json(res, response('["한 개만"]')));
  await assert.rejects(translate(config, ['hello', 'thanks']), (err: any) => err.code === 'format' && err.reason === 'count');
});

test('real HTTP: API redirects are not followed with bearer credentials', async t => {
  let redirected = 0;
  const target = await endpoint(t, (_req, res) => { redirected++; json(res, response('안녕')); });
  const first = await endpoint(t, (_req, res) => { res.writeHead(302, { Location: target.config.baseUrl + '/chat/completions' }); res.end(); });
  await assert.rejects(translate({ ...first.config, apiKey: 'test-secret' }), (err: any) => err.code === 'network');
  assert.equal(redirected, 0);
});

test('real HTTP: turning a tab OFF can abort an outstanding generation', async t => {
  const { config } = await endpoint(t, () => {});
  const controller = new AbortController();
  const pending = translate(config, ['Hello.'], { signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, /cancelled/);
});

test('real HTTP: deadline covers a body which never finishes', async t => {
  const { config } = await endpoint(t, (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{'); });
  await assert.rejects(translate(config), (err: any) => err.code === 'timeout');
});

test('real HTTP: response size limit fails explicitly', async t => {
  const { config } = await endpoint(t, (_req, res) => { res.writeHead(200, { 'Content-Length': 3000000 }); res.flushHeaders(); });
  await assert.rejects(translate(config), /too large/);
});

test('server mode cannot silently fall back to local or a different endpoint', async () => {
  await assert.rejects(translate({ baseUrl: '', model: 'big' }), (err: any) => err.code === 'config');
  await assert.rejects(translate({ baseUrl: 'file:///tmp/a', model: 'big' }), (err: any) => err.code === 'config');
  await assert.rejects(translate({ baseUrl: 'https://example.invalid/v1', model: '' }), (err: any) => err.code === 'config');
});

test('server secrets are omitted from content snapshots and key changes invalidate caches', async () => {
  let stored: any = {};
  let trusted = 0;
  AT.storage = { local: { get: async () => stored, set: async (next: any) => { stored = next; }, setAccessLevel: async () => { trusted++; } } };
  const first = await AT.settings.save({ engine: 'openai', serverBaseUrl: 'http://localhost:8000', serverModel: 'big', serverApiKey: 'first-key' });
  const snapshot1 = AT.settings.contentSnapshot(first);
  const second = await AT.settings.save({ serverApiKey: 'second-key' });
  const snapshot2 = AT.settings.contentSnapshot(second);
  assert.notEqual(snapshot1.translationKey, snapshot2.translationKey);
  assert.equal(/first-key|second-key|localhost|8000/.test(JSON.stringify(snapshot2)), false);
  assert.ok(trusted >= 2);
  assert.equal((await AT.settings.reset()).serverApiKey, '');
});

test('server prompts unambiguously translate greetings and preserve fragment boundaries', async t => {
  const { requests, config } = await endpoint(t, (_req, res, body) => json(res,
    response(body.messages[1].content.startsWith('[') ? '["읽으세요", "안내서를", "주의 깊게"]' : '감사합니다.')));
  await translate(config, ['Thank you.']);
  await translate(config, ['Read', 'the guide', 'carefully.']);
  assert.match(requests[0].body.messages[0].content, /from English into Korean \(ko\)/);
  assert.match(requests[0].body.messages[0].content, /greetings rather than answering them/);
  assert.match(requests[1].body.messages[0].content, /exactly 3 translated strings/);
  assert.deepEqual(JSON.parse(requests[1].body.messages[1].content), ['Read', 'the guide', 'carefully.']);
  assert.equal(requests.length, 2);
});
