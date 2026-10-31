import assert from 'node:assert/strict';
import test from 'node:test';
import { load, resetGlobals, type ATNamespace } from './helpers.ts';

// Exercise the production install transaction. Storage and native model loading
// are injected boundaries; actual OPFS/IndexedDB are covered by browser tests.
function transaction(failure?: 'prepare' | 'save' | 'cleanup') {
  resetGlobals();
  const AT = load('lib/constants.js', 'lib/local.js', 'lib/modelstore.js', 'lib/modelflow.js');
  const events: string[] = [];
  const old = { id: 'old-model', name: 'same.task', size: 1048576 };
  const next = { id: 'new-model', name: 'same.task', size: 1048576 };
  let selected = old.id;
  const files = new Set([old.id]);
  AT.modelstore.requestPersistence = async () => true;
  AT.modelstore.importFile = async () => {
    events.push('stage'); files.add(next.id);
    return { ok: true, record: next, bytes: next.size };
  };
  AT.sendMessage = async (message: ATNamespace) => {
    assert.equal(message.type, AT.C.MSG.LOCAL_PREPARE);
    events.push('prepare');
    return failure === 'prepare' ? { ok: false, error: 'invalid model' } : { ok: true };
  };
  AT.settings = { load: async () => ({ localModelId: selected }), save: async (patch: { localModelId: string }) => {
    events.push('select');
    if (failure === 'save') throw new Error('storage unavailable');
    selected = patch.localModelId;
  } };
  AT.modelstore.retireReplaced = async (_id: string, previousId: string) => {
    assert.equal(previousId, old.id);
    events.push('cleanup');
    assert.equal(selected, next.id, 'cleanup must follow persisted activation');
    if (failure === 'cleanup') throw new Error('disk busy');
    files.delete(old.id);
    return [old.id];
  };
  return { events, files, selected: () => selected, install: () => AT.modelflow.installFromFile({ name: next.name }) };
}

test('install: a rejected model leaves the working file and selection intact', async () => {
  const env = transaction('prepare');
  const result = await env.install();
  assert.equal(result.ok, false);
  assert.equal(result.stored, true);
  assert.equal(env.selected(), 'old-model');
  assert.deepEqual([...env.files], ['old-model', 'new-model']);
  assert.deepEqual(env.events, ['stage', 'prepare']);
});

test('install: failed selection persistence does not delete either model', async () => {
  const env = transaction('save');
  const result = await env.install();
  assert.equal(result.ok, false);
  assert.match(result.error, /storage unavailable/);
  assert.equal(env.selected(), 'old-model');
  assert.deepEqual([...env.files], ['old-model', 'new-model']);
  assert.deepEqual(env.events, ['stage', 'prepare', 'select']);
});

test('install: successful activation commits selection before retiring old bytes', async () => {
  const env = transaction();
  const result = await env.install();
  assert.equal(result.ok, true);
  assert.deepEqual(result.retired, ['old-model']);
  assert.equal(env.selected(), 'new-model');
  assert.deepEqual([...env.files], ['new-model']);
  assert.deepEqual(env.events, ['stage', 'prepare', 'select', 'cleanup']);
});

test('install: cleanup failure does not roll back a verified, selected model', async () => {
  const env = transaction('cleanup');
  const result = await env.install();
  assert.equal(result.ok, true);
  assert.equal(env.selected(), 'new-model');
  assert.deepEqual([...env.files], ['old-model', 'new-model']);
});

test('install: onboarding prefers the selected working model over a newer failed stage', async () => {
  resetGlobals();
  const AT = load('lib/constants.js', 'lib/local.js', 'lib/modelstore.js', 'lib/modelflow.js');
  AT.settings = { load: async () => ({ localModelId: 'working-model' }) };
  AT.modelstore.list = async () => [{ id: 'failed-stage' }, { id: 'working-model' }];
  assert.equal((await AT.modelflow.installed()).id, 'working-model');
});
