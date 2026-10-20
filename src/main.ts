import { CHANNELS, DEFAULT_GAINS, MusicEngine, type Channel, type VisualNote } from './audio/engine';
import { COIN_COLORS, DEFAULT_WS_ENDPOINTS, FEED, HELIUS_CREDITS_PER_100KB, HELIUS_FREE_MONTHLY_CREDITS, MAX_COINS, MUSIC } from './config';
import { CoinDemoStream } from './stream/coin-demo';
import { fetchCoinInfo, heliusHttpUrl } from './stream/coin-info';
import { DemoStream } from './stream/demo-stream';
import { RpcStream, isValidWsUrl, maskEndpoint } from './stream/rpc-stream';
import type { Stream, StreamState, StreamTarget, TxMessage } from './stream/types';
import { CoinTracker, formatChange, formatMarketCap } from './ui/coin-stats';
import { feedLine, type FeedLine } from './ui/feed';
import { coinsFromHash, hashForCoin, hashForCoins, parseCoinList } from './ui/focus';
import { RateWindow, estimateCost, formatBytes, formatCompact } from './ui/metrics';
import { Renderer } from './viz/renderer';

// ------------------------------------------------------------------ settings

type Source = 'public' | 'custom' | 'demo';
interface Settings {
  source: Source;
  endpoint: string | null; // only stored when the user ticks "remember"
  gains: Record<Channel, number>;
  master: number;
  delay: number;
  lastCoins: string[];
}
const STORAGE_KEY = 'slotwave.settings.v1';

function loadSettings(): Settings {
  const fallback: Settings = { source: 'public', endpoint: null, gains: { ...DEFAULT_GAINS }, master: 0.9, delay: MUSIC.defaultDelayMs, lastCoins: [] };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const s = JSON.parse(raw) as Partial<Settings>;
    const gains = { ...DEFAULT_GAINS };
    for (const ch of CHANNELS) {
      const v = s.gains?.[ch];
      if (typeof v === 'number' && v >= 0 && v <= 1.5) gains[ch] = v;
    }
    return {
      source: s.source === 'custom' || s.source === 'demo' ? s.source : 'public',
      endpoint: typeof s.endpoint === 'string' && isValidWsUrl(s.endpoint) ? s.endpoint : null,
      gains,
      master: typeof s.master === 'number' ? Math.min(1.2, Math.max(0, s.master)) : fallback.master,
      delay: typeof s.delay === 'number' ? s.delay : fallback.delay,
      lastCoins: Array.isArray(s.lastCoins) ? parseCoinList(s.lastCoins.filter((x) => typeof x === 'string').join(' ')).mints : [],
    };
  } catch {
    return fallback;
  }
}

function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // Private mode or storage disabled: settings just won't persist.
  }
}

// ----------------------------------------------------------------------- DOM

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
}
const text = (id: string, value: string) => {
  $(id).textContent = value;
};

const settings = loadSettings();
const engine = new MusicEngine();
engine.setDelay(settings.delay);
for (const ch of CHANNELS) engine.setGain(ch, settings.gains[ch]);

const canvas = $<HTMLCanvasElement>('stage');
let activity = 0;
const renderer = new Renderer(canvas, () => ({ mode: engine.stats().mode, activity }));
engine.onVisual = (n) => {
  renderer.push(n);
  const line = feedLine(n, engine.focused !== null, engine.coinMode);
  // The log line appears when the note sounds, not when the data arrives.
  if (line) setTimeout(() => addFeedLine(line), Math.max(0, n.at - performance.now()));
};
engine.onSlotMark = (m) => renderer.slot(m);
engine.onCoinTrade = (ev, mint) => trackers.get(mint)?.add(ev, performance.now());

// -------------------------------------------------------------------- metrics

const rates = {
  curveBuys: new RateWindow(),
  curveSells: new RateWindow(),
  swap: new RateWindow(),
  creates: new RateWindow(),
  failed: new RateWindow(),
  bytes: new RateWindow(),
};
let graduations = 0;
/** Figures per coin being listened to (coin mode only), in the order entered. */
let trackers = new Map<string, CoinTracker>();
const decoder = { fallback: 0, foreign: 0, malformed: 0 };

