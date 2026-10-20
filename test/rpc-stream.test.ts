import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { DEFAULT_WS_ENDPOINTS } from '../src/config';
import { RpcStream } from '../src/stream/rpc-stream';
import type { StreamHandlers, StreamState, StreamTarget, TxMessage } from '../src/stream/types';

/** Minimal stand-in for the browser WebSocket: records every socket the stream opens. */
class FakeSocket {
  static readonly OPEN = 1;
  static opened: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.opened.push(this);
  }
  send(s: string) {
    this.sent.push(s);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  /** Confirms every subscription request with a numeric id, like a real RPC. */
  confirmAll() {
    for (const s of this.sent) {
      const { id } = JSON.parse(s) as { id: number };
      this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id, result: 100 + id }) });
    }
  }
  fail() {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: '' });
  }
}

function setup(urls: string[], target?: StreamTarget) {
  FakeSocket.opened = [];
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeSocket;
  const states: StreamState[] = [];
  const txs: TxMessage[] = [];
  const handlers: StreamHandlers = { onTx: (t) => txs.push(t), onSlot() {}, onBytes() {}, onState: (s) => states.push(s) };
  return { stream: new RpcStream(urls, handlers, target), states, txs };
}

test('the default public endpoint uses the current hostname first', () => {
  assert.equal(DEFAULT_WS_ENDPOINTS[0], 'wss://api.mainnet.solana.com');
});

test('an endpoint that never goes live hands over to the next one', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const { stream, states } = setup(['wss://a.example', 'wss://b.example']);
    stream.start();
    assert.equal(FakeSocket.opened[0]?.url, 'wss://a.example');
    FakeSocket.opened[0]!.fail();
    mock.timers.tick(60_000);
    assert.equal(FakeSocket.opened[1]?.url, 'wss://b.example');
    assert.equal(stream.label, 'wss://b.example');

    const b = FakeSocket.opened[1]!;
    b.open();
    b.confirmAll();
    assert.equal(states.at(-1)?.kind, 'live');

    // A drop after being live retries the same endpoint, which was working.
    b.fail();
    mock.timers.tick(60_000);
    assert.equal(FakeSocket.opened[2]?.url, 'wss://b.example');
    stream.stop();
  } finally {
    mock.timers.reset();
  }
});

test('a single custom endpoint keeps retrying itself', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const { stream } = setup(['wss://mine.example']);
    stream.start();
    FakeSocket.opened[0]!.fail();
    mock.timers.tick(60_000);
    assert.equal(FakeSocket.opened[1]?.url, 'wss://mine.example');
    stream.stop();
  } finally {
    mock.timers.reset();
  }
});

test('failures count up until a connection goes live, then reset', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const { stream, states } = setup(['wss://a.example', 'wss://b.example']);
    const lastWaiting = () => states.filter((s) => s.kind === 'waiting').at(-1) as Extract<StreamState, { kind: 'waiting' }>;
    stream.start();
    for (let i = 0; i < 4; i++) {
      FakeSocket.opened.at(-1)!.fail();
      mock.timers.tick(60_000);
    }
    assert.equal(lastWaiting().failures, 4);

    const s = FakeSocket.opened.at(-1)!;
    s.open();
    s.confirmAll();
    s.fail();
    assert.equal(lastWaiting().failures, 1, 'a drop after being live starts counting again');
    stream.stop();
  } finally {
    mock.timers.reset();
  }
});

test('coin mode: one logs subscription per coin, live once all are confirmed, tx tagged with its coin', () => {
  const a = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
  const b = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
  const { stream, states, txs } = setup(['wss://a.example'], { kind: 'coins', mints: [a, b] });
  stream.start();
  try {
    const s = FakeSocket.opened[0]!;
    s.open();
    const sent = s.sent.map((x) => JSON.parse(x) as { id: number; method: string; params: unknown[] });
    const logs = sent.filter((m) => m.method === 'logsSubscribe');
    assert.deepEqual(logs.map((m) => m.params[0]), [{ mentions: [a] }, { mentions: [b] }]);
    assert.equal(sent.filter((m) => m.method === 'slotSubscribe').length, 1);

    // Only the first coin confirmed: not live yet.
    s.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: logs[0]!.id, result: 501 }) });
    assert.notEqual(states.at(-1)?.kind, 'live');
    s.confirmAll();
    assert.equal(states.at(-1)?.kind, 'live');

    const subB = 100 + logs[1]!.id;
    const note = (sub: number, sig: string) => ({ data: JSON.stringify({ jsonrpc: '2.0', method: 'logsNotification', params: { subscription: sub, result: { context: { slot: 5 }, value: { signature: sig, err: null, logs: [] } } } }) });
    s.onmessage?.(note(subB, 'sig1'));
    s.onmessage?.(note(501, 'sig1')); // the same tx through the other coin's subscription
    assert.equal(txs.length, 1, 'a tx touching two of our coins counts once');
    assert.equal(txs[0]!.mentions, b);
  } finally {
    stream.stop();
  }
});
