// Portable attention and fused RoPE/KV cache writes. Activations stay f32.
namespace AT.kernelattention {
  /**
   * One decode query/head per workgroup, dispatch (heads, rows, 1).
   * Same seven bindings as prefill; 16-byte Info is {heads, rows, window, mode}.
   * headDim is fixed at 128.
   * cacheStride is maxTokens * 128 f32 elements, with maxTokens <= 2048.
   * No optional features, scratch buffers, or additional dispatches.
   *
   * Four lanes cooperate on each QK dot, scoring four keys per lane group
   * before synchronizing. Eight context partitions accumulate V in parallel;
   * their vec4 outputs are combined by a fixed three-level reduction.
   * All arithmetic and storage remain f32. Shared memory is
   * 4 * maxTokens + 4624 bytes (12816 bytes at the engine's 2048-token limit).
   * Q/K already include the RoPE scale: no additional attention scale.
   *
   * Each row selects its own cache slot and causal/sliding-window interval.
   * Invalid positions produce zero. mode 1 skips V and returns zero; mode 2
   * skips QK and averages V over the visible interval. ropeKV must complete
   * before dispatch, exactly as for prefill.
   */
  export function decode(cacheStride: number): string {
    return `
      const CACHE_VECTORS: u32 = ${cacheStride / 4}u;
      const MAX_TOKENS: u32 = ${cacheStride / 128}u;
      struct Info { heads: u32, rows: u32, window: u32, mode: u32 };
      @group(0) @binding(0) var<storage, read> q: array<vec4<f32>>;
      @group(0) @binding(1) var<storage, read> kcache: array<vec4<f32>>;
      @group(0) @binding(2) var<storage, read> vcache: array<vec4<f32>>;
      @group(0) @binding(3) var<storage, read_write> out: array<vec4<f32>>;
      @group(0) @binding(4) var<uniform> info: Info;
      @group(0) @binding(5) var<storage, read> positions: array<u32>;
      @group(0) @binding(6) var<storage, read> cacheRows: array<u32>;

      var<workgroup> queries: array<vec4<f32>, 32>;
      var<workgroup> probs: array<f32, MAX_TOKENS>;
      // Reused for four-key dot partials, softmax reductions, and V partials.
      var<workgroup> scratch: array<vec4<f32>, 256>;
      // Cache slot, inclusive start, exclusive end, unused.
      var<workgroup> metadata: vec4<u32>;

      @compute @workgroup_size(256)
      fn main(@builtin(workgroup_id) wg: vec3<u32>,
              @builtin(local_invocation_index) tid: u32) {
        if (wg.x >= info.heads || wg.y >= info.rows) { return; }
        let qbase = (wg.y * info.heads + wg.x) * 32u;
        if (tid < 32u && info.mode != 2u) {
          queries[tid] = q[qbase + tid];
        }
        if (tid == 0u) {
          metadata = vec4<u32>(0u);
          let position = positions[wg.y];
          if (position < MAX_TOKENS) {
            let end = position + 1u;
            var start = 0u;
            if (info.window != 0u && end > info.window) {
              start = end - info.window;
            }
            metadata = vec4<u32>(cacheRows[wg.y], start, end, 0u);
          }
        }
        // Also synchronizes Q; storage-derived loop bounds become uniform.
        let queryInfo = workgroupUniformLoad(&metadata);
        let cacheBase = queryInfo.x * CACHE_VECTORS;
        let start = queryInfo.y;
        let end = queryInfo.z;
        if (start == end) {
          if (tid < 32u) { out[qbase + tid] = vec4<f32>(0.0); }
          return;
        }

        if (info.mode != 2u) {
          let keyLane = tid / 4u;
          let dotLane = tid % 4u;
          for (var base = start; base < end; base = base + 256u) {
            let token = base + keyLane;
            var dots = vec4<f32>(0.0);
            for (var d = dotLane; d < 32u; d = d + 4u) {
              let query = queries[d];
              if (token < end) {
                dots.x = dots.x + dot(query, kcache[cacheBase + token * 32u + d]);
              }
              if (token + 64u < end) {
                dots.y = dots.y + dot(query, kcache[cacheBase + (token + 64u) * 32u + d]);
              }
              if (token + 128u < end) {
                dots.z = dots.z + dot(query, kcache[cacheBase + (token + 128u) * 32u + d]);
              }
              if (token + 192u < end) {
                dots.w = dots.w + dot(query, kcache[cacheBase + (token + 192u) * 32u + d]);
              }
            }
            scratch[tid] = dots;
            workgroupBarrier();
            if (dotLane == 0u) {
              let scores = (scratch[tid] + scratch[tid + 1u]) +
                (scratch[tid + 2u] + scratch[tid + 3u]);
              if (token < end) { probs[token] = scores.x; }
              if (token + 64u < end) { probs[token + 64u] = scores.y; }
              if (token + 128u < end) { probs[token + 128u] = scores.z; }
              if (token + 192u < end) { probs[token + 192u] = scores.w; }
            }
            // All partial readers finish before scratch is reused.
            workgroupBarrier();
          }
        } else {
          for (var token = start + tid; token < end; token = token + 256u) {
            probs[token] = 0.0;
          }
          workgroupBarrier();
        }

        var localMax = -3.402823466e+38;
        for (var token = start + tid; token < end; token = token + 256u) {
          localMax = max(localMax, probs[token]);
        }
        scratch[tid].x = localMax;
        workgroupBarrier();
        // Four-way trees halve the barrier count of a binary reduction.
        for (var stride = 64u; stride > 0u; stride = stride / 4u) {
          if (tid < stride) {
            scratch[tid].x = max(
              max(scratch[tid].x, scratch[tid + stride].x),
              max(scratch[tid + stride * 2u].x, scratch[tid + stride * 3u].x));
          }
          workgroupBarrier();
        }
        let top = scratch[0].x;
        workgroupBarrier();
        var localSum = 0.0;
        for (var token = start + tid; token < end; token = token + 256u) {
          let probability = exp(probs[token] - top);
          probs[token] = probability;
          localSum = localSum + probability;
        }
        scratch[tid].x = localSum;
        workgroupBarrier();
        for (var stride = 64u; stride > 0u; stride = stride / 4u) {
          if (tid < stride) {
            scratch[tid].x = (scratch[tid].x + scratch[tid + stride].x) +
              (scratch[tid + stride * 2u].x + scratch[tid + stride * 3u].x);
          }
          workgroupBarrier();
        }
        let denominator = max(scratch[0].x, 1.0e-20);
        workgroupBarrier();

        let contextPart = tid / 32u;
        let dimension = tid % 32u;
        var accumulator = vec4<f32>(0.0);
        if (info.mode != 1u) {
          for (var token = start + contextPart; token < end; token = token + 8u) {
            accumulator = accumulator +
              probs[token] * vcache[cacheBase + token * 32u + dimension];
          }
        }
        scratch[tid] = accumulator;
        workgroupBarrier();
        if (tid < 128u) { scratch[tid] = scratch[tid] + scratch[tid + 128u]; }
        workgroupBarrier();
        if (tid < 64u) { scratch[tid] = scratch[tid] + scratch[tid + 64u]; }
        workgroupBarrier();
        if (tid < 32u) {
          out[qbase + tid] = (scratch[tid] + scratch[tid + 32u]) / denominator;
        }
      }
    `;
  }