function onTx(tx: TxMessage): void {
  const now = tx.receivedAt;
  const p = tx.parsed;
  if (p.failed) rates.failed.add(1, now);
  decoder.fallback += p.fallbackTrades;
  decoder.foreign += p.foreignData;
  decoder.malformed += p.malformed;
  for (const ev of p.events) {
    if (ev.kind === 'trade') {
      if (ev.venue === 'swap') rates.swap.add(1, now);
      else if (ev.side === 'buy') rates.curveBuys.add(1, now);
      else rates.curveSells.add(1, now);
    } else if (ev.kind === 'create') rates.creates.add(1, now);
    else if (ev.kind === 'migrate') {
      graduations++;
      trackers.get(ev.mint)?.markGraduated();
    }
  }
  engine.handleTx(tx);
}

function renderStats(): void {
  const now = performance.now();
  const cb = rates.curveBuys.perSecond(now);
  const cs = rates.curveSells.perSecond(now);
  const sw = rates.swap.perSecond(now);
  const total = cb + cs + sw;
  activity = Math.min(1, total / MUSIC.marketActivityRef);
  if (trackers.size) renderCoins(now);
  text('s-trades', total.toFixed(1));
  text('s-cbuys', cb.toFixed(1));
  text('s-csells', cs.toFixed(1));
  text('s-swap', sw.toFixed(1));
  text('s-creates', (rates.creates.perSecond(now) * 60).toFixed(1));
  text('s-grads', String(graduations));
  text('s-failed', rates.failed.perSecond(now).toFixed(1));

  const st = engine.stats();
  text('s-key', `${st.root} · ${st.mode}`);
  $('s-mood').style.left = `${((st.mood + 1) / 2) * 100}%`;
  text('s-slotms', st.slotMs.toFixed(0));
  text('s-slotfeed', st.slotFeed || !engine.running ? '' : 'no slot feed');
  text('s-notes', formatCompact(st.notes));
  text('s-merged', formatCompact(st.merged));
  const latePct = st.notes ? (st.late / st.notes) * 100 : 0;
  text('s-late', `${latePct.toFixed(1)} %`);
  text('s-late-hint', latePct > 5 ? 'raise buffer' : '');

  const bps = rates.bytes.perSecond(now);
  const cost = estimateCost(bps);
  text('s-rate', formatBytes(bps));
  text('s-rate-note', stream instanceof DemoStream ? 'simulated' : '');
  text('s-day', `${cost.gbPerDay.toFixed(2)} GB`);
  text('s-credits', formatCompact(cost.heliusCreditsPerMonth));
  // How long the Helius free plan lasts at this rate is easier to judge than a share of credits.
  const creditsPerHour = ((bps * 3_600) / 100_000) * HELIUS_CREDITS_PER_100KB;
  text('s-free', creditsPerHour > 0 ? formatCompact(HELIUS_FREE_MONTHLY_CREDITS / creditsPerHour) : '–');
  text('s-decoder', `fallback ${decoder.fallback} · foreign ${decoder.foreign} · bad ${decoder.malformed}`);
  refreshFocusName();
}

const coinColor = (i: number) => `rgb(${COIN_COLORS[i % COIN_COLORS.length]})`;
const coinName = (mint: string) => {
  const sym = engine.symbolOf(mint);
  return sym ? `$${sym}` : shortAddress(mint);
};

