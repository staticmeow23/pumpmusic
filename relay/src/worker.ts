import { DurableObject } from 'cloudflare:workers';
import { fetchCoinInfo, fetchTokenBalance } from '../../src/stream/coin-info';
import { DEFAULT_LIMITS, Hub, type HubLimits, type UpstreamHandlers, type UpstreamPort } from './hub';
import { TokenHoldings, TokenMeta } from './meta';

export interface Env {
  HUB: DurableObjectNamespace<RelayHub>;
  /** Secret: wss://mainnet.helius-rpc.com/?api-key=... (set with `wrangler secret put HELIUS_WS_URL`). */
  HELIUS_WS_URL: string;
  /** Comma-separated origins allowed to connect, e.g. "https://staticmeow23.github.io". Empty = any. */
  ALLOWED_ORIGINS?: string;
  /** Optional override of the daily upstream byte budget. */
  DAILY_BYTES?: string;
}

/** The secret, forgiving the usual paste slips (spaces, quotes), as the https:// URL Workers fetch. */
function heliusHttp(env: Env): string {
  const raw = (env.HELIUS_WS_URL ?? '').trim().replace(/^["']|["']$/g, '');
  return raw.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
}

/**
 * Entry point: `/ws` (WebSocket), `/token/<mint>` (name and ticker),
 * `/holding/<owner>/<mint>` (a wallet's balance of a coin) and `/health`. Everything goes to the same Durable Object, so there is one
 * upstream connection in total.
 */
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const hub = env.HUB.get(env.HUB.idFromName('hub'));
    const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const origin = req.headers.get('Origin') ?? '';
    if (url.pathname === '/health') return hub.fetch(req);
    if (url.pathname.startsWith('/token/') || url.pathname.startsWith('/holding/')) {
      if (req.method !== 'GET') return new Response('GET only', { status: 405 });
      if (origin && allowed.length && !allowed.includes(origin)) return new Response('Origin not allowed', { status: 403 });
      const res = await hub.fetch(req);
      // The app on GitHub Pages reads this cross-origin.
      const headers = new Headers(res.headers);
      headers.set('Access-Control-Allow-Origin', origin && (!allowed.length || allowed.includes(origin)) ? origin : allowed[0] ?? '*');
      headers.set('Vary', 'Origin');
      return new Response(res.body, { status: res.status, headers });
    }
    if (url.pathname !== '/ws') return new Response('Slotwave relay. Connect a WebSocket to /ws.', { status: 404 });
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket only', { status: 426 });
    if (!env.HELIUS_WS_URL) return new Response('Relay not configured: run `wrangler secret put HELIUS_WS_URL`', { status: 503 });
    // A soft guard: browsers always send Origin, so other websites can't embed the relay.
    if (allowed.length && !allowed.includes(origin)) return new Response('Origin not allowed', { status: 403 });
    return hub.fetch(req);
  },
} satisfies ExportedHandler<Env>;

export class RelayHub extends DurableObject<Env> {
  private readonly hub: Hub;
  private readonly meta: TokenMeta;
  private readonly holdings: TokenHoldings;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.meta = new TokenMeta(
      { get: (k) => ctx.storage.get(k), put: (k, v) => ctx.storage.put(k, v) },
      (mint) => fetchCoinInfo(heliusHttp(env), mint),
      () => Date.now(),
    );
    this.holdings = new TokenHoldings((owner, mint) => fetchTokenBalance(heliusHttp(env), owner, mint), () => Date.now());
    const limits: HubLimits = { ...DEFAULT_LIMITS };
    const daily = Number(env.DAILY_BYTES);
    if (Number.isFinite(daily) && daily > 0) limits.dailyBytes = daily;
    this.hub = new Hub({
      connect: (h) => this.connectUpstream(h),
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      limits,
      log: (m) => console.log(m),
    });
    // The budget survives restarts of this object.
    void ctx.blockConcurrencyWhile(async () => {
      const usage = await ctx.storage.get<{ day: string; bytes: number }>('usage');
      if (usage) this.hub.restoreUsage(usage);
    });
    setInterval(() => void ctx.storage.put('usage', this.hub.usage()), 60_000);
  }

  override async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path === '/health') {
      return Response.json(this.hub.stats(), { headers: { 'cache-control': 'no-store' } });
    }
    if (path.startsWith('/token/')) {
      const r = await this.meta.get(decodeURIComponent(path.slice('/token/'.length)));
      // A coin's ticker never changes: let browsers keep good answers for a day.
      return Response.json(r.body, { status: r.status, headers: { 'cache-control': r.status === 200 ? 'public, max-age=86400' : 'no-store' } });
    }
    if (path.startsWith('/holding/')) {
      const [owner = '', mint = ''] = path.slice('/holding/'.length).split('/');
      const r = await this.holdings.get(owner, mint);
      return Response.json(r.body, { status: r.status, headers: { 'cache-control': 'no-store' } });
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    // No hibernation: the outbound connection to Helius keeps this object awake anyway.
    server.accept();
    const id = crypto.randomUUID();
    const port = {
      send: (text: string) => {
        try {
          server.send(text);
        } catch {
          // listener already gone; its close event cleans up
        }
      },
      close: (code: number, reason: string) => server.close(code, reason),
    };
    if (!this.hub.addClient(id, port)) {
      server.close(4000, 'relay: full, try again later');
    } else {
      server.addEventListener('message', (e) => {
        if (typeof e.data === 'string') this.hub.clientMessage(id, e.data);
      });
      const gone = () => this.hub.removeClient(id);
      server.addEventListener('close', gone);
      server.addEventListener('error', gone);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Outbound WebSocket to Helius: Workers open it with an HTTP upgrade request. */
  private connectUpstream(h: UpstreamHandlers): UpstreamPort {
    let ws: WebSocket | null = null;
    let closed = false;
    const url = heliusHttp(this.env);
    if (!/^https?:\/\//.test(url)) {
      setTimeout(() => h.onClose('HELIUS_WS_URL must look like wss://mainnet.helius-rpc.com/?api-key=…'), 0);
      return { send: () => {}, close: () => {} };
    }
    fetch(url, { headers: { Upgrade: 'websocket' } })
      .then(async (res) => {
        const socket = res.webSocket;
        if (!socket) {
          const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 120);
          throw new Error(`upgrade refused: HTTP ${res.status} ${body}`.trim());
        }
        socket.accept();
        if (closed) return socket.close(1000, 'not needed');
        ws = socket;
        socket.addEventListener('message', (e) => h.onMessage(typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data)));
        socket.addEventListener('close', (e) => h.onClose(`closed by upstream: ${e.code} ${e.reason}`.trim()));
        socket.addEventListener('error', () => h.onClose('upstream socket error'));
        h.onOpen();
      })
      .catch((e: unknown) => {
        h.onClose(`connect failed: ${(e as Error).message}`);
      });
    return {
      send: (text) => ws?.send(text),
      close: () => {
        closed = true;
        try {
          ws?.close(1000, 'relay idle');
        } catch {
          // already closed
        }
      },
    };
  }
}
