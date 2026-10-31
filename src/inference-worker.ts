// Dedicated execution context for the existing on-device host. The bundled
// runtime, model bytes, tokenizer and prompt builders are not replaced.
// No extension APIs or credentials are sent here. OPFS/IndexedDB are read in
// this worker under the same extension origin.
(() => {
  const scope = globalThis as unknown as {
    importScripts: (...urls: string[]) => void;
    location: { href: string };
    postMessage: (value: unknown) => void;
    onmessage: ((event: MessageEvent) => void) | null;
  };
  scope.importScripts('lib/constants.js', 'lib/gemma.js', 'lib/local.js', 'lib/modelstore.js');
  AT.getURL = (path: string): string => new URL(path, scope.location.href).href;
  scope.importScripts('lib/localhost.js');
  scope.onmessage = (event: MessageEvent) => {
    const data = event.data as { id?: unknown; placement?: unknown; message?: AT.Message };
    if (!Number.isSafeInteger(data.id) || !data.message || typeof data.message.type !== 'string') return;
    AT.localhost.install(data.placement === 'background' ? 'background' : 'offscreen',
      (status) => scope.postMessage({ kind: 'status', status }));
    void AT.localhost.handle(data.message).then(
      (reply) => scope.postMessage({ kind: 'reply', id: data.id, reply }),
      (error: unknown) => {
        const failure = error as { message?: unknown; reason?: unknown };
        scope.postMessage({ kind: 'reply', id: data.id, error: {
          message: String(failure?.message ?? error).slice(0, 300),
          reason: typeof failure?.reason === 'string' ? failure.reason : 'generation-failed'
        } });
      }
    );
  };
})();
