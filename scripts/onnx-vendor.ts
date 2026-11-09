// Builds the ONNX runtime's classic-script vendor files from the installed
// devDependencies (@huggingface/transformers + onnxruntime-web +
// onnxruntime-common), because this project ships no bundler: every source
// file compiles to a classic script on one global `AT` namespace, and the
// vendored runtime has to do the same. The output lands in
// `vendor-src/onnxruntime/`, which `scripts/build.ts` copies into each bundle.
//
// Run with: npm run onnx:vendor
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = path.join(ROOT, 'vendor-src', 'onnxruntime');
const ORT = path.join(ROOT, 'node_modules', 'onnxruntime-web', 'dist');
const COMMON = path.join(ROOT, 'node_modules', 'onnxruntime-common', 'dist', 'esm');
const TF = path.join(ROOT, 'node_modules', '@huggingface', 'transformers', 'dist', 'transformers.web.js');

for (const required of [ORT, COMMON, TF]) {
  if (!fs.existsSync(required)) {
    throw new Error(`missing ${required} - run npm install first`);
  }
}
fs.mkdirSync(OUT, { recursive: true });

/** Removes ESM syntax so the file can run as a classic script. */
const strip = (src: string): string =>
  src
    .replace(/^import[^;]*;\s*$/gm, '')
    .replace(/^export\s+\*\s+from\s*['"][^'"]*['"];?\s*$/gm, '')
    .replace(/^export\s*\{[^}]*\}\s*from\s*['"][^'"]*['"];?\s*$/gm, '')
    .replace(/^export\s*\{[^}]*\};?\s*$/gm, '')
    .replace(/^export\s+(?=(?:async\s+)?(?:function|class|const|let|var))/gm, '')
    .replace(/^export\s+default\s+/gm, '');

// --- ort-common.all.js: the common package as one script, each file in its
// own block scope so no declaration leaks into the page's global lexical
// scope (which the other classic scripts share).
const ORDER = [
  'version.js', 'trace.js', 'env-impl.js', 'env.js', 'tensor-impl.js', 'tensor.js',
  'tensor-conversion.js', 'tensor-factory.js', 'onnx-value.js', 'onnx-model.js',
  'backend-impl.js', 'backend.js', 'inference-session-impl.js', 'inference-session.js',
  'index.js'
];
const parts: string[] = [];
for (const file of ORDER) {
  const p = path.join(COMMON, file);
  if (!fs.existsSync(p)) continue;
  let src = strip(fs.readFileSync(p, 'utf8'));
  // Wrapper modules re-export an impl under a public name; read the impl from
  // the registry instead of the (block-scoped) local binding.
  if (file === 'env.js') src = src.replace('const env = envImpl;', 'const envExport = globalThis.__ort_reg.env;');
  if (file === 'tensor.js') src = src.replace('const Tensor = TensorImpl;', 'const TensorExport = globalThis.__ort_reg.Tensor;');
  if (file === 'inference-session.js') src = src.replace('const InferenceSession = InferenceSessionImpl;', 'const InferenceSessionExport = globalThis.__ort_reg.InferenceSessionImpl;');
  if (file === 'backend.js') src = src.replace('const Backend = BackendImpl;', 'const BackendExport = globalThis.__ort_reg.BackendImpl;');
  const names = [...new Set([...src.matchAll(/(?:^|\n)(?:async\s+)?(?:function|class|const|let|var)\s+(\w+)/g)].map((m) => m[1]))];
  const reg = names.map((n) => `globalThis.__ort_reg[${JSON.stringify(n)}]=${n};`).join(' ');
  parts.push('{\n' + src + '\n' + reg + '\n}');
}
const common =
  'const version = "1.30.0";\nglobalThis.__ort_reg = { version };\n' + parts.join('\n') +
  '\nglobalThis.AT_ORT_COMMON = globalThis.__ort_reg;\n' +
  'globalThis.AT_ORT_COMMON.env = globalThis.__ort_reg.env;\n' +
  'globalThis.AT_ORT_COMMON.Tensor = globalThis.__ort_reg.Tensor;\n' +
  'globalThis.AT_ORT_COMMON.InferenceSession = globalThis.__ort_reg.InferenceSessionImpl;\n';