  export const PREFILL_ROWS = 8;

  /**
   * Eight query rows x one head per workgroup, with 16-token KV tiles.
   * Dispatch (heads, ceil((rows - rowStart) / PREFILL_ROWS), 1), 256 threads.
   * Shared storage is at most 14,240 bytes, including subgroup metadata.
   * No optional features by default; useSubgroups enables a runtime-checked
   * subgroup fast path with the portable kernel as its fallback. cacheStride
   * counts f32 elements per cache slot (maxTokens * 128), not bytes. Q/K already
   * carry the RoPE scales; attention must not apply another 1/sqrt(headDim).
   *
   * Bindings: 0 Q, 1 K cache, 2 V cache, 3 output, 4 Info, 5 positions,
   * 6 cacheRows. Info is eight u32s (32 bytes):
   * {heads, rows, window, mode, rowStart, pad1, pad2, pad3}. rows is the total
   * active row count; rowStart selects the first prefill row (zero for pure
   * prefill). Q/output are [rows, heads, 128]; caches are [slot, maxTokens, 128].
   * All buffer offsets must satisfy their normal WebGPU binding alignment requirements.
   *
   * A workgroup discovers the distinct cache slots of its eight query rows.
   * Each slot's KV tiles are loaded once and shared by all matching queries;
   * mixed-slot and partial tiles need neither CPU grouping nor new bindings.
   * Only each query's causal/sliding-window interval contributes. Invalid
   * positions outside the cache capacity produce zero, as do empty intervals.
   * mode 1 computes scores/softmax but returns zero (novalue); mode 2 uses
   * zero scores and therefore uniform weights over the causal window (noscore).
   *
   * ropeKV must finish before this dispatch; the cache must contain every
   * position in each query's visible interval. No NxN score buffer is used.
   */
  export function prefill(cacheStride: number, useSubgroups = false): string {
    return `
    ${useSubgroups ? "enable subgroups;" : ""}
      const CACHE_VECTORS: u32 = ${cacheStride / 4}u;
      const QUERY_ROWS: u32 = ${PREFILL_ROWS}u;
      const MAX_TOKENS: u32 = ${cacheStride / 128}u;
      struct Info { heads: u32, rows: u32, window: u32, mode: u32, rowStart: u32, pad1: u32, pad2: u32, pad3: u32 };
      @group(0) @binding(0) var<storage, read> q: array<vec4<f32>>;
      @group(0) @binding(1) var<storage, read> kcache: array<vec4<f32>>;
      @group(0) @binding(2) var<storage, read> vcache: array<vec4<f32>>;
      @group(0) @binding(3) var<storage, read_write> out: array<vec4<f32>>;
      @group(0) @binding(4) var<uniform> info: Info;
      @group(0) @binding(5) var<storage, read> positions: array<u32>;
      @group(0) @binding(6) var<storage, read> cacheRows: array<u32>;

      var<workgroup> queries: array<vec4<f32>, 256>;
      // K and V occupy this tile at different stages, staying below 16 KiB.
      var<workgroup> kv: array<vec4<f32>, 512>;
      // QK pairs become four tile maxima.
      var<workgroup> partial: array<f32, 256>;
      var<workgroup> weights: array<f32, 128>;
      // State: running maximum, unnormalised denominator, old-output scale.
      var<workgroup> state: array<vec4<f32>, 8>;
      // Query metadata: cache slot, exclusive causal end, window start, valid.
      var<workgroup> queryMeta: array<vec4<u32>, 8>;
      // Group metadata: cache slot, union start, union end, unused.
      var<workgroup> groups: array<vec4<u32>, 8>;
      var<workgroup> groupCount: u32;
    ${useSubgroups ? "var<workgroup> subgroupReady: u32;" : ""}

      @compute @workgroup_size(256)
      fn main(@builtin(workgroup_id) wg: vec3<u32>,
            @builtin(local_invocation_index) tid: u32${useSubgroups ? `,
            @builtin(subgroup_invocation_id) sgLane: u32,
            @builtin(subgroup_size) sgSize: u32` : ""}) {
      ${useSubgroups ? `
      // Check the actual mapping before any invocation can diverge. A full,
      // contiguous subgroup of at least 32 lanes covers complete query blocks.
      let mapped = subgroupAll(tid % sgSize == sgLane);
      let firstBlock = subgroupMin(tid / sgSize);
      let lastBlock = subgroupMax(tid / sgSize);
      let activeLanes = subgroupAdd(1u);
      let valid = mapped && firstBlock == lastBlock &&
        activeLanes == sgSize && sgSize >= 32u && sgSize % 32u == 0u;
      if (tid % 32u == 0u) {
        partial[tid / 32u] = select(0.0, 1.0, valid);
      }
      workgroupBarrier();
      if (tid == 0u) {
        var allValid = true;
        for (var r = 0u; r < QUERY_ROWS; r = r + 1u) {
          allValid = allValid && partial[r] != 0.0;
        }
        subgroupReady = select(0u, 1u, allValid);
      }
      let fastAllowed = workgroupUniformLoad(&subgroupReady) != 0u;
      ` : ""}
        if (wg.x >= info.heads || wg.y * QUERY_ROWS + info.rowStart >= info.rows) { return; }
        let firstRow = info.rowStart + wg.y * QUERY_ROWS;
        let queryIndex = tid / 32u;
        let lane = tid % 32u;
        let keyIndex = lane / 2u;
        let dotLane = lane % 2u;
        let row = firstRow + queryIndex;
        var accumulator = vec4<f32>(0.0);

        if (tid < QUERY_ROWS) {
          state[tid] = vec4<f32>(0.0, 0.0, 1.0, 0.0);
        }
        if (tid == 0u) {
          groupCount = 0u;
          for (var r = 0u; r < QUERY_ROWS; r = r + 1u) {
            queryMeta[r] = vec4<u32>(0u);
            if (firstRow + r < info.rows) {
              let position = positions[firstRow + r];
              if (position < MAX_TOKENS) {
                let slot = cacheRows[firstRow + r];
                let end = position + 1u;
                var start = 0u;
                if (info.window != 0u && end > info.window) {
                  start = end - info.window;
                }
                queryMeta[r] = vec4<u32>(slot, end, start, 1u);
                var group = 0u;
                loop {
                  if (group >= groupCount) { break; }
                  if (groups[group].x == slot) { break; }
                  group = group + 1u;
                }
                if (group == groupCount) {
                  groups[group] = vec4<u32>(slot, start, end, 0u);
                  groupCount = groupCount + 1u;
                } else {
                  groups[group].y = min(groups[group].y, start);
                  groups[group].z = max(groups[group].z, end);
                }
              }
            }
          }
        }
        if (info.mode != 2u) {
          let qr = firstRow + tid / 32u;
          if (qr < info.rows) {
            queries[tid] = q[(qr * info.heads + wg.x) * 32u + tid % 32u];
          } else {
            queries[tid] = vec4<f32>(0.0);
          }
        }
        // Uniform loads synchronize metadata/Q and make the tile loop bounds
        // provably uniform without disabling WGSL uniformity diagnostics.
        let count = workgroupUniformLoad(&groupCount);
        let query = queryMeta[queryIndex];
      ${useSubgroups ? `
      if (fastAllowed) {
        var runningMax = 0.0;
        var denominator = 0.0;
        for (var groupIndex = 0u; groupIndex < count; groupIndex = groupIndex + 1u) {
          let group = workgroupUniformLoad(&groups[groupIndex]);
          let matches = query.w != 0u && query.x == group.x;
          let cacheBase = group.x * CACHE_VECTORS;
          for (var base = group.y; base < group.z; base = base + 16u) {
            if (info.mode != 2u) {
              for (var i = tid; i < 512u; i = i + 256u) {
                let token = base + i / 32u;
                kv[i] = vec4<f32>(0.0);
                if (token < group.z) {
                  kv[i] = kcache[cacheBase + token * 32u + i % 32u];
                }
              }
            }
            workgroupBarrier();

            let token = base + keyIndex;
            let visible = matches && token >= query.z && token < query.y;
            var score = 0.0;
            if (visible && info.mode != 2u) {
              for (var d = dotLane; d < 32u; d = d + 2u) {
                score = score + dot(queries[queryIndex * 32u + d], kv[keyIndex * 32u + d]);
              }
            }
            // Finish every K read before any invocation overwrites the KV tile.
            workgroupBarrier();
            if (info.mode != 1u) {
              for (var i = tid; i < 512u; i = i + 256u) {
                let valueToken = base + i / 32u;
                kv[i] = vec4<f32>(0.0);
                if (valueToken < group.z) {
                  kv[i] = vcache[cacheBase + valueToken * 32u + i % 32u];
                }
              }
            }

            // XOR 1 combines each QK pair. XOR 2/4/8/16 stays within its
            // verified 32-lane query block, even for 64/128-lane subgroups.
            score = score + subgroupShuffleXor(score, 1u);
            var top = select(-3.402823466e+38, score, visible);
            top = max(top, subgroupShuffleXor(top, 2u));
            top = max(top, subgroupShuffleXor(top, 4u));
            top = max(top, subgroupShuffleXor(top, 8u));
            top = max(top, subgroupShuffleXor(top, 16u));
            let hasKeys = matches && max(base, query.z) < min(base + 16u, query.y);
            var oldScale = 1.0;
            var probability = 0.0;
            if (hasKeys) {
              oldScale = 0.0;
              if (denominator != 0.0) {
                top = max(top, runningMax);
                oldScale = exp(runningMax - top);
              }
              if (visible) { probability = exp(score - top); }
            }
            var sum = probability;
            sum = sum + subgroupShuffleXor(sum, 2u);
            sum = sum + subgroupShuffleXor(sum, 4u);
            sum = sum + subgroupShuffleXor(sum, 8u);
            sum = sum + subgroupShuffleXor(sum, 16u);
            if (hasKeys) {
              runningMax = top;
              denominator = denominator * oldScale + sum;
            }
            if (dotLane == 0u) {
              weights[queryIndex * 16u + keyIndex] = probability;
            }
            // Publish both V and probabilities before their cooperative reads.
            workgroupBarrier();
            if (info.mode != 1u) {
              accumulator = accumulator * oldScale;
              for (var j = 0u; j < 16u; j = j + 1u) {
                accumulator = accumulator + weights[queryIndex * 16u + j] * kv[j * 32u + lane];
              }
            }
            workgroupBarrier();
          }
        }
        if (row < info.rows) {
          out[(row * info.heads + wg.x) * 32u + lane] =
            accumulator / max(denominator, 1.0e-20);
        }
        return;
      }
      ` : ""}
        for (var groupIndex = 0u; groupIndex < count; groupIndex = groupIndex + 1u) {
          let group = workgroupUniformLoad(&groups[groupIndex]);
          let matches = query.w != 0u && query.x == group.x;
          let cacheBase = group.x * CACHE_VECTORS;
          for (var base = group.y; base < group.z; base = base + 16u) {
            if (info.mode != 2u) {
              for (var i = tid; i < 512u; i = i + 256u) {
                let token = base + i / 32u;
                kv[i] = vec4<f32>(0.0);
                if (token < group.z) {
                  kv[i] = kcache[cacheBase + token * 32u + i % 32u];
                }
              }
            }
            workgroupBarrier();

            let token = base + keyIndex;
            let visible = matches && token >= query.z && token < query.y;
            var score = 0.0;
            if (visible && info.mode != 2u) {
              for (var d = dotLane; d < 32u; d = d + 2u) {
                score = score + dot(queries[queryIndex * 32u + d], kv[keyIndex * 32u + d]);
              }
            }
            partial[tid] = score;
            workgroupBarrier();

            if (lane < 4u) {
              let firstKey = lane * 4u;
              let firstPartial = queryIndex * 32u + firstKey * 2u;
              var localMax = -3.402823466e+38;
              for (var j = 0u; j < 4u; j = j + 1u) {
                let key = firstKey + j;
                let value = partial[firstPartial + j * 2u] +
                  partial[firstPartial + j * 2u + 1u];
                weights[queryIndex * 16u + key] = value;
                if (matches && base + key >= query.z && base + key < query.y) {
                  localMax = max(localMax, value);
                }
              }
              // Each reducer owns all eight QK partials it overwrites.
              partial[firstPartial] = localMax;
            }
            // All K readers finished before the previous barrier. Reuse the
            // tile for V while the score reductions run in other lanes.
            if (info.mode != 1u) {
              for (var i = tid; i < 512u; i = i + 256u) {
                let valueToken = base + i / 32u;
                kv[i] = vec4<f32>(0.0);
                if (valueToken < group.z) {
                  kv[i] = vcache[cacheBase + valueToken * 32u + i % 32u];
                }
              }
            }
            workgroupBarrier();

            let hasKeys = matches && max(base, query.z) < min(base + 16u, query.y);
            let partialBase = queryIndex * 32u;
            var top = state[queryIndex].x;
            var oldScale = 1.0;
            if (lane < 16u) {
              var probability = 0.0;
              if (hasKeys) {
                top = max(max(partial[partialBase], partial[partialBase + 8u]),
                  max(partial[partialBase + 16u], partial[partialBase + 24u]));
                oldScale = 0.0;
                if (state[queryIndex].y != 0.0) {
                  top = max(top, state[queryIndex].x);
                  oldScale = exp(state[queryIndex].x - top);
                }
                if (base + lane >= query.z && base + lane < query.y) {
                  probability = exp(weights[queryIndex * 16u + lane] - top);
                }
              }
              weights[queryIndex * 16u + lane] = probability;
            }
            // An all-masked tile leaves the running state/output unchanged.
            // Only z is written here; other lanes still read x/y above.
            if (lane == 0u) { state[queryIndex].z = oldScale; }
            workgroupBarrier();

            if (lane == 0u && hasKeys) {
              // Balance the 16-term sum without another workgroup barrier.
              let first = queryIndex * 16u;
              let sum0 = (weights[first] + weights[first + 1u]) +
                (weights[first + 2u] + weights[first + 3u]);
              let sum1 = (weights[first + 4u] + weights[first + 5u]) +
                (weights[first + 6u] + weights[first + 7u]);
              let sum2 = (weights[first + 8u] + weights[first + 9u]) +
                (weights[first + 10u] + weights[first + 11u]);
              let sum3 = (weights[first + 12u] + weights[first + 13u]) +
                (weights[first + 14u] + weights[first + 15u]);
              let sum = (sum0 + sum1) + (sum2 + sum3);
              state[queryIndex].x = top;
              state[queryIndex].y = state[queryIndex].y * oldScale + sum;
            }

            if (info.mode != 1u) {
              accumulator = accumulator * state[queryIndex].z;
              for (var j = 0u; j < 16u; j = j + 1u) {
                accumulator = accumulator + weights[queryIndex * 16u + j] * kv[j * 32u + lane];
              }
            }
            workgroupBarrier();
          }
        }
        if (row < info.rows) {
          let result = accumulator / max(state[queryIndex].y, 1.0e-20);
          out[(row * info.heads + wg.x) * 32u + lane] = result;
        }
      }
    `;
  }

