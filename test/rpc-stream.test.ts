import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { DEFAULT_WS_ENDPOINTS } from '../src/config';
import { RpcStream } from '../src/stream/rpc-stream';
import type { StreamHandlers, StreamState } from '../src/stream/types';

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

function setup(urls: string[]) {
  FakeSocket.opened = [];
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeSocket;
  const states: StreamState[] = [];
  const handlers: StreamHandlers = { onTx() {}, onSlot() {}, onBytes() {}, onState: (s) => states.push(s) };
  return { stream: new RpcStream(urls, handlers), states };
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
