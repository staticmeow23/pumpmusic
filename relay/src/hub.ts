/**
 * Slotwave relay: many listeners, one upstream Solana WebSocket (Helius).
 *
 * Listeners speak the standard Solana PubSub subset the app already uses
 * (logsSubscribe with one `mentions` address, slotSubscribe and their
 * unsubscribes), so to the app the relay is just another endpoint. The relay
 * keeps exactly one upstream subscription per coin, however many people
 * listen, and drops it when the last listener leaves. Everything else is
 * refused, so the relay can't be used as a general proxy for the API key.
 *
 * No Cloudflare types in here: the Durable Object wraps this class, and the
 * tests drive it with fakes.
 */

export interface ClientPort {
  send(text: string): void;
  close(code: number, reason: string): void;
}

export interface UpstreamPort {
  send(text: string): void;
  close(): void;
}

export interface UpstreamHandlers {
  onOpen(): void;
  onMessage(text: string): void;
  onClose(): void;
}

export interface HubLimits {
  /** Coins one listener may subscribe to (the app allows MAX_COINS). */
  coinsPerClient: number;
  /** Distinct coins the relay serves at once, across all listeners. */
  coins: number;
  /** Listeners at once. */
  clients: number;
  /** Upstream bytes per UTC day; beyond it the relay stops until tomorrow. */
  dailyBytes: number;
  /** Upstream bytes per coin per minute; a busier "coin" (e.g. a program address) is dropped for the day. */
  coinBytesPerMinute: number;
}

export interface HubOptions {
  connect(handlers: UpstreamHandlers): UpstreamPort;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  limits: HubLimits;
  log?(message: string): void;
}

export const DEFAULT_LIMITS: HubLimits = {
  coinsPerClient: 3, // same as MAX_COINS in the app
  coins: 25,
  clients: 200,
  // ~1.5 GB/day ≈ 30k Helius credits/day ≈ 0.9M/month: inside the free plan.
  dailyBytes: 1_500_000_000,
  // 30 MB/min = 500 KB/s, far above a hot pump coin (measured: whole market 2.3 MB/s).
  coinBytesPerMinute: 30_000_000,
};

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const IDLE_CLOSE_MS = 30_000;
const WATCHDOG_MS = 60_000;

interface Coin {
  /** Subscription id the relay hands to every listener of this coin. */
  publicId: number;
  upstreamSub: number | null;
  pending: boolean;
  clients: Set<string>;
  minuteStart: number;
  minuteBytes: number;
}

interface Client {
  port: ClientPort;
  /** mint -> public subscription id */
  coins: Map<string, number>;
  slot: boolean;
}

type Pending = { kind: 'logs'; mint: string } | { kind: 'slot' } | { kind: 'unsubscribe' };

