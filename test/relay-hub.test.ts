import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_LIMITS, Hub, maskSecrets, type HubLimits, type UpstreamHandlers } from '../relay/src/hub';

const A = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
const B = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

interface Sent { id?: number; method?: string; params?: unknown[]; result?: unknown; error?: { message: string } }

/** A hub wired to fakes: one upstream socket at a time, manual clock and timers. */
function rig(limits: Partial<HubLimits> = {}) {
  let now = Date.UTC(2026, 9, 20, 12);
  const timers: { at: number; fn: () => void }[] = [];
  const upstreams: { sent: Sent[]; closed: boolean; h: UpstreamHandlers }[] = [];
  const hub = new Hub({
    connect: (h) => {
      const u = { sent: [] as Sent[], closed: false, h };
      upstreams.push(u);
      return { send: (t) => u.sent.push(JSON.parse(t) as Sent), close: () => (u.closed = true) };
    },
    now: () => now,
    setTimer: (fn, ms) => {
      const t = { at: now + ms, fn };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      const i = timers.indexOf(h as (typeof timers)[number]);
      if (i >= 0) timers.splice(i, 1);
    },
    limits: { ...DEFAULT_LIMITS, ...limits },
  });
  const advance = (ms: number) => {
    now += ms;
    for (let t = timers.find((x) => x.at <= now); t; t = timers.find((x) => x.at <= now)) {
      timers.splice(timers.indexOf(t), 1);
      t.fn();
    }
  };
  const client = (id: string) => {
    const got: Sent[] = [];
    const closed: { code: number; reason: string }[] = [];
    hub.addClient(id, { send: (t) => got.push(JSON.parse(t) as Sent), close: (code, reason) => closed.push({ code, reason }) });
    let rid = 1;
    const ask = (method: string, params: unknown[]) => {
      hub.clientMessage(id, JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }));
      const reply = got.find((m) => m.id === rid);
      rid++;
      return reply!;
    };
    return { got, closed, ask, sub: (mint: string) => ask('logsSubscribe', [{ mentions: [mint] }, { commitment: 'processed' }]) };
  };
  /** Upstream confirms every pending subscribe with ids 1000, 1001, ... */
  let nextSub = 1000;
  const confirm = () => {
    const u = upstreams.at(-1)!;
    for (const m of u.sent.filter((x) => x.method?.endsWith('Subscribe') && !(x as { done?: boolean }).done)) {
      (m as { done?: boolean }).done = true;
      u.h.onMessage(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: nextSub++ }));
    }
  };
  const notify = (sub: number, sig = 'sig') =>
    upstreams.at(-1)!.h.onMessage(JSON.stringify({ jsonrpc: '2.0', method: 'logsNotification', params: { subscription: sub, result: { context: { slot: 1 }, value: { signature: sig, err: null, logs: ['x'] } } } }));
  return { hub, upstreams, client, confirm, notify, advance };
}

test('two listeners of one coin share one upstream subscription', () => {
  const r = rig();
  const c1 = r.client('c1');
  const c2 = r.client('c2');
  const s1 = c1.sub(A);
  assert.equal(r.upstreams.length, 1, 'first subscription opens the upstream');
  r.upstreams[0]!.h.onOpen();
  const s2 = c2.sub(A);
  assert.equal(s1.result, s2.result, 'same public id for everyone');
  assert.equal(r.upstreams[0]!.sent.filter((m) => m.method === 'logsSubscribe').length, 1);
  r.confirm();
  r.notify(1000);
  const n1 = c1.got.filter((m) => m.method === 'logsNotification');
  const n2 = c2.got.filter((m) => m.method === 'logsNotification');
  assert.equal(n1.length, 1);
  assert.equal(n2.length, 1);
  assert.equal((n1[0]!.params as unknown as { subscription: number }).subscription, s1.result, 'rewritten to the public id');
});

test('the last listener leaving ends the upstream subscription, no listeners closes upstream', () => {
  const r = rig();
  const c1 = r.client('c1');
  c1.sub(A);
  r.upstreams[0]!.h.onOpen();
  r.confirm();
  r.hub.removeClient('c1');
  assert.deepEqual(r.upstreams[0]!.sent.at(-1)?.method, 'logsUnsubscribe');
  assert.equal(r.upstreams[0]!.closed, false, 'grace period before closing');
  r.advance(31_000);
  assert.equal(r.upstreams[0]!.closed, true);
});