/** One block per coin in the stats panel; built once, filled every refresh. */
function buildCoinRows(mints: readonly string[]): void {
  const rows = mints.map((mint, i) => {
    const row = document.createElement('div');
    row.className = 'coin-row';
    row.dataset.mint = mint;
    const name = document.createElement('div');
    name.className = 'coin-name';
    const dot = document.createElement('span');
    dot.className = 'coin-dot';
    dot.style.background = coinColor(i);
    const link = document.createElement('a');
    link.href = `https://pump.fun/coin/${mint}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.className = 'c-name';
    name.append(dot, link);
    const dl = document.createElement('dl');
    for (const [label, cls] of [['Market cap', 'c-mcap'], ['Change', 'c-change change'], ['Bonding curve', 'c-progress'], ['Buys · sells', 'c-trades']] as const) {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.className = cls;
      dd.textContent = '–';
      dl.append(dt, dd);
    }
    row.append(name, dl);
    return row;
  });
  $('coin-rows').replaceChildren(...rows);
}

function renderCoins(now: number): void {
  let tradesPerMin = 0;
  for (const row of $('coin-rows').children) {
    const el = row as HTMLElement;
    const mint = el.dataset.mint!;
    const c = trackers.get(mint)?.snapshot(now);
    if (!c) continue;
    tradesPerMin += c.buysPerMin + c.sellsPerMin;
    const set = (cls: string, value: string) => {
      const target = el.querySelector(`.${cls}`);
      if (target) target.textContent = value;
    };
    set('c-name', coinName(mint));
    set('c-mcap', formatMarketCap(c.marketCap, c.quote));
    set('c-change', formatChange(c.change));
    (el.querySelector('.c-change') as HTMLElement).dataset.dir = c.change === null ? '' : c.change >= 0 ? 'up' : 'down';
    set('c-progress', c.graduated ? 'graduated' : c.progress === null ? '–' : `${(c.progress * 100).toFixed(1)} %`);
    set('c-trades', `${c.buysPerMin} · ${c.sellsPerMin}/min`);
  }
  activity = Math.min(1, tradesPerMin / 60 / (MUSIC.coin.activityRef * trackers.size));
}

// ----------------------------------------------------------------------- feed

function addFeedLine(line: FeedLine): void {
  if (!engine.running) return;
  const list = $('feed');
  const li = document.createElement('li');
  li.className = line.tone;
  const dot = document.createElement('span');
  dot.className = 'dot';
  let label: HTMLElement;
  if (line.link) {
    // Links are only ever built from validated base58 strings (see engine).
    const a = document.createElement('a');
    a.href = line.link;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    label = a;
  } else {
    label = document.createElement('span');
  }
  label.textContent = line.text;
  li.append(dot, label);
  list.prepend(li);
  while (list.children.length > FEED.maxItems) list.lastElementChild?.remove();
}

// ---------------------------------------------------------------------- focus

const shortAddress = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

/** Hear one coin only (the token zoom level); null brings back the whole market. */
function setFocus(coin: string | null, link: string | null): void {
  engine.setFocus(coin);
  $('focusbar').hidden = coin === null;
  const a = $<HTMLAnchorElement>('focus-link');
  a.hidden = !link;
  if (link) a.href = link;
  $('feed').replaceChildren();
  refreshFocusName();
  try {
    history.replaceState(null, '', coin ? hashForCoin(coin) : location.pathname + location.search);
  } catch {
    // Some embedded or file:// contexts refuse history changes; the focus still works.
  }
}

/** Tickers often arrive later (with a create event or a metadata lookup). */
function refreshFocusName(): void {
  if (engine.coinMode) {
    for (const chip of $('focus-name').querySelectorAll<HTMLElement>('.chip')) {
      const label = chip.querySelector('.chip-name');
      if (label) label.textContent = coinName(chip.dataset.mint!);
    }
    return;
  }
  const coin = engine.focused;
  if (coin) text('focus-name', coinName(coin));
}

function onBubbleClick(note: VisualNote): void {
  if (!engine.coinMode && note.coin && note.coin !== engine.focused) setFocus(note.coin, note.link);
  else if (note.link) window.open(note.link, '_blank', 'noopener,noreferrer');
}

/** Coin mode: the bar shows each coin in its colour (linked to pump.fun) and leads back to the address field. */
function showCoinBar(mints: readonly string[]): void {
  $('focusbar').hidden = false;
  $<HTMLAnchorElement>('focus-link').hidden = true;
  text('focus-label', 'Listening to');
  const chips = document.createElement('span');
  chips.className = 'chips';
  mints.forEach((mint, i) => {
    const a = document.createElement('a');
    a.className = 'chip';
    a.dataset.mint = mint;
    a.href = `https://pump.fun/coin/${mint}`;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    const dot = document.createElement('span');
    dot.className = 'coin-dot';
    dot.style.background = coinColor(i);
    const name = document.createElement('span');
    name.className = 'chip-name';
    a.append(dot, name);
    chips.append(a);
  });
  $('focus-name').replaceChildren(chips);
  $('focus-exit').textContent = mints.length > 1 ? 'Change coins' : 'Change coin';
  $('focus-exit').title = 'Back to the address field';
  refreshFocusName();
  try {
    history.replaceState(null, '', hashForCoins(mints));
  } catch {
    // file:// or embedded: the coins still play, only the link can't be shared.
  }
}

