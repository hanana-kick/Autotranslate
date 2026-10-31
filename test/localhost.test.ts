import assert from 'node:assert/strict';
import test from 'node:test';
import { load, resetGlobals, type ATNamespace } from './helpers.ts';

// The production host imports a deterministic MediaPipe-contract double. These
// are lifecycle/protocol tests, NOT model quality or hardware-acceleration tests.
const globals = globalThis as ATNamespace;
let current: ATNamespace | null = null;
let sequence = 0;
const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

test.afterEach(() => {
  current?.localhost.unload('test');
  current = null;
  delete globals.__hostFixture;
  if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
  else delete globals.navigator;
});

function host(options: { warmupFails?: boolean; firstGenerationHangs?: boolean; oversized?: boolean; empty?: boolean; software?: boolean; delayed?: boolean; corrupt?: boolean; streamCorrupt?: boolean } = {}) {
  resetGlobals();
  const deviceCalls: ATNamespace[] = [], devices: ATNamespace[] = [];
  const softwareAdapter = { info: { architecture: 'swiftshader' },
    features: new Set(['subgroups']),
    limits: { maxBufferSize: 1073741824, maxStorageBufferBindingSize: 1073741824, maxStorageBuffersPerShaderStage: 32 },
    async requestDevice(options: ATNamespace) {
      deviceCalls.push(options);
      const device = { destroyed: false, destroy() { this.destroyed = true; } };
      devices.push(device); return device;
    }
  };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { gpu: { requestAdapter: async () => (options.software ? softwareAdapter : {}) } } });
  const AT = load('lib/constants.js', 'lib/gemma.js', 'lib/local.js', 'lib/modelstore.js', 'lib/localhost.js');
  current = AT;
  const instances: ATNamespace[] = [];
  globals.__hostFixture = {
    create(settings: ATNamespace) {
      const number = instances.length;
      const instance: ATNamespace = {
        settings, closed: false, closeCount: 0, prompts: [] as string[],
        sizeInTokens: (value: string) => options.oversized && value.includes('oversized') ? 10_000 : 24,
        cancelProcessing() {},
        close() { this.closed = true; this.closeCount++; },
        async generateResponse(prompt: string, listener?: (partial: string, done: boolean) => void): Promise<string> {
          assert.equal(this.closed, false, 'a disposed runtime must not be reused');
          this.prompts.push(prompt);
          if (prompt.includes('Good morning.')) {
            if (options.warmupFails) throw new Error('warmup failed');
            return '좋은 아침입니다.';
          }
          if (options.delayed) await new Promise((resolve) => setTimeout(resolve, 45));
          if (number === 0 && options.firstGenerationHangs) return new Promise(() => {});
          if (options.corrupt) return '<pad>'.repeat(946);
          if (options.streamCorrupt) { listener?.('<pad>', false); return new Promise(() => {}); }
          return options.empty ? '' : '검증된 응답';
        }
      };
      instances.push(instance);
      return instance;
    }
  };
  const moduleText = `export const FilesetResolver={forGenAiTasks:async()=>({wasmLoaderPath:'test',wasmBinaryPath:'test'})};
    export const LlmInference={createFromOptions:async(_fileset,options)=>globalThis.__hostFixture.create(options)};
    // isolated module ${sequence++}`;
  AT.getURL = () => `data:text/javascript,${encodeURIComponent(moduleText)}`;
  AT.modelstore.get = async (id: string) => ({ id, name: 'fixture.task', size: 1024 * 1024 });
  AT.modelstore.read = async () => new Blob([new Uint8Array(16)]);
  AT.local.GENERATION_TIMEOUT_MS = 25;
  AT.localhost.install('background', () => {});
  const request = (over: ATNamespace = {}) => AT.localhost.handle({ type: AT.C.MSG.LOCAL_TRANSLATE,
    modelId: 'fixture-model', source: 'en', target: 'ko', maxTokens: 1024, texts: ['Hello world'], ...over });
  return { AT, instances, request, deviceCalls, devices };
}

test('host: changing the context budget recreates the same model with matching options', async () => {
  const { AT, instances } = host();
  await AT.localhost.handle({ type: AT.C.MSG.LOCAL_LOAD, modelId: 'fixture-model', maxTokens: 512 });
  await AT.localhost.handle({ type: AT.C.MSG.LOCAL_LOAD, modelId: 'fixture-model', maxTokens: 2048 });
  assert.equal(instances.length, 2);
  assert.equal(instances[0]!.closed, true);
  assert.equal(instances[1]!.settings.maxTokens, 2048);
});

