import { PROGRAMS, STREAM } from '../config';
import { parseLogs } from '../pump/logs';
import { RecentSet } from './dedupe';
import type { Stream, StreamHandlers } from './types';

type SubKind = 'curve' | 'swap' | 'slot';

/** Request ids for the three subscriptions we open on every connection. */
const REQUESTS: { id: number; kind: SubKind; body: object }[] = [
  {
    id: 1,
    kind: 'curve',
    body: { method: 'logsSubscribe', params: [{ mentions: [PROGRAMS.pumpCurve] }, { commitment: 'processed' }] },
  },
  {
    id: 2,
    kind: 'swap',
    body: { method: 'logsSubscribe', params: [{ mentions: [PROGRAMS.pumpSwap] }, { commitment: 'processed' }] },
  },
  { id: 3, kind: 'slot', body: { method: 'slotSubscribe', params: [] } },
];

/** Hides API keys (e.g. Helius `?api-key=...`) before an endpoint is shown or logged. */
export function maskEndpoint(url: string): string {
  try {
    const u = new URL(url);
    // Some providers put the key in the path (QuickNode), others in the query (Helius).
    const hidden = u.pathname.length > 1 || u.search.length > 0;
    return `${u.protocol}//${u.host}${hidden ? '/••• (key hidden)' : ''}`;
  } catch {
    return 'invalid endpoint';
  }
}

export function isValidWsUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'wss:' || u.protocol === 'ws:';
  } catch {
    return false;
  }
}

interface Notification {
  method?: string;
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
  params?: { subscription?: number; result?: unknown };
}

/**
 * Standard Solana WebSocket client: logsSubscribe on both pump programs plus
 * slotSubscribe. Works with the free public endpoint and with any paid
 * provider that speaks the standard API (Helius, Alchemy, QuickNode, ...).
 */
export class RpcStream implements Stream {
  private socket: WebSocket | null = null;
  /** Incremented per connection so callbacks from an old socket are ignored. */
  private generation = 0;
  private attempt = 0;
  private subs = new Map<number, SubKind>();
  private seen = new RecentSet(STREAM.dedupeSize);
  private lastMessageAt = 0;
  private gotData = false;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private readonly urls: readonly string[];
  /** Which of `urls` is in use; moves on when an endpoint never goes live. */
  private urlIndex = 0;
  private wentLive = false;

  constructor(
    urls: string | readonly string[],
    private readonly handlers: StreamHandlers,
  ) {
    this.urls = typeof urls === 'string' ? [urls] : urls;
  }

  private get url(): string {
    return this.urls[this.urlIndex % this.urls.length] ?? '';
  }

  get label(): string {
    return maskEndpoint(this.url);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.urlIndex = 0;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.retryTimer = null;
    this.watchdog = null;
    const s = this.socket;
    this.socket = null;
    if (s && s.readyState <= WebSocket.OPEN) s.close(1000, 'stopped');
    this.handlers.onState({ kind: 'idle' });
  }