// --------------------------------------------------------------------- status

function showState(state: StreamState, label: string): void {
  const pill = $('status');
  pill.dataset.state = state.kind;
  const msg =
    state.kind === 'live' ? `Live · ${label}`
    : state.kind === 'connecting' ? `Connecting${state.attempt > 1 ? ` (try ${state.attempt})` : ''} · ${label}`
    : state.kind === 'waiting' ? `Reconnecting in ${Math.ceil(state.retryInMs / 1_000)} s · ${state.reason}`
    : state.kind === 'error' ? `Error · ${state.reason}`
    : 'Not connected';
  text('status-text', msg);
  pill.title = msg;
  if (state.kind === 'error') toast(state.reason);
  // Retrying forever in silence helps nobody: after a few refusals, offer a way out.
  if (state.kind === 'live' || state.kind === 'idle') $('rpc-help').hidden = true;
  else if (state.kind === 'waiting' && state.failures >= HELP_AFTER_FAILURES && settings.source === 'public') $('rpc-help').hidden = false;
}
const HELP_AFTER_FAILURES = 4;

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function toast(message: string): void {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 6_000);
}

// ---------------------------------------------------------------- start/stop

let stream: Stream | null = null;
const handlers = {
  onTx,
  onSlot: (slot: number, at: number) => engine.handleSlot(slot, at),
  onState: (s: StreamState) => showState(s, stream?.label ?? ''),
  onBytes: (n: number) => rates.bytes.add(n, performance.now()),
};
let statsTimer: ReturnType<typeof setInterval> | null = null;

function selectedSource(): Source {
  const el = document.querySelector<HTMLInputElement>('input[name="source"]:checked');
  return (el?.value as Source | undefined) ?? 'public';
}

async function start(mode: 'coin' | 'market' = 'coin'): Promise<void> {
  const source = selectedSource();
  const errorEl = $('source-error');
  errorEl.hidden = true;
  const caError = $('ca-error');
  caError.hidden = true;

  let target: StreamTarget = { kind: 'market' };
  if (mode === 'coin') {
    const list = parseCoinList($<HTMLTextAreaElement>('ca').value);
    const problem =
      list.invalid.length ? `Not a contract address: ${list.invalid.join(', ')}`
      : !list.mints.length ? 'Paste a contract address (CA) or a pump.fun link. Or explore the whole market below.'
      : null;
    if (problem) {
      caError.textContent = problem;
      caError.hidden = false;
      $('ca').focus();
      return;
    }
    if (list.dropped) toast(`Up to ${MAX_COINS} coins at once: listening to the first ${MAX_COINS}.`);
    target = { kind: 'coins', mints: list.mints };
    settings.lastCoins = list.mints;
  }

  const url = $<HTMLInputElement>('endpoint').value.trim();
  if (source === 'custom') {
    if (!isValidWsUrl(url)) {
      errorEl.textContent = 'Enter a WebSocket URL starting with wss://';
      errorEl.hidden = false;
      return;
    }
  }

  const remember = $<HTMLInputElement>('remember').checked;
  settings.source = source;
  settings.endpoint = source === 'custom' && remember ? url : remember ? settings.endpoint : null;
  saveSettings(settings);

  try {
    await engine.start(); // inside the click handler: allowed to make sound
  } catch (e) {
    errorEl.textContent = `Audio could not start: ${(e as Error).message}`;
    errorEl.hidden = false;
    return;
  }
  engine.setMasterVolume(settings.master);

  const endpoints = source === 'custom' ? url : DEFAULT_WS_ENDPOINTS;
  if (target.kind === 'coins') {
    const mints = target.mints;
    engine.setCoins(mints);
    trackers = new Map(mints.map((m) => [m, new CoinTracker()]));
    stream = source === 'demo' ? new CoinDemoStream(handlers, mints) : new RpcStream(endpoints, handlers, target);
    buildCoinRows(mints);
    showCoinBar(mints);
    if (source === 'custom') for (const m of mints) void lookUpName(url, m);
  } else {
    engine.setCoins([]);
    trackers = new Map();
    stream = source === 'demo' ? new DemoStream(handlers) : new RpcStream(endpoints, handlers);
  }
  $('coin-stats').hidden = target.kind !== 'coins';
  $('market-stats').hidden = target.kind === 'coins';
  stream.start();

  renderer.start();
  $('intro').hidden = true;
  $('actions').hidden = false;
  setPanel('stats', window.innerWidth > 720);
  setFeed(window.innerWidth > 720);
  statsTimer = setInterval(renderStats, 500);
}