interface RpcRequest {
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export class Hub {
  private readonly clients = new Map<string, Client>();
  private readonly coins = new Map<string, Coin>();
  private readonly bySub = new Map<number, string>(); // upstream sub -> mint, or '' for slots
  private readonly pending = new Map<number, Pending>();
  private readonly blocked = new Set<string>();
  private slot = { publicId: 1, upstreamSub: null as number | null, pending: false, clients: new Set<string>() };
  private nextPublicId = 2;
  private nextRequestId = 1;

  private upstream: UpstreamPort | null = null;
  private upstreamOpen = false;
  private lastUpstreamAt = 0;
  private attempt = 0;
  private retryTimer: unknown = null;
  private idleTimer: unknown = null;
  private watchdog: unknown = null;

  private day = '';
  private dayBytes = 0;

  constructor(private readonly opts: HubOptions) {}

  // ------------------------------------------------------------ listeners

  /** False when the relay is full; the caller then closes the socket. */
  addClient(id: string, port: ClientPort): boolean {
    if (this.clients.size >= this.opts.limits.clients) return false;
    this.clients.set(id, { port, coins: new Map(), slot: false });
    this.cancelIdleClose();
    return true;
  }

  removeClient(id: string): void {
    const c = this.clients.get(id);
    if (!c) return;
    for (const mint of [...c.coins.keys()]) this.leaveCoin(id, mint);
    if (c.slot) this.leaveSlot(id);
    this.clients.delete(id);
    this.scheduleIdleClose();
  }

  clientMessage(id: string, text: string): void {
    const c = this.clients.get(id);
    if (!c) return;
    let req: RpcRequest;
    try {
      req = JSON.parse(text) as RpcRequest;
    } catch {
      return;
    }
    const rid = typeof req.id === 'number' || typeof req.id === 'string' ? req.id : null;
    const reply = (body: object) => c.port.send(JSON.stringify({ jsonrpc: '2.0', id: rid, ...body }));
    const refuse = (message: string, code = -32602) => reply({ error: { code, message } });
    const params = Array.isArray(req.params) ? (req.params as unknown[]) : [];

    switch (req.method) {
      case 'logsSubscribe': {
        const filter = params[0] as { mentions?: unknown } | undefined;
        const mentions = filter && Array.isArray(filter.mentions) ? filter.mentions : null;
        const mint = mentions && mentions.length === 1 && typeof mentions[0] === 'string' ? mentions[0] : null;
        if (!mint || !B58.test(mint)) return refuse('relay: logsSubscribe needs exactly one address in mentions');
        if (this.blocked.has(mint)) return refuse('relay: this address is too busy for the relay today');
        if (this.overBudget()) return refuse('relay: daily data budget used up, back tomorrow (UTC)');
        const existing = c.coins.get(mint);
        if (existing !== undefined) return reply({ result: existing });
        if (c.coins.size >= this.opts.limits.coinsPerClient) return refuse(`relay: at most ${this.opts.limits.coinsPerClient} coins per listener`);
        if (!this.coins.has(mint) && this.coins.size >= this.opts.limits.coins) return refuse('relay: too many coins at once, try again later');
        const coin = this.joinCoin(id, mint);
        c.coins.set(mint, coin.publicId);
        return reply({ result: coin.publicId });
      }
      case 'slotSubscribe': {
        if (this.overBudget()) return refuse('relay: daily data budget used up, back tomorrow (UTC)');
        if (!c.slot) {
          c.slot = true;
          this.slot.clients.add(id);
          this.ensureSlot();
        }
        return reply({ result: this.slot.publicId });
      }
      case 'logsUnsubscribe': {
        const sub = params[0];
        const mint = [...c.coins.entries()].find(([, pid]) => pid === sub)?.[0];
        if (!mint) return reply({ result: false });
        this.leaveCoin(id, mint);
        c.coins.delete(mint);
        return reply({ result: true });
      }
      case 'slotUnsubscribe': {
        if (!c.slot || params[0] !== this.slot.publicId) return reply({ result: false });
        this.leaveSlot(id);
        c.slot = false;
        return reply({ result: true });
      }
      default:
        return refuse('relay: method not allowed', -32601);
    }
  }

  // ---------------------------------------------------------------- coins

  private joinCoin(clientId: string, mint: string): Coin {
    let coin = this.coins.get(mint);
    if (!coin) {
      coin = { publicId: this.nextPublicId++, upstreamSub: null, pending: false, clients: new Set(), minuteStart: this.opts.now(), minuteBytes: 0 };
      this.coins.set(mint, coin);
    }
    coin.clients.add(clientId);
    this.ensureCoin(mint, coin);
    return coin;
  }

  private leaveCoin(clientId: string, mint: string): void {
    const coin = this.coins.get(mint);
    if (!coin) return;
    coin.clients.delete(clientId);
    if (coin.clients.size) return;
    this.dropCoin(mint, coin);
  }

  private dropCoin(mint: string, coin: Coin): void {
    if (coin.upstreamSub !== null) {
      this.request('logsUnsubscribe', [coin.upstreamSub], { kind: 'unsubscribe' });
      this.bySub.delete(coin.upstreamSub);
    }
    this.coins.delete(mint);
  }

  private leaveSlot(clientId: string): void {
    this.slot.clients.delete(clientId);
    if (this.slot.clients.size || this.slot.upstreamSub === null) return;
    this.request('slotUnsubscribe', [this.slot.upstreamSub], { kind: 'unsubscribe' });
    this.bySub.delete(this.slot.upstreamSub);
    this.slot.upstreamSub = null;
  }

  private ensureCoin(mint: string, coin: Coin): void {
    if (!this.upstreamOpen) return this.ensureUpstream();
    if (coin.upstreamSub !== null || coin.pending) return;
    coin.pending = true;
    this.request('logsSubscribe', [{ mentions: [mint] }, { commitment: 'processed' }], { kind: 'logs', mint });
  }

  private ensureSlot(): void {
    if (!this.upstreamOpen) return this.ensureUpstream();
    if (this.slot.upstreamSub !== null || this.slot.pending) return;
    this.slot.pending = true;
    this.request('slotSubscribe', [], { kind: 'slot' });
  }

  private request(method: string, params: unknown[], what: Pending): void {
    if (!this.upstream || !this.upstreamOpen) return;
    const id = this.nextRequestId++;
    this.pending.set(id, what);
    this.upstream.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  }

  // ------------------------------------------------------------- upstream

  private ensureUpstream(): void {
    if (this.upstream || this.retryTimer !== null || this.overBudget()) return;
    this.attempt++;
    const handlers: UpstreamHandlers = {
      onOpen: () => {
        if (this.upstream !== port) return;
        this.upstreamOpen = true;
        this.lastUpstreamAt = this.opts.now();
        // Fresh connection: every subscription has to be made again.
        for (const [mint, coin] of this.coins) {
          coin.upstreamSub = null;
          coin.pending = false;
          this.ensureCoin(mint, coin);
        }
        this.slot.upstreamSub = null;
        this.slot.pending = false;
        if (this.slot.clients.size) this.ensureSlot();
        this.startWatchdog();
      },
      onMessage: (text) => {
        if (this.upstream === port) this.upstreamMessage(text);
      },
      onClose: () => {
        if (this.upstream === port) this.upstreamLost('upstream closed');
      },
    };
    const port = this.opts.connect(handlers);
    this.upstream = port;
  }

  private upstreamLost(reason: string): void {
    this.opts.log?.(`upstream lost: ${reason}`);
    const old = this.upstream;
    this.upstream = null;
    this.upstreamOpen = false;
    this.pending.clear();
    this.bySub.clear();
    this.stopWatchdog();
    try {
      old?.close();
    } catch {
      // already closed
    }
    if (!this.wanted()) return;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.attempt - 1, 5));
    this.retryTimer = this.opts.setTimer(() => {
      this.retryTimer = null;
      if (this.wanted()) this.ensureUpstream();
    }, delay);
  }

  private wanted(): boolean {
    return (this.coins.size > 0 || this.slot.clients.size > 0) && !this.overBudget();
  }

  private upstreamMessage(text: string): void {
    this.lastUpstreamAt = this.opts.now();
    this.countBytes(text.length);
    let msg: { id?: unknown; result?: unknown; error?: unknown; method?: unknown; params?: { subscription?: unknown; result?: unknown } };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }

    if (typeof msg.id === 'number') {
      const what = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (!what || what.kind === 'unsubscribe') return;
      if (typeof msg.result !== 'number') {
        this.opts.log?.(`upstream refused ${what.kind}: ${JSON.stringify(msg.error ?? null)}`);
        if (what.kind === 'logs') {
          this.blocked.add(what.mint); // otherwise every reconnect of the app would ask again
          this.kickCoin(what.mint, 4003, 'relay: upstream refused this coin');
        }
        else this.slot.pending = false;
        return;
      }
      this.attempt = 0; // healthy
      if (what.kind === 'slot') {
        this.slot.pending = false;
        if (!this.slot.clients.size) return this.request('slotUnsubscribe', [msg.result], { kind: 'unsubscribe' });
        this.slot.upstreamSub = msg.result;
        this.bySub.set(msg.result, '');
        return;
      }
      const coin = this.coins.get(what.mint);
      if (!coin) return this.request('logsUnsubscribe', [msg.result], { kind: 'unsubscribe' }); // everyone left meanwhile
      coin.pending = false;
      coin.upstreamSub = msg.result;
      this.bySub.set(msg.result, what.mint);
      return;
    }

    const sub = msg.params?.subscription;
    if (typeof sub !== 'number') return;
    const target = this.bySub.get(sub);
    if (target === undefined) return;

    if (target === '' && msg.method === 'slotNotification') {
      const out = JSON.stringify({ jsonrpc: '2.0', method: 'slotNotification', params: { subscription: this.slot.publicId, result: msg.params!.result } });
      for (const id of this.slot.clients) this.clients.get(id)?.port.send(out);
      return;
    }
    const coin = this.coins.get(target);
    if (!coin || msg.method !== 'logsNotification') return;
    if (this.tooBusy(coin, text.length)) {
      this.blocked.add(target);
      this.kickCoin(target, 4002, 'relay: this address is too busy for the relay');
      return;
    }
    // One serialisation per coin: every listener got the same public subscription id.
    const out = JSON.stringify({ jsonrpc: '2.0', method: 'logsNotification', params: { subscription: coin.publicId, result: msg.params!.result } });
    for (const id of coin.clients) this.clients.get(id)?.port.send(out);
  }

  /** Ends a coin for everyone listening to it; their app reconnects and is told why. */
  private kickCoin(mint: string, code: number, reason: string): void {
    const coin = this.coins.get(mint);
    if (!coin) return;
    const ids = [...coin.clients];
    this.dropCoin(mint, coin);
    for (const id of ids) {
      const c = this.clients.get(id);
      c?.coins.delete(mint);
      c?.port.close(code, reason);
    }
  }

  private tooBusy(coin: Coin, bytes: number): boolean {
    const now = this.opts.now();
    if (now - coin.minuteStart >= 60_000) {
      coin.minuteStart = now;
      coin.minuteBytes = 0;
    }
    coin.minuteBytes += bytes;
    return coin.minuteBytes > this.opts.limits.coinBytesPerMinute;
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    const tick = () => {
      this.watchdog = this.opts.setTimer(tick, WATCHDOG_MS / 2);
      if (this.upstreamOpen && this.opts.now() - this.lastUpstreamAt > WATCHDOG_MS) this.upstreamLost('no data for 60 s');
    };
    this.watchdog = this.opts.setTimer(tick, WATCHDOG_MS / 2);
  }

  private stopWatchdog(): void {
    if (this.watchdog !== null) this.opts.clearTimer(this.watchdog);
    this.watchdog = null;
  }

  /** Nobody connected: close upstream after a grace period (a reload shouldn't flap it). */
  private scheduleIdleClose(): void {
    if (this.clients.size || this.idleTimer !== null) return;
    this.idleTimer = this.opts.setTimer(() => {
      this.idleTimer = null;
      if (this.clients.size) return;
      this.closeUpstream();
    }, IDLE_CLOSE_MS);
  }

  private cancelIdleClose(): void {
    if (this.idleTimer !== null) this.opts.clearTimer(this.idleTimer);
    this.idleTimer = null;
  }

  private closeUpstream(): void {
    const old = this.upstream;
    this.upstream = null;
    this.upstreamOpen = false;
    this.pending.clear();
    this.bySub.clear();
    this.stopWatchdog();
    if (this.retryTimer !== null) this.opts.clearTimer(this.retryTimer);
    this.retryTimer = null;
    old?.close();
  }

  // --------------------------------------------------------------- budget

  private today(): string {
    return new Date(this.opts.now()).toISOString().slice(0, 10);
  }

  private countBytes(n: number): void {
    const day = this.today();
    if (day !== this.day) {
      this.day = day;
      this.dayBytes = 0;
      this.blocked.clear();
    }
    this.dayBytes += n;
    if (this.dayBytes > this.opts.limits.dailyBytes) {
      this.opts.log?.('daily budget used up');
      for (const mint of [...this.coins.keys()]) this.kickCoin(mint, 4001, 'relay: daily data budget used up');
      this.closeUpstream();
    }
  }

  private overBudget(): boolean {
    return this.day === this.today() && this.dayBytes > this.opts.limits.dailyBytes;
  }

  /** For persisting the budget across restarts of the Durable Object. */
  usage(): { day: string; bytes: number } {
    return { day: this.day, bytes: this.dayBytes };
  }

  restoreUsage(u: { day: string; bytes: number }): void {
    if (u.day === this.today()) {
      this.day = u.day;
      this.dayBytes = u.bytes;
    }
  }

  stats(): { clients: number; coins: number; upstream: boolean; dayBytes: number } {
    return { clients: this.clients.size, coins: this.coins.size, upstream: this.upstreamOpen, dayBytes: this.dayBytes };
  }
}
