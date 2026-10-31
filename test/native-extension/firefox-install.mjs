// Firefox's documented Remote Debugging Protocol is used only to install the
// packaged add-on, just as web-ext does. No extension or model API is replaced.
import { createServer, createConnection } from 'node:net';
export async function unusedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
export async function installFirefoxAddon(port, addonPath) {
  let socket;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      socket = await new Promise((resolve, reject) => {
        const candidate = createConnection({ host: '127.0.0.1', port });
        candidate.once('connect', () => resolve(candidate));
        candidate.once('error', (error) => { candidate.destroy(); reject(error); });
      }); break;
    } catch (error) {
      if (attempt === 99) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  let buffer = Buffer.alloc(0); const packets = [], pending = [];
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const colon = buffer.indexOf(':'); if (colon < 0) return;
      const size = Number(buffer.subarray(0, colon).toString());
      if (!Number.isSafeInteger(size) || size < 0 || size > 10_000_000) { socket.destroy(new Error('invalid RDP frame')); return; }
      if (buffer.length < colon + 1 + size) return;
      const packet = JSON.parse(buffer.subarray(colon + 1, colon + 1 + size));
      buffer = buffer.subarray(colon + 1 + size);
      const waiter = pending.shift(); if (waiter) waiter(packet); else packets.push(packet);
    }
  });
  const next = () => packets.length ? Promise.resolve(packets.shift()) : new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Firefox RDP response timeout')), 15000);
    pending.push((packet) => { clearTimeout(timer); resolve(packet); });
  });
  async function request(to, type, args = {}) {
    const data = Buffer.from(JSON.stringify({ to, type, ...args }));
    socket.write(Buffer.concat([Buffer.from(data.length + ':'), data]));
    for (;;) {
      const response = await next(); if (response.from !== to) continue;
      if (response.error) throw new Error('Firefox add-on installation: ' + response.error + ': ' + response.message);
      return response;
    }
  }
  try {
    const root = await request('root', 'getRoot');
    // Some versions deliver the initial greeting before the getRoot response.
    const resolved = root.addonsActor ? root : await next();
    if (!resolved.addonsActor) throw new Error('Firefox has no temporary add-on actor');
    return await request(resolved.addonsActor, 'installTemporaryAddon', { addonPath, openDevTools: false });
  } finally { socket.destroy(); }
}