test('only the PubSub subset is allowed; one address per subscription; coin limits', () => {
  const r = rig({ coinsPerClient: 2, coins: 3 });
  const c = r.client('c');
  assert.match(c.ask('getBalance', [A]).error!.message, /not allowed/);
  assert.match(c.ask('logsSubscribe', ['all']).error!.message, /exactly one address/);
  assert.match(c.ask('logsSubscribe', [{ mentions: [A, B] }]).error!.message, /exactly one address/);
  assert.match(c.ask('logsSubscribe', [{ mentions: ['not base58!'] }]).error!.message, /exactly one address/);
  c.sub(A);
  c.sub(B);
  assert.match(c.sub('So11111111111111111111111111111111111111112').error!.message, /at most 2 coins/);
  const d = r.client('d');
  d.sub('JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN');
  assert.match(d.sub('So11111111111111111111111111111111111111112').error!.message, /too many coins/);
});

test('upstream drops: reconnect with backoff and subscribe everything again', () => {
  const r = rig();
  const c = r.client('c');
  c.sub(A);
  c.ask('slotSubscribe', []);
  r.upstreams[0]!.h.onOpen();
  r.confirm();
  r.upstreams[0]!.h.onClose();
  assert.equal(r.upstreams.length, 1, 'waits before reconnecting');
  r.advance(1_500);
  assert.equal(r.upstreams.length, 2);
  r.upstreams[1]!.h.onOpen();
  const methods = r.upstreams[1]!.sent.map((m) => m.method).sort();
  assert.deepEqual(methods, ['logsSubscribe', 'slotSubscribe']);
  r.confirm();
  r.notify(1002);
  assert.equal(c.got.filter((m) => m.method === 'logsNotification').length, 1, 'notifications flow again');
});

test('a "coin" that floods the relay is dropped for the day', () => {
  const r = rig({ coinBytesPerMinute: 2_000 });
  const c = r.client('c');
  c.sub(A);
  r.upstreams[0]!.h.onOpen();
  r.confirm();
  for (let i = 0; i < 20; i++) r.notify(1000, `s${i}`);
  assert.equal(c.closed[0]?.code, 4002);
  assert.match(c.sub(A).error!.message, /too busy/);
});

test('the daily budget stops the relay until the next UTC day', () => {
  const r = rig({ dailyBytes: 1_000 });
  const c = r.client('c');
  c.sub(A);
  r.upstreams[0]!.h.onOpen();
  r.confirm();
  for (let i = 0; i < 20; i++) r.notify(1000, `s${i}`);
  assert.equal(c.closed[0]?.code, 4001);
  assert.equal(r.upstreams[0]!.closed, true);
  assert.match(c.sub(B).error!.message, /budget/);
  r.advance(24 * 3_600_000);
  r.hub.restoreUsage({ day: '2026-10-21', bytes: 0 });
  assert.equal(typeof c.sub(B).result, 'number', 'a new day, a new budget');
});

test('health shows why the upstream failed, without leaking the API key', () => {
  const r = rig();
  const c = r.client('c');
  c.sub(A);
  r.upstreams[0]!.h.onClose('connect failed: upgrade refused: HTTP 401 for https://mainnet.helius-rpc.com/?api-key=SECRET-KEY-123');
  const s = r.hub.stats();
  assert.match(s.lastError ?? '', /HTTP 401/);
  assert.ok(!(s.lastError ?? '').includes('SECRET-KEY-123'), s.lastError ?? '');
  assert.equal(s.attempts, 1);
  r.advance(1_500);
  r.upstreams[1]!.h.onOpen();
  r.confirm();
  assert.equal(r.hub.stats().lastError, 'connect failed: upgrade refused: HTTP 401 for https://mainnet.helius-rpc.com/?api-key=•••', 'kept for diagnosis');
});

test('masking hides keys in queries and long path tokens', () => {
  assert.equal(maskSecrets('wss://x.quiknode.pro/abcdefghijklmnopqrstuvwxyz012345/ failed'), 'wss://x.quiknode.pro/•••/ failed');
  assert.equal(maskSecrets('https://h.example/?api-key=K1&x=2'), 'https://h.example/?api-key=•••&x=•••');
});
