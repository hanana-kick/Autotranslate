// Q4 block128 GEMM sources. Storage stays f32; q4 packs eight low-nibble-first
// values per u32, each decoded as (nibble - 8) * its output/block f32 scale.
// Both entry points use bindings 0=q4, 1=scales, 2=x, 3=y, 4=Info.
// Dispatch ceil(n / tile outputs), ceil(rows / tile rows) for the chosen path.
// K is a multiple of 128, blocks == K / 128.
namespace AT.kernelmatmul {
  export const TILE_ROWS = 32;
  export const TILE_OUTPUTS = 32;
  export const WIDE_TILE_ROWS = 64;
  export const MATRIX_TILE_ROWS = 32;
  export const MATRIX_TILE_OUTPUTS = 64;
  export const PORTABLE_WORKGROUP_SIZE = 64;

  const BINDINGS = `
    struct Info { n: u32, k: u32, blocks: u32, rows: u32 };
    @group(0) @binding(0) var<storage, read> q4: array<u32>;
    @group(0) @binding(1) var<storage, read> scales: array<f32>;
    @group(0) @binding(2) var<storage, read> x: array<f32>;
    @group(0) @binding(3) var<storage, read_write> y: array<f32>;
    @group(0) @binding(4) var<uniform> info: Info;
  `;

  /** Native 32-token x 64-output tile, with full-K f32 matrix accumulation.
   * Four subgroups each own a 16x32 quadrant. Requires f32/f32 8x8x8 matrices,
   * subgroups, and a fixed subgroup size of 32 or 64. Shared storage: 12 KiB.
   * API: https://dawn.googlesource.com/dawn/+/refs/heads/main/docs/dawn/features/subgroup_matrix.md */
  export function matrixGemm(subgroupSize: number): string {
    if (subgroupSize !== 32 && subgroupSize !== 64) {
      throw new Error('Matrix GEMM requires a fixed subgroup size of 32 or 64');
    }
    const workgroupSize = 4 * subgroupSize;
    const accumulators = Array.from({ length: 8 }, (_unused, i) =>
      `var c${i} = Result(0.0);`).join('\n      ');
    const storeMatrices = Array.from({ length: 8 }, (_unused, i) =>
      `subgroupMatrixStore(&ww, (m + ${Math.floor(i / 4) * 8}u) * 64u + n + ${(i % 4) * 8}u, c${i}, false, 64u);`).join('\n      ');
    const multiply = Array.from({ length: 4 }, (_unused, step) => `
        {
          let a0 = subgroupMatrixLoad<Left>(&wx, m * 32u + ${step * 8}u, false, 32u);
          let a1 = subgroupMatrixLoad<Left>(&wx, (m + 8u) * 32u + ${step * 8}u, false, 32u);
          ${Array.from({ length: 4 }, (_unused, column) => `
          {
            let b = subgroupMatrixLoad<Right>(&ww, (n + ${column * 8}u) * 32u + ${step * 8}u, true, 32u);
            c${column} = subgroupMatrixMultiplyAccumulate(a0, b, c${column});
            c${column + 4} = subgroupMatrixMultiplyAccumulate(a1, b, c${column + 4});
          }`).join('')}
        }`).join('');
    return `
    enable subgroups;
    enable chromium_experimental_subgroup_matrix;
    ${BINDINGS}
    alias Left = subgroup_matrix_left<f32, 8, 8>;
    alias Right = subgroup_matrix_right<f32, 8, 8>;
    alias Result = subgroup_matrix_result<f32, 8, 8>;
    var<workgroup> wx: array<f32, 1024>;
    var<workgroup> ww: array<f32, 2048>;
    // Chrome 143 cannot prove subgroup_id-dependent offsets uniform. sg, m/n
    // are constant within each subgroup; all matrix calls follow the uniform
    // info.k loop. Scalar bounds checks reconverge at a workgroup barrier.
    // Scope the diagnostic to matrix uniformity; barrier checks remain enabled.
    @diagnostic(off, chromium.subgroup_matrix_uniformity)
    @compute @workgroup_size(${workgroupSize})
    fn main(@builtin(workgroup_id) wg: vec3<u32>,
            @builtin(local_invocation_index) t: u32,
            @builtin(subgroup_id) sg: u32) {
      let baseM = wg.y * 32u;
      let baseN = wg.x * 64u;
      let m = (sg / 2u) * 16u;
      let n = (sg % 2u) * 32u;
      ${accumulators}
      for (var k = 0u; k < info.k; k += 32u) {
        for (var i = t; i < 1024u; i += ${workgroupSize}u) {
          let row = baseM + i / 32u;
          var value = 0.0;
          if (row < info.rows) { value = x[row * info.k + k + i % 32u]; }
          wx[i] = value;
        }
        for (var i = t; i < 256u; i += ${workgroupSize}u) {
          let output = baseN + i / 4u;
          let column = k + (i % 4u) * 8u;
          var word = 0u;
          var scale = 0.0;
          if (output < info.n) {
            word = q4[output * (info.blocks * 16u) + column / 8u];
            scale = scales[output * info.blocks + column / 128u];
          }
          for (var j = 0u; j < 8u; j++) {
            ww[i * 8u + j] = (f32((word >> (j * 4u)) & 15u) - 8.0) * scale;
          }
        }
        workgroupBarrier();
        ${multiply}
        workgroupBarrier();
      }
      // The dead weight tile becomes output scratch; only global stores need
      // padding guards. Its [output][K] load layout was column-major for B.
      ${storeMatrices}
      workgroupBarrier();
      for (var i = t; i < 2048u; i += ${workgroupSize}u) {
        let row = baseM + i / 64u;
        let output = baseN + i % 64u;
        if (row < info.rows && output < info.n) {
          y[row * info.n + output] = ww[i];
        }
      }
    }
    `;
  }

