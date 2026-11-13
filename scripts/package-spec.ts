// The packaging contract, shared by the build, the packaging gate and the
// tests: which targets exist, which files a browser needs to load the
// extension, how the add-on identifies itself on Firefox, and how an archive
// is named. Keep the expectations here so the gate and the producer cannot
// drift apart.

/** Targets the build knows how to emit. `build.ts` must have a table entry per name. */
export const TARGETS = ['chrome', 'firefox'];

/** Firefox requires a stable add-on id; AMO remembers the first one it sees. */
export const GECKO_ID = 'autotranslate@hanana-kick';
export const GECKO_MIN_VERSION = '121.0';

/**
 * The Transformers.js/ONNX Runtime Web runtime for the ONNX model export,
 * pre-converted to classic scripts (no bundler, `module: none`) by
 * `scripts/onnx-vendor.ts` from the installed devDependencies. The wasm files
 * are what onnxruntime-web fetches by path at runtime.
 */
export const ONNX_RUNTIME_ENTRIES = [
  'vendor/onnxruntime/ort-common.all.js',
  'vendor/onnxruntime/ort-webgpu.all.js',
  'vendor/onnxruntime/transformers.web.js',
  'vendor/onnxruntime/ort-wasm-simd-threaded.asyncify.mjs',
  'vendor/onnxruntime/ort-wasm-simd-threaded.asyncify.wasm',
  'vendor/onnxruntime/ort-wasm-simd-threaded.mjs',
  'vendor/onnxruntime/ort-wasm-simd-threaded.wasm',
  'vendor/onnxruntime/ort-wasm-simd-threaded.jsep.mjs',
  'vendor/onnxruntime/ort-wasm-simd-threaded.jsep.wasm'
];

/**
 * Every file a browser needs to load the extension, relative to a bundle root.
 * A missing entry means the bundle cannot start, so the unit tests and the
 * packaging gate both check this list against the emitted tree and the archive.
 */
export const ENTRIES = [
  'manifest.json',
  'background.js',
  'content.js',
  'popup.html',
  'popup.js',
  'options.html',
  'options.js',
  'welcome.html',
  'welcome.js',
  'styles.css',
  'vendor/browser-polyfill.js',
  'lib/constants.js',
  'lib/browser.js',
  'lib/plamo3.js',
  'lib/pagecontext.js',
  'lib/targets.js',
  'lib/pipeline.js',
  'lib/rules.js',
  'lib/settings.js',
  'lib/engines.js',
  'lib/dom.js',
  'lib/translationtext.js',
  'lib/local.js',
  'lib/modelstore.js',
  'lib/modelflow.js',
  'lib/ui.js',
  'lib/pipelinehost.js',
  'lib/onnxweights.js',
  'lib/kernelmatmul.js',
  'lib/kernelattention.js',
  'lib/kernels.js',
  'lib/engine.js',
  'lib/onnxhost.js',
  'hostworker.js',
  ...ONNX_RUNTIME_ENTRIES,
  'offscreen.html',
  'offscreen.js',
  'icons/icon-16.png',
  'icons/icon-32.png',
  'icons/icon-48.png',
  'icons/icon-128.png',
  '_locales/en/messages.json',
  '_locales/ko/messages.json'
];

/** Where a bundle that carries its own weights keeps them, and the manifest
 *  that names them. The download build has neither. */
export const BUNDLED_DIR = 'weights';
export const BUNDLED_MANIFEST = 'weights/manifest.json';

/**
 * Files a bundled build must ship beside the manifest: the graph and every
 * part the manifest names. Read from the built tree, not from a list, because
 * which parts exist is the exporter's decision, not this repository's.
 */
export function bundledEntries(files: string[]): string[] {
  return [BUNDLED_MANIFEST, ...files.map((name) => `${BUNDLED_DIR}/${name}`)];
}

/**
 * Source text with comments removed, for checks that forbid a code pattern but
 * must not trip over prose (`chrome.offscreen` named in an explanation is not
 * a reference). `//` inside a URL is kept, so nothing has to escape links.
 */
export function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/gm, '$1');
}

/** Archive name for a target; `dist/` holds exactly one of these per target. */
export function archiveName(pkg: { name: string; version: string }, target: string): string {
  return `${pkg.name}-${pkg.version}-${target}.zip`;
}
