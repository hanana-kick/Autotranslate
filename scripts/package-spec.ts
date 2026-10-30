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
 * The MediaPipe runtime, copied out of @mediapipe/tasks-genai by the build.
 * `local.ts` resolves both paths relative to the extension root.
 */
export const RUNTIME_ENTRIES = [
  'vendor/mediapipe/genai_bundle.js',
  'vendor/mediapipe/wasm/genai_wasm_internal.js',
  'vendor/mediapipe/wasm/genai_wasm_internal.wasm',
  'vendor/mediapipe/wasm/genai_wasm_nosimd_internal.js',
  'vendor/mediapipe/wasm/genai_wasm_nosimd_internal.wasm'
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
  'lib/gemma.js',
  'lib/pagecontext.js',
  'lib/targets.js',
  'lib/pipeline.js',
  'lib/rules.js',
  'lib/settings.js',
  'lib/engines.js',
  'lib/dom.js',
  'lib/local.js',
  'lib/modelstore.js',
  'lib/modelflow.js',
  'lib/localhost.js',
  'offscreen.html',
  'offscreen.js',
  'icons/icon-16.png',
  'icons/icon-32.png',
  'icons/icon-48.png',
  'icons/icon-128.png',
  '_locales/en/messages.json',
  '_locales/ko/messages.json',
  ...RUNTIME_ENTRIES
];

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