  /** Portable K64 tile, with a 4-token x 4-output register microtile per
   * invocation. Default: 32x32, 64 invocations, 16 KiB f32 / 8 KiB f16 shared.
   * wideRows=true requires f16: 64x32, 128 invocations, 12 KiB shared. Only
   * the first 64 invocations load weights; all 128 load activations and compute.
   * This doubles weight reuse across tokens without growing register microtiles.
   * Dispatch x uses TILE_OUTPUTS; dispatch y uses WIDE_TILE_ROWS for wideRows,
   * TILE_ROWS otherwise. The runner selects wide rows only above 32 active rows.
   * Four K steps are unrolled, reusing each weight vector across four tokens.
   * No subgroups or experimental features are needed. useF16=true requires
   * shader-f16 and rounds only staged operands; dequantization and accumulation
   * remain f32, with identical ascending-K FMA order for both tile heights.
   * The runner's full-model logits checks bound operand-rounding error.
   * Even f32 may differ from other reductions due to FMA/reassociation. */
  export function portableGemm(useF16: boolean, wideRows = false): string {
    if (wideRows && !useF16) {
      throw new Error('Wide-row portable GEMM requires shader-f16');
    }
    const component = useF16 ? 'f16' : 'f32';
    const tileRows = wideRows ? WIDE_TILE_ROWS : TILE_ROWS;
    const workgroupSize = wideRows ? PORTABLE_WORKGROUP_SIZE * 2 : PORTABLE_WORKGROUP_SIZE;
    const activationVectors = tileRows * 16;
    const multiply = Array.from({ length: 4 }, (_unused, j) => `
          {
            let w = vec4<f32>(ww[(j + ${j}u) * 8u + n]);
            c0 = fma(vec4<f32>(a0[${j}]), w, c0);
            c1 = fma(vec4<f32>(a1[${j}]), w, c1);
            c2 = fma(vec4<f32>(a2[${j}]), w, c2);
            c3 = fma(vec4<f32>(a3[${j}]), w, c3);
          }`).join('');
    const store = Array.from({ length: 4 }, (_unused, r) => `
      if (baseM + m + ${r}u < info.rows) {
        for (var j = 0u; j < 4u; j++) {
          let output = baseN + n * 4u + j;
          if (output < info.n) {
            y[(baseM + m + ${r}u) * info.n + output] = c${r}[j];
          }
        }
      }`).join('');
    return `
    ${useF16 ? 'enable f16;' : ''}
    ${BINDINGS}
    var<workgroup> wx: array<vec4<${component}>, ${activationVectors}>;
    var<workgroup> ww: array<vec4<${component}>, 512>;
    @compute @workgroup_size(${workgroupSize})
    fn main(@builtin(workgroup_id) wg: vec3<u32>,
            @builtin(local_invocation_index) t: u32) {
      let baseM = wg.y * ${tileRows}u;
      let baseN = wg.x * 32u;
      let m = (t / 8u) * 4u;
      let n = t % 8u;
      // Cooperative weight loading uses adjacent lanes for adjacent Q4 words.
      let outputBase = baseN + (t / 8u) * 4u;
      let wordColumn = (t % 8u) * 8u;
      let wordsPerOutput = info.blocks * 16u;
      var c0 = vec4<f32>(0.0);
      var c1 = vec4<f32>(0.0);
      var c2 = vec4<f32>(0.0);
      var c3 = vec4<f32>(0.0);
      for (var k = 0u; k < info.k; k += 64u) {
        // K64 never crosses a block128 boundary. Only 64 invocations load
        // weights, independently of tile height; every staged element has one writer.
        ${wideRows ? 'if (t < 64u)' : ''} {
          var words = vec4<u32>(0u);
          var scale = vec4<f32>(0.0);
          for (var o = 0u; o < 4u; o++) {
            let output = outputBase + o;
            if (output < info.n) {
              words[o] = q4[output * wordsPerOutput + (k + wordColumn) / 8u];
              scale[o] = scales[output * info.blocks + k / 128u];
            }
          }
          for (var j = 0u; j < 8u; j++) {
            let weight = (vec4<f32>((words >> vec4<u32>(j * 4u)) & vec4<u32>(15u)) - vec4<f32>(8.0)) * scale;
            ww[(wordColumn + j) * 8u + t / 8u] = vec4<${component}>(weight);
          }
        }
        for (var i = t; i < ${activationVectors}u; i += ${workgroupSize}u) {
          let row = baseM + i / 16u;
          let at = row * info.k + k + (i % 16u) * 4u;
          var value = vec4<f32>(0.0);
          if (row < info.rows) {
            value = vec4<f32>(x[at], x[at + 1u], x[at + 2u], x[at + 3u]);
          }
          wx[i] = vec4<${component}>(value);
        }
        workgroupBarrier();
        for (var j = 0u; j < 64u; j += 4u) {
          let a0 = vec4<f32>(wx[m * 16u + j / 4u]);
          let a1 = vec4<f32>(wx[(m + 1u) * 16u + j / 4u]);
          let a2 = vec4<f32>(wx[(m + 2u) * 16u + j / 4u]);
          let a3 = vec4<f32>(wx[(m + 3u) * 16u + j / 4u]);
          ${multiply}
        }
        workgroupBarrier();
      }
      ${store}
    }
    `;
  }
}