async function stop(): Promise<void> {
  stream?.stop();
  stream = null;
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = null;
  await engine.stop();
  renderer.stop();
  setMuted(false);
  $('actions').hidden = true;
  setPanel('stats', false);
  setPanel('mixer', false);
  setFeed(false);
  $('feed').replaceChildren();
  engine.setCoins([]);
  trackers = new Map();
  $('focusbar').hidden = true;
  text('focus-label', 'Only');
  $('focus-exit').textContent = 'Show all';
  $('focus-exit').title = 'Hear the whole market again (Esc)';
  $('intro').hidden = false;
  showState({ kind: 'idle' }, '');
}

/** Helius endpoints can tell us the coin's ticker (one getAsset call). */
async function lookUpName(wsUrl: string, mint: string): Promise<void> {
  const http = heliusHttpUrl(wsUrl);
  if (!http) return;
  const info = await fetchCoinInfo(http, mint);
  if (info && engine.coinList.includes(mint)) {
    engine.setSymbol(mint, info.symbol);
    refreshFocusName();
  }
}

// ---------------------------------------------------------------- controls

function setPanel(which: 'stats' | 'mixer', open: boolean): void {
  $(which).hidden = !open;
  $(`btn-${which}`).setAttribute('aria-pressed', String(open));
  // On narrow screens the panels overlap, so only one at a time.
  if (open && window.innerWidth <= 720) {
    const other = which === 'stats' ? 'mixer' : 'stats';
    $(other).hidden = true;
    $(`btn-${other}`).setAttribute('aria-pressed', 'false');
  }
}
const togglePanel = (which: 'stats' | 'mixer') => setPanel(which, $(which).hidden !== false);

function setFeed(open: boolean): void {
  $('feed').hidden = !open;
  $('btn-feed').setAttribute('aria-pressed', String(open));
}

let muted = false;
function setMuted(value: boolean): void {
  muted = value;
  engine.setMasterVolume(muted ? 0 : settings.master);
  $('btn-mute').setAttribute('aria-pressed', String(muted));
  $('btn-mute').textContent = muted ? 'Unmute' : 'Mute';
}

const LABELS: Record<Channel, string> = {
  buys: 'Buys',
  sells: 'Sells',
  swap: 'PumpSwap',
  events: 'Events',
  pulse: 'Slot clock',
  ghosts: 'Failed tx',
  pad: 'Pad',
};