  /**
   * Fuse the one-head K RoPE and both KV cache writes without a K intermediate.
   * Dispatch (1, rows, 1), workgroup_size(64), no shared memory or optional
   * features. cacheStride is maxTokens * 128 f32 elements, not bytes.
   * Bindings: 0 normalised K [rows,128], 1 inverse frequencies [64], 2 K cache,
   * 3 V cache, 4 fused QKV [rows,qkvWidth], 5 positions, 6 cacheRows, 7 RoPE Info.
   * Info matches the original RoPE uniform: {heads,rows,half,scale,stride,start,
   * pad,pad2}, with heads=1 and half=64. stride=0 selects contiguous normalised
   * K; otherwise stride/start select its source in binding 0, as in RoPE.
   * qkvWidth and heads specialize the fused V offset (heads * 128 + 128).
   * Each lane rotates a split-half K pair and copies the corresponding V pair.
   * Each active row must have a unique (cacheRows[row], positions[row]) pair,
   * with valid cache slots; no atomic ordering is defined for duplicates.
   * Encode after K normalisation and before attention in the same stream.
   */
  export function ropeKV(cacheStride: number, qkvWidth: number, heads: number): string {
    return `
      const CACHE_STRIDE: u32 = ${cacheStride}u;
      const MAX_TOKENS: u32 = ${cacheStride / 128}u;
      const QKV_WIDTH: u32 = ${qkvWidth}u;
      const VALUE_OFFSET: u32 = ${heads * 128 + 128}u;
      struct Info {
        heads: u32, rows: u32, half: u32, scale: f32,
        stride: u32, start: u32, pad: u32, pad2: u32
      };
      @group(0) @binding(0) var<storage, read> kN: array<f32>;
      @group(0) @binding(1) var<storage, read> frequencies: array<f32>;
      @group(0) @binding(2) var<storage, read_write> kcache: array<f32>;
      @group(0) @binding(3) var<storage, read_write> vcache: array<f32>;
      @group(0) @binding(4) var<storage, read> qkv: array<f32>;
      @group(0) @binding(5) var<storage, read> positions: array<u32>;
      @group(0) @binding(6) var<storage, read> cacheRows: array<u32>;
      @group(0) @binding(7) var<uniform> info: Info;
      @compute @workgroup_size(64)
      fn main(@builtin(workgroup_id) wg: vec3<u32>,
              @builtin(local_invocation_index) d: u32) {
        let row = wg.y;
        if (wg.x != 0u || row >= info.rows) { return; }
        let position = positions[row];
        if (position >= MAX_TOKENS) { return; }
        var source = row * 128u;
        if (info.stride != 0u) { source = row * info.stride + info.start; }
        let angle = f32(position) * frequencies[d];
        let c = cos(angle);
        let s = sin(angle);
        let low = kN[source + d];
        let high = kN[source + d + info.half];
        let destination = cacheRows[row] * CACHE_STRIDE + position * 128u + d;
        kcache[destination] = (low * c - high * s) * info.scale;
        kcache[destination + info.half] = (high * c + low * s) * info.scale;
        let valueSource = row * QKV_WIDTH + VALUE_OFFSET + d;
        vcache[destination] = qkv[valueSource];
        vcache[destination + info.half] = qkv[valueSource + info.half];
      }
    `;
  }
}