fs.writeFileSync(path.join(OUT, 'ort-common.all.js'), common);

// --- ort-webgpu.all.js: the webgpu bundle with its export tail converted.
{
  let s = fs.readFileSync(path.join(ORT, 'ort.webgpu.bundle.min.mjs'), 'utf8');
  const m = s.match(/export\s*\{([^}]*)\};/);
  const tail = m?.[1] ?? '';
  if (!m) throw new Error('ort.webgpu.bundle.min.mjs has no export tail to convert');
  const entries = tail
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((n) => (n === 'default' ? 'default: $l' : n.includes(' as ') ? n.split(' as ').map((y) => y.trim()).reverse().join(': ') : n));
  s = s.slice(0, m.index) + 'var AT_ORT_WEBGPU = { ' + entries.join(', ') + ' };\nglobalThis.AT_ORT_WEBGPU = AT_ORT_WEBGPU;\n';
  s = s.replaceAll('import.meta.url', '(globalThis.__ORT_SCRIPT_URL || (globalThis.__ORT_SCRIPT_URL = (typeof document !== "undefined" && document.currentScript && document.currentScript.src) || (typeof location !== "undefined" && location.href) || ""))');
  s = s.replace(/import\.meta\b/g, '(globalThis.__ORT_SCRIPT_META || (globalThis.__ORT_SCRIPT_META = { url: (document.currentScript && document.currentScript.src) || location.href }))');
  s = s.replace(/import_meta_url/g, '_script_url').replace(/import_meta/g, '_scriptmeta');
  fs.writeFileSync(path.join(OUT, 'ort-webgpu.all.js'), s);
}

// --- transformers.web.js: the ESM bundle as a classic-script global.
{
  let s = fs.readFileSync(TF, 'utf8');
  s = s.replace(
    'import * as ONNX_WEB from "onnxruntime-web/webgpu";',
    'const ONNX_WEB = globalThis.AT_ORT_WEBGPU;\nvar ONNX = globalThis.AT_ORT_WEBGPU;'
  );
  s = s.replace(
    'import { Tensor } from "onnxruntime-common";',
    'const ORT_Tensor = globalThis.AT_ORT_COMMON.Tensor;\nvar Tensor = globalThis.AT_ORT_WEBGPU.Tensor;'
  );
  const m = s.match(/export\s*\{([^}]*)\}\s*;?\s*$/s);
  const tail = m?.[1] ?? '';
  const start = m?.index ?? 0;
  if (!m) throw new Error('transformers.web.js has no export tail to convert');
  const names = tail
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((n) => (n.includes(' as ') ? n.split(' as ').map((y) => y.trim()).reverse().join(': ') : n));
  s = s.slice(0, start) + 'var AT_TRANSFORMERS = { ' + names.join(', ') + ' };\nglobalThis.AT_TRANSFORMERS = AT_TRANSFORMERS;\n';
  s = s.replaceAll('import.meta.url', '(globalThis.__TF_SCRIPT_URL || (globalThis.__TF_SCRIPT_URL = (typeof document !== "undefined" && document.currentScript && document.currentScript.src) || (typeof location !== "undefined" && location.href) || ""))');
  s = s.replace(/import\.meta\b/g, '(globalThis.__TF_SCRIPT_META || (globalThis.__TF_SCRIPT_META = { url: (document.currentScript && document.currentScript.src) || location.href }))');
  s = s.replace(/import_meta_url/g, '_script_url').replace(/import_meta/g, '_scriptmeta');
  s = s.replace('  Tensor: Tensor2,', '  Tensor: ORT_Tensor,');
  fs.writeFileSync(path.join(OUT, 'transformers.web.js'), s);
}

// --- the wasm binaries onnxruntime-web fetches by path at runtime.
for (const file of [
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.jsep.wasm'
]) {
  fs.copyFileSync(path.join(ORT, file), path.join(OUT, file));
}

console.log('onnx vendor written to vendor-src/onnxruntime/');
for (const f of fs.readdirSync(OUT)) console.log(' ', f, fs.statSync(path.join(OUT, f)).size);