function buildMixer(): void {
  const rows = $('mixer-rows');
  const addRow = (label: string, value: number, onInput: (v: number) => void) => {
    const row = document.createElement('label');
    row.className = 'row';
    const name = document.createElement('span');
    name.textContent = label;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = '0';
    input.max = '1.2';
    input.step = '0.05';
    input.value = String(value);
    const out = document.createElement('output');
    out.textContent = `${Math.round(value * 100)}`;
    input.addEventListener('input', () => {
      const v = Number(input.value);
      out.textContent = `${Math.round(v * 100)}`;
      onInput(v);
    });
    input.addEventListener('change', () => saveSettings(settings));
    row.append(name, input, out);
    rows.append(row);
  };
  addRow('Master', settings.master, (v) => {
    settings.master = v;
    if (!muted) engine.setMasterVolume(v);
  });
  for (const ch of CHANNELS) {
    addRow(LABELS[ch], settings.gains[ch], (v) => {
      settings.gains[ch] = v;
      engine.setGain(ch, v);
    });
  }

  const delay = $<HTMLInputElement>('delay');
  const delayOut = $('delay-out');
  delay.value = String(engine.delay);
  delayOut.textContent = `${(engine.delay / 1_000).toFixed(1)} s`;
  delay.addEventListener('input', () => {
    engine.setDelay(Number(delay.value));
    settings.delay = engine.delay;
    delayOut.textContent = `${(engine.delay / 1_000).toFixed(1)} s`;
  });
  delay.addEventListener('change', () => saveSettings(settings));
}

function initIntro(): void {
  const radios = document.querySelectorAll<HTMLInputElement>('input[name="source"]');
  const customBox = $('custom-box');
  const sync = () => {
    customBox.hidden = selectedSource() !== 'custom';
  };
  for (const r of radios) {
    r.checked = r.value === settings.source;
    r.addEventListener('change', sync);
  }
  const shared = coinsFromHash(location.hash);
  const coins = shared.length ? shared : settings.lastCoins;
  if (coins.length) $<HTMLTextAreaElement>('ca').value = coins.join('\n');
  text('ca-limit', `up to ${MAX_COINS}`);
  $('ca').addEventListener('keydown', (e) => {
    // Enter starts, Shift+Enter adds a line for the next coin.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void start('coin');
    }
  });
  if (settings.endpoint) {
    $<HTMLInputElement>('endpoint').value = settings.endpoint;
    $<HTMLInputElement>('remember').checked = true;
    $('custom-box').title = `Saved: ${maskEndpoint(settings.endpoint)}`;
  }
  sync();
}

function chooseSource(source: Source): void {
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name="source"]')) r.checked = r.value === source;
  $('custom-box').hidden = source !== 'custom';
}

$('help-custom').addEventListener('click', () => {
  void stop().then(() => {
    chooseSource('custom');
    $('endpoint').focus();
  });
});
$('help-demo').addEventListener('click', () => {
  // Swap only the data source: the audio keeps running, no new click needed.
  stream?.stop();
  chooseSource('demo');
  settings.source = 'demo';
  saveSettings(settings);
  stream = engine.coinMode ? new CoinDemoStream(handlers, engine.coinList) : new DemoStream(handlers);
  stream.start();
});

$('btn-start').addEventListener('click', () => void start('coin'));
$('btn-market').addEventListener('click', () => void start('market'));
$('btn-stop').addEventListener('click', () => void stop());
$('btn-mute').addEventListener('click', () => setMuted(!muted));
$('btn-stats').addEventListener('click', () => togglePanel('stats'));
$('btn-mixer').addEventListener('click', () => togglePanel('mixer'));
$('btn-feed').addEventListener('click', () => setFeed($('feed').hidden !== false));
$('focus-exit').addEventListener('click', () => {
  if (engine.coinMode) void stop();
  else setFocus(null, null);
});

window.addEventListener('keydown', (e) => {
  if (!engine.running || e.target instanceof HTMLInputElement) return;
  if (e.key === 'm' || e.key === 'M') setMuted(!muted);
  if (e.key === 's' || e.key === 'S') togglePanel('stats');
  if (e.key === 'x' || e.key === 'X') togglePanel('mixer');
  if (e.key === 'f' || e.key === 'F') setFeed($('feed').hidden !== false);
  if (e.key === 'Escape' && engine.focused && !engine.coinMode) setFocus(null, null);
});

canvas.addEventListener('mousemove', (e) => {
  canvas.classList.toggle('clickable', renderer.hitTest(e.clientX, e.clientY) !== null);
});
canvas.addEventListener('click', (e) => {
  const note = renderer.hitTest(e.clientX, e.clientY);
  if (note) onBubbleClick(note);
});

buildMixer();
initIntro();
renderer.stop(); // paints the empty background once