test('host: a failed warmup rejects installation and disposes the tentative instance', async () => {
  const { AT, instances } = host({ warmupFails: true });
  await assert.rejects(() => AT.localhost.handle({ type: AT.C.MSG.LOCAL_LOAD,
    modelId: 'fixture-model', maxTokens: 512 }), /warmup failed/);
  assert.equal(instances[0]!.closed, true);
  assert.equal((await AT.localhost.status()).state, 'error');
});

test('host: an oversized single prompt is refused before inference', async () => {
  const { request, instances } = host({ oversized: true });
  await assert.rejects(() => request({ texts: ['oversized input'] }), /context|budget/i);
  assert.equal(instances[0]!.prompts.length, 1, 'only warmup ran');
});

test('host: a timed-out instance is disposed before the next queued generation', async () => {
  const { request, instances } = host({ firstGenerationHangs: true });
  await assert.rejects(() => request(), /timeout/i);
  const next = await request();
  assert.equal(instances.length, 2);
  assert.equal(instances[0]!.closeCount, 1);
  assert.deepEqual(next.translations, ['검증된 응답']);
});

test('host: an empty native answer rejects without a successful translation', async () => {
  const { request } = host({ empty: true });
  await assert.rejects(request, /empty-output/);
});


test('host: real software-adapter classification selects a bounded longer generation budget', async () => {
  const { AT, request } = host({ software: true, delayed: true });
  AT.local.SOFTWARE_GENERATION_TIMEOUT_MS = 100;
  AT.local.IDLE_UNLOAD_MS = 15;
  assert.deepEqual((await request()).translations, ['검증된 응답']);
  assert.equal((await AT.localhost.status()).softwareRendering, true);
});


test('host: software devices retain actual limits but do not enable subgroup kernels', async () => {
  const { AT, request, instances, deviceCalls, devices } = host({ software: true });
  await request();
  assert.equal(deviceCalls.length, 1);
  assert.deepEqual(deviceCalls[0]!.requiredFeatures, []);
  assert.equal(deviceCalls[0]!.requiredLimits.maxBufferSize, 1073741824);
  assert.equal(instances[0]!.settings.baseOptions.gpuOptions.device, devices[0]);
  AT.localhost.unload('test-device-lifetime');
  assert.equal(devices[0]!.destroyed, true);
});

test('host: hardware keeps the locked SDK default GPU device configuration', async () => {
  const { request, instances, deviceCalls } = host();
  await request();
  assert.equal(deviceCalls.length, 0);
  assert.equal(instances[0]!.settings.baseOptions.gpuOptions, undefined);
});

test('host: software single-input prompt preserves source, target and every input character', async () => {
  const { AT, request, instances } = host({ software: true });
  const text = 'line one\n<at0>リンク</at0> & line two';
  await request({ source: 'ja', target: 'ko', texts: [text] });
  assert.equal(instances[0]!.prompts.at(-1), AT.local.wrapChatPrompt(
    'Translate Japanese (ja) to Korean (ko). Output only the translation.\n\n' + text));
});
test('host: unknown source remains unknown in the software prompt', async () => {
  const { AT, request, instances } = host({ software: true });
  await request({ source: 'auto', target: 'ko', texts: ['Hello.'] });
  assert.equal(instances[0]!.prompts.at(-1), AT.local.wrapChatPrompt(
    'Translate the text to Korean (ko). Output only the translation.\n\nHello.'));
});
test('host: hardware keeps the original trained translation prompt', async () => {
  const { AT, request, instances } = host();
  await request();
  assert.equal(instances[0]!.prompts.at(-1), AT.local.buildBatchPrompt('en', 'ko', ['Hello world'], null));
});
test('host: software prompt still uses the real token-budget guard', async () => {
  const { request, instances } = host({ software: true, oversized: true });
  await assert.rejects(() => request({ texts: ['oversized input'] }), /context|budget/i);
  assert.equal(instances[0]!.prompts.length, 1, 'only warmup, no overflowing generation');
});


test('host: padding tokens are rejected instead of becoming DOM text', async () => {
  const { AT, request } = host({ corrupt: true });
  await assert.rejects(request, /control-token/);
  const status = await AT.localhost.status();
  assert.equal(status.state, 'error'); assert.equal(status.reason, 'invalid-output');
  assert.equal(status.generations, 0);
});

test('host: a streamed control token is rejected before a hanging generation finishes', async () => {
  const { request } = host({ streamCorrupt: true });
  await assert.rejects(request, /control-token/);
});
