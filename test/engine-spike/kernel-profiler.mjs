// Browser-injected diagnostics only; production device/dispatch APIs are unchanged.
export function installKernelProfiler() {
  const family = code => code.includes('q4: array') ? 'matmul'
    : code.includes('bestAt:') || code.includes('struct Pick {') ? 'argmax'
    : code.includes('VALUE_OFFSET:') ? 'rope-kv'
    : code.includes('QUERY_ROWS:') ? 'attention-prefill'
    : code.includes('kcache:') ? 'attention-decode'
    : code.includes('struct Partial {') ? 'attention-merge'
    : code.includes('normalised: array') && code.includes('inv: array') ? 'norm-rope-q'
    : code.includes('sums: array') ? 'rmsnorm'
    : code.includes('inv: array') ? 'rope-q'
    : code.includes('fused: array') ? 'silu'
    : code.includes('var<storage, read> a:') ? 'residual-add' : 'other';
  const bind = (target, key) => {
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  };
  window.kernelProfiler = {
    wrap(device) {
      if (!device.features.has('timestamp-query')) throw new Error('GPU profiling requires timestamp-query');
      const modules = new WeakMap(), pipelines = new WeakMap(), groups = new WeakMap();
      const uniforms = new WeakSet(), values = new WeakMap();
      const waiting = [], reads = [], records = [];
      const queue = new Proxy(device.queue, {
        get(target, key) {
          if (key === 'writeBuffer') return (buffer, offset, data, ...rest) => {
            if (uniforms.has(buffer)) {
              if (offset !== 0 || rest.length) throw new Error('Profiler expects complete uniform writes');
              const bytes = ArrayBuffer.isView(data)
                ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
              values.set(buffer, new Uint32Array(bytes.slice().buffer));
            }
            return target.writeBuffer(buffer, offset, data, ...rest);
          };
          return bind(target, key);
        }
      });
      const wrapped = new Proxy(device, {
        get(target, key) {
          if (key === 'queue') return queue;
          if (key === 'createBuffer') return descriptor => {
            const buffer = target.createBuffer(descriptor);
            if (descriptor.usage & GPUBufferUsage.UNIFORM) uniforms.add(buffer);
            return buffer;
          };
          if (key === 'createShaderModule') return descriptor => {
            const module = target.createShaderModule(descriptor);
            modules.set(module, family(descriptor.code));
            return module;
          };
          if (key === 'createComputePipeline') return descriptor => {
            const pipeline = target.createComputePipeline(descriptor);
            pipelines.set(pipeline, modules.get(descriptor.compute.module) ?? 'other');
            return pipeline;
          };
          if (key === 'createBindGroup') return descriptor => {
            const group = target.createBindGroup(descriptor);
            groups.set(group, descriptor.entries.find(entry => entry.binding === 4)?.resource?.buffer);
            return group;
          };
          if (key === 'createCommandEncoder') return (...args) => {
            const encoder = target.createCommandEncoder(...args);
            let querySet, resolveBuffer, staging;
            const passes = [];
            return new Proxy(encoder, {
              get(command, method) {
                if (method === 'beginComputePass') return (descriptor = {}) => {
                  querySet ??= device.createQuerySet({ type: 'timestamp', count: 1024 });
                  const index = passes.length * 2;
                  if (index + 1 >= 1024) throw new Error('Too many profiled passes in one submission');
                  const record = { family: 'other', shape: null, dispatches: 0 };
                  passes.push(record);
                  const pass = command.beginComputePass({ ...descriptor,
                    timestampWrites: { querySet, beginningOfPassWriteIndex: index, endOfPassWriteIndex: index + 1 } });
                  return new Proxy(pass, {
                    get(compute, operation) {
                      if (operation === 'setPipeline') return pipeline => {
                        const nextFamily = pipelines.get(pipeline) ?? 'other';
                        record.family = record.dispatches === 0 || record.family === nextFamily
                          ? nextFamily : 'combined';
                        if (record.family === 'combined') record.shape = null;
                        compute.setPipeline(pipeline);
                      };
                      if (operation === 'setBindGroup') return (index, group, ...rest) => {
                        if (record.family === 'matmul') {
                          const meta = values.get(groups.get(group));
                          if (meta) record.shape = { n: meta[0], k: meta[1], rows: meta[3] };
                        }
                        compute.setBindGroup(index, group, ...rest);
                      };
                      if (operation === 'dispatchWorkgroups') return (...groups) => {
                        record.dispatches++;
                        compute.dispatchWorkgroups(...groups);
                      };
                      return bind(compute, operation);
                    }
                  });
                };
                if (method === 'finish') return (...args) => {
                  if (passes.length) {
                    const bytes = passes.length * 16;
                    resolveBuffer = device.createBuffer({ size: bytes, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
                    staging = device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
                    command.resolveQuerySet(querySet, 0, passes.length * 2, resolveBuffer, 0);
                    command.copyBufferToBuffer(resolveBuffer, 0, staging, 0, bytes);
                    waiting.push({ passes, querySet, resolveBuffer, staging });
                  }
                  return command.finish(...args);
                };
                return bind(command, method);
              }
            });
          };
          return bind(target, key);
        },
        set(target, key, value) { return Reflect.set(target, key, value, target); }
      });
      return {
        device: wrapped,
        sample(sample) {
          const entry = waiting.shift();
          if (!entry) throw new Error('Missing GPU timestamp submission for step');
          const order = records.length;
          const record = { order, phase: sample.phase, context: sample.context,
            inputTokens: sample.inputTokens, outputTokens: sample.outputTokens, activeRows: sample.activeRows, passes: entry.passes };
          records.push(record);
          const read = (async () => {
            try {
              await entry.staging.mapAsync(GPUMapMode.READ);
              const data = new BigUint64Array(entry.staging.getMappedRange());
              let sum = 0;
              for (let i = 0; i < entry.passes.length; i++) {
                const ns = Number(data[i * 2 + 1] - data[i * 2]);
                if (ns < 0) throw new Error('Non-monotonic GPU pass timestamps');
                entry.passes[i].gpuMs = ns / 1e6;
                sum += ns;
              }
              record.passGpuMs = sum / 1e6;
              record.spanGpuMs = Number(data[data.length - 1] - data[0]) / 1e6;
              record.betweenPassMs = record.spanGpuMs - record.passGpuMs;
              entry.staging.unmap();
            } finally {
              entry.staging.destroy(); entry.resolveBuffer.destroy(); entry.querySet.destroy();
            }
          })();
          // Keep the original promise for flush while preventing an unhandled rejection.
          read.catch(() => {});
          reads.push(read);
        },
        async initialization() {
          // Weight preparation submits before any inference onStep callback.
          // Keep those timings separate instead of shifting all step records.
          while (waiting.length) this.sample({ phase: 'initialization', context: 0,
            inputTokens: 0, outputTokens: 0, activeRows: 0 });
          return this.flush();
        },
        async flush() {
          await Promise.all(reads);
          if (waiting.length) throw new Error('Unattributed profiled GPU submissions');
          reads.length = 0;
          return records.splice(0);
        }
      };
    },
    async bandwidth(device) {
      // Four distinct 64MiB inputs exceed a single small-cache working set.
      // A read-only streaming probe is a calibration, not the whole model roof.
      const bytes = 64 * 1024 * 1024, words = bytes / 4, groups = 256, lanes = groups * 256;
      const buffers = Array.from({ length: 4 }, () => device.createBuffer({ size: bytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }));
      const output = device.createBuffer({ size: lanes * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const queries = device.createQuerySet({ type: 'timestamp', count: 2 });
      const resolve = device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
      const staging = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const check = device.createBuffer({ size: 64, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      try {
        const input = new Uint32Array(words);
        for (let i = 0; i < words; i++) input[i] = Math.imul(i, 1664525) + 1013904223;
        for (const buffer of buffers) device.queue.writeBuffer(buffer, 0, input);
        const module = device.createShaderModule({ code: `
          @group(0) @binding(0) var<storage, read> source: array<u32>;
          @group(0) @binding(1) var<storage, read_write> output: array<u32>;
          @compute @workgroup_size(256)
          fn main(@builtin(global_invocation_id) id: vec3<u32>) {
            var sum = 0u;
            for (var i = id.x; i < arrayLength(&source); i += ${lanes}u) { sum += source[i]; }
            output[id.x] = sum;
          }` });
        const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
        const bindings = buffers.map(buffer => device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
          { binding: 0, resource: { buffer } }, { binding: 1, resource: { buffer: output } }] }));
        await device.queue.onSubmittedWorkDone();
        const samples = [];
        for (let repeat = -1; repeat < 5; repeat++) {
          const start = performance.now();
          const encoder = device.createCommandEncoder();
          const pass = encoder.beginComputePass({ timestampWrites: {
            querySet: queries, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } });
          pass.setPipeline(pipeline);
          for (const group of bindings) { pass.setBindGroup(0, group); pass.dispatchWorkgroups(groups); }
          pass.end();
          encoder.resolveQuerySet(queries, 0, 2, resolve, 0);
          encoder.copyBufferToBuffer(resolve, 0, staging, 0, 16);
          device.queue.submit([encoder.finish()]);
          await staging.mapAsync(GPUMapMode.READ);
          const data = new BigUint64Array(staging.getMappedRange());
          const gpuMs = Number(data[1] - data[0]) / 1e6;
          staging.unmap();
          if (!(gpuMs > 0)) throw new Error('Invalid bandwidth timestamp');
          if (repeat >= 0) samples.push({ gpuMs, wallMs: performance.now() - start,
            readGBs: buffers.length * bytes / (gpuMs * 1e6) });
        }
        const encoder = device.createCommandEncoder();
        encoder.copyBufferToBuffer(output, 0, check, 0, 64);
        device.queue.submit([encoder.finish()]);
        await check.mapAsync(GPUMapMode.READ);
        const actual = new Uint32Array(check.getMappedRange());
        for (let lane = 0; lane < actual.length; lane++) {
          let expected = 0;
          for (let i = lane; i < words; i += lanes) expected = (expected + input[i]) >>> 0;
          if (actual[lane] !== expected) throw new Error(`Bandwidth checksum mismatch at lane ${lane}`);
        }
        check.unmap();
        return { readBytesPerSample: buffers.length * bytes, outputWriteBytesPerSample: buffers.length * lanes * 4,
          samples, medianReadGBs: samples.map(s => s.readGBs).sort((a, b) => a - b)[2],
          definition: 'GPU timestamps over four independent 64MiB read-and-sum dispatches; output stores excluded from read-byte numerator. Five warm samples. Not model bandwidth or a universal hardware maximum.' };
      } finally {
        for (const buffer of [...buffers, output, resolve, staging, check]) buffer.destroy();
        queries.destroy();
      }
    }
  };
}