  private connect(): void {
    const gen = ++this.generation;
    this.attempt++;
    this.subs.clear();
    this.gotData = false;
    this.wentLive = false;
    this.handlers.onState({ kind: 'connecting', attempt: this.attempt });

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch (e) {
      this.handlers.onState({ kind: 'error', reason: `Cannot open socket: ${(e as Error).message}` });
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      if (gen !== this.generation) return;
      this.lastMessageAt = performance.now();
      for (const r of REQUESTS) socket.send(JSON.stringify({ jsonrpc: '2.0', id: r.id, ...r.body }));
    };

    socket.onmessage = (msg: MessageEvent) => {
      if (gen !== this.generation) return;
      if (typeof msg.data !== 'string') return;
      this.lastMessageAt = performance.now();
      this.handleFrame(msg.data);
    };

    socket.onerror = () => {
      // Browsers deliberately hide the reason; onclose follows and decides.
    };

    socket.onclose = (ev: CloseEvent) => {
      if (gen !== this.generation || this.stopped) return;
      const reason = ev.reason ? `${ev.code} ${ev.reason}` : `closed (code ${ev.code})`;
      this.scheduleReconnect(reason);
    };

    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {
      if (gen !== this.generation) return;
      if (performance.now() - this.lastMessageAt > STREAM.watchdogMs) {
        this.scheduleReconnect('no data for 20 s');
      }
    }, 2_000);
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped) return;
    const failedAt = new URL(this.url).host;
    const gen = ++this.generation; // invalidates the current socket's callbacks
    const old = this.socket;
    this.socket = null;
    if (old && old.readyState <= WebSocket.OPEN) old.close();
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    // An endpoint that never confirmed both subscriptions may be gone or
    // refusing us: try the next one. One that was live just dropped: retry it.
    if (!this.wentLive && this.urls.length > 1) this.urlIndex++;

    const base = Math.min(STREAM.backoffMaxMs, STREAM.backoffMinMs * 2 ** Math.min(this.attempt - 1, 5));
    const delay = Math.round(base * (0.75 + Math.random() * 0.5));
    this.handlers.onState({ kind: 'waiting', retryInMs: delay, reason: `${failedAt}: ${reason}` });
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (gen === this.generation && !this.stopped) this.connect();
    }, delay);
  }

  private handleFrame(data: string): void {
    let msg: Notification;
    try {
      msg = JSON.parse(data) as Notification;
    } catch {
      this.handlers.onBytes(data.length, 'other');
      return;
    }

    // Subscription confirmations and errors.
    if (typeof msg.id === 'number') {
      this.handlers.onBytes(data.length, 'other');
      const req = REQUESTS.find((r) => r.id === msg.id);
      if (!req) return;
      if (msg.error) {
        const text = msg.error.message ?? `code ${msg.error.code ?? '?'}`;
        if (req.kind === 'slot') return; // optional: the clock also learns from trade slots
        this.handlers.onState({ kind: 'error', reason: `${req.kind} subscription refused: ${text}` });
        this.scheduleReconnect(`subscription refused: ${text}`);
        return;
      }
      if (typeof msg.result === 'number') this.subs.set(msg.result, req.kind);
      const kinds = new Set(this.subs.values());
      if (req.kind !== 'slot' && kinds.has('curve') && kinds.has('swap')) {
        this.wentLive = true;
        this.handlers.onState({ kind: 'live', since: Date.now() });
      }
      return;
    }

    const sub = msg.params?.subscription;
    const kind = typeof sub === 'number' ? this.subs.get(sub) : undefined;
    const now = performance.now();

    if (msg.method === 'slotNotification' && kind === 'slot') {
      this.handlers.onBytes(data.length, 'slot');
      const slot = (msg.params?.result as { slot?: unknown } | undefined)?.slot;
      if (typeof slot === 'number') this.handlers.onSlot(slot, now);
      return;
    }

    if (msg.method === 'logsNotification' && (kind === 'curve' || kind === 'swap')) {
      this.handlers.onBytes(data.length, 'logs');
      const result = msg.params?.result as
        | { context?: { slot?: unknown }; value?: { signature?: unknown; err?: unknown; logs?: unknown } }
        | undefined;
      const slot = result?.context?.slot;
      const value = result?.value;
      if (typeof slot !== 'number' || !value || typeof value.signature !== 'string') return;
      if (!Array.isArray(value.logs)) return;
      if (!this.seen.add(value.signature)) return;
      if (!this.gotData) {
        this.gotData = true;
        this.attempt = 0; // healthy again: next failure starts the backoff from scratch
      }
      const logs = value.logs.filter((l): l is string => typeof l === 'string');
      this.handlers.onTx({ slot, signature: value.signature, receivedAt: now, parsed: parseLogs(logs, value.err) });
      return;
    }

    this.handlers.onBytes(data.length, 'other');
  }
}
