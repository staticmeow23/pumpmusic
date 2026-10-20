import { DurableObject } from 'cloudflare:workers';
import { DEFAULT_LIMITS, Hub, type HubLimits, type UpstreamHandlers, type UpstreamPort } from './hub';

export interface Env {
  HUB: DurableObjectNamespace<RelayHub>;
  /** Secret: wss://mainnet.helius-rpc.com/?api-key=... (set with `wrangler secret put HELIUS_WS_URL`). */
  HELIUS_WS_URL: string;
  /** Comma-separated origins allowed to connect, e.g. "https://staticmeow23.github.io". Empty = any. */
  ALLOWED_ORIGINS?: string;
  /** Optional override of the daily upstream byte budget. */
  DAILY_BYTES?: string;
}

/**
 * Entry point. Only `/ws` (WebSocket) and `/health` exist. Every listener goes
 * to the same Durable Object, so there is one upstream connection in total.
 */
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const hub = env.HUB.get(env.HUB.idFromName('hub'));
    if (url.pathname === '/health') return hub.fetch(req);
    if (url.pathname !== '/ws') return new Response('Slotwave relay. Connect a WebSocket to /ws.', { status: 404 });
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket only', { status: 426 });
    if (!env.HELIUS_WS_URL) return new Response('Relay not configured: run `wrangler secret put HELIUS_WS_URL`', { status: 503 });
    // A soft guard: browsers always send Origin, so other websites can't embed the relay.
    const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const origin = req.headers.get('Origin') ?? '';
    if (allowed.length && !allowed.includes(origin)) return new Response('Origin not allowed', { status: 403 });
    return hub.fetch(req);
  },
} satisfies ExportedHandler<Env>;

export class RelayHub extends DurableObject<Env> {
  private readonly hub: Hub;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
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
    if (new URL(req.url).pathname === '/health') {
      return Response.json(this.hub.stats(), { headers: { 'cache-control': 'no-store' } });
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
    const url = this.env.HELIUS_WS_URL.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
    fetch(url, { headers: { Upgrade: 'websocket' } })
      .then((res) => {
        const socket = res.webSocket;
        if (!socket) throw new Error(`upgrade refused: HTTP ${res.status}`);
        socket.accept();
        if (closed) return socket.close(1000, 'not needed');
        ws = socket;
        socket.addEventListener('message', (e) => h.onMessage(typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data)));
        socket.addEventListener('close', () => h.onClose());
        socket.addEventListener('error', () => h.onClose());
        h.onOpen();
      })
      .catch((e: unknown) => {
        console.log(`upstream connect failed: ${(e as Error).message}`);
        h.onClose();
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
