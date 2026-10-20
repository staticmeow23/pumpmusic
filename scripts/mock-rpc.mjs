// A tiny fake Solana WebSocket RPC for offline development and tests.
// It answers logsSubscribe/slotSubscribe and replays the real transaction logs
// in test/fixtures at a pump-like rate, so the full RPC code path runs locally.
//
//   node scripts/mock-rpc.mjs [port] [--drop-after=SECONDS] [--refuse-logs]
//
// Then choose "My own endpoint" in the app and enter ws://127.0.0.1:8899
// No dependencies: the WebSocket handshake and framing are done by hand.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 8899);
const dropAfter = Number((process.argv.find((a) => a.startsWith('--drop-after=')) ?? '=0').split('=')[1]);
const refuseLogs = process.argv.includes('--refuse-logs');

const fixtures = readdirSync(join(root, 'test/fixtures'))
  .filter((f) => f.endsWith('.json') && f !== 'expected.json')
  .map((f) => JSON.parse(readFileSync(join(root, 'test/fixtures', f), 'utf8')));
const SWAP = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
let slot = 455_000_000; // shared by all connections, like the real chain
const fakeSig = () => Array.from(randomBytes(88), (b) => B58[b % 58]).join('');

function frame(text) {
  const payload = Buffer.from(text);
  const len = payload.length;
  const header = len < 126 ? Buffer.from([0x81, len]) : len < 65536 ? Buffer.from([0x81, 126, len >> 8, len & 255]) : Buffer.concat([Buffer.from([0x81, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b; })()]);
  return Buffer.concat([header, payload]);
}

/** Parses complete client frames (always masked) out of `buf`. */
function* readFrames(state) {
  for (;;) {
    const b = state.buf;
    if (b.length < 2) return;
    const opcode = b[0] & 0x0f;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
    if (b.length < off + 4 + len) return;
    const mask = b.subarray(off, off + 4);
    const data = Buffer.from(b.subarray(off + 4, off + 4 + len));
    for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
    state.buf = b.subarray(off + 4 + len);
    yield { opcode, data };
  }
}

const server = createServer((_req, res) => res.writeHead(426).end('WebSocket only'));
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  console.log('client connected');

  const state = { buf: Buffer.alloc(0) };
  const subs = new Map(); // kind -> id
  let nextSub = 100;
  const timers = [];
  const send = (obj) => socket.writable && socket.write(frame(JSON.stringify(obj)));

  timers.push(setInterval(() => {
    slot += Math.random() < 0.03 ? 2 : 1;
    if (subs.has('slot')) send({ jsonrpc: '2.0', method: 'slotNotification', params: { subscription: subs.get('slot'), result: { slot, parent: slot - 1, root: slot - 32 } } });
    const n = Math.random() < 0.5 ? 1 : Math.random() < 0.5 ? 2 : 3;
    for (let i = 0; i < n; i++) {
      const fx = fixtures[Math.floor(Math.random() * fixtures.length)];
      const mentions = fx.logs.some((l) => l.startsWith(`Program ${SWAP} invoke`)) ? 'swap' : 'curve';
      if (!subs.has(mentions)) continue;
      send({ jsonrpc: '2.0', method: 'logsNotification', params: { subscription: subs.get(mentions), result: { context: { slot }, value: { signature: fakeSig(), err: fx.err, logs: fx.logs } } } });
    }
  }, 200));
  if (dropAfter > 0) timers.push(setTimeout(() => { console.log('dropping connection'); socket.destroy(); }, dropAfter * 1000));

  socket.on('data', (chunk) => {
    state.buf = Buffer.concat([state.buf, chunk]);
    for (const { opcode, data } of readFrames(state)) {
      if (opcode === 0x8) { socket.end(); return; }
      if (opcode !== 0x1) continue;
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { continue; }
      if (msg.method === 'logsSubscribe') {
        if (refuseLogs) { send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }); continue; }
        const kind = msg.params?.[0]?.mentions?.[0] === SWAP ? 'swap' : 'curve';
        subs.set(kind, nextSub);
        send({ jsonrpc: '2.0', id: msg.id, result: nextSub++ });
      } else if (msg.method === 'slotSubscribe') {
        subs.set('slot', nextSub);
        send({ jsonrpc: '2.0', id: msg.id, result: nextSub++ });
      }
    }
  });
  const cleanup = () => timers.forEach((t) => { clearInterval(t); clearTimeout(t); });
  socket.on('close', () => { cleanup(); console.log('client disconnected'); });
  socket.on('error', cleanup);
});
server.listen(port, '127.0.0.1', () => console.log(`mock RPC on ws://127.0.0.1:${port}`));
