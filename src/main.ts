import { CHANNELS, DEFAULT_GAINS, MusicEngine, type Channel, type VisualNote } from './audio/engine';
import { DEFAULT_WS_ENDPOINTS, FEED, MUSIC } from './config';
import { DemoStream } from './stream/demo-stream';
import { RpcStream, isValidWsUrl, maskEndpoint } from './stream/rpc-stream';
import type { Stream, StreamState, TxMessage } from './stream/types';
import { feedLine, type FeedLine } from './ui/feed';
import { coinFromHash, hashForCoin } from './ui/focus';
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
}
const STORAGE_KEY = 'slotwave.settings.v1';

function loadSettings(): Settings {
  const fallback: Settings = { source: 'public', endpoint: null, gains: { ...DEFAULT_GAINS }, master: 0.9, delay: MUSIC.defaultDelayMs };
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
  const line = feedLine(n, engine.focused !== null);
  // The log line appears when the note sounds, not when the data arrives.
  if (line) setTimeout(() => addFeedLine(line), Math.max(0, n.at - performance.now()));
};
engine.onSlotMark = (m) => renderer.slot(m);

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
    else if (ev.kind === 'migrate') graduations++;
  }
  engine.handleTx(tx);
}

function renderStats(): void {
  const now = performance.now();
  const cb = rates.curveBuys.perSecond(now);
  const cs = rates.curveSells.perSecond(now);
  const sw = rates.swap.perSecond(now);
  const total = cb + cs + sw;
  activity = Math.min(1, total / 25);
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
  text('s-free', `${(cost.freePlanShare * 100).toFixed(0)} %`);
  text('s-decoder', `fallback ${decoder.fallback} · foreign ${decoder.foreign} · bad ${decoder.malformed}`);
  refreshFocusName();
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

/** The ticker often arrives after the focus was set (with the coin's next create or trade). */
function refreshFocusName(): void {
  const coin = engine.focused;
  if (!coin) return;
  const sym = engine.symbolOf(coin);
  text('focus-name', sym ? `$${sym}` : shortAddress(coin));
}

function onBubbleClick(note: VisualNote): void {
  if (note.coin && note.coin !== engine.focused) setFocus(note.coin, note.link);
  else if (note.link) window.open(note.link, '_blank', 'noopener,noreferrer');
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

async function start(): Promise<void> {
  const source = selectedSource();
  const errorEl = $('source-error');
  errorEl.hidden = true;

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

  stream = source === 'demo' ? new DemoStream(handlers) : new RpcStream(source === 'custom' ? url : DEFAULT_WS_ENDPOINTS, handlers);
  stream.start();

  renderer.start();
  $('intro').hidden = true;
  $('actions').hidden = false;
  setPanel('stats', window.innerWidth > 720);
  setFeed(window.innerWidth > 720);
  const shared = coinFromHash(location.hash);
  if (shared) setFocus(shared, `https://pump.fun/coin/${shared}`);
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
  engine.setFocus(null);
  $('focusbar').hidden = true;
  $('intro').hidden = false;
  showState({ kind: 'idle' }, '');
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
  stream = new DemoStream(handlers);
  stream.start();
});

$('btn-start').addEventListener('click', () => void start());
$('btn-stop').addEventListener('click', () => void stop());
$('btn-mute').addEventListener('click', () => setMuted(!muted));
$('btn-stats').addEventListener('click', () => togglePanel('stats'));
$('btn-mixer').addEventListener('click', () => togglePanel('mixer'));
$('btn-feed').addEventListener('click', () => setFeed($('feed').hidden !== false));
$('focus-exit').addEventListener('click', () => setFocus(null, null));

window.addEventListener('keydown', (e) => {
  if (!engine.running || e.target instanceof HTMLInputElement) return;
  if (e.key === 'm' || e.key === 'M') setMuted(!muted);
  if (e.key === 's' || e.key === 'S') togglePanel('stats');
  if (e.key === 'x' || e.key === 'X') togglePanel('mixer');
  if (e.key === 'f' || e.key === 'F') setFeed($('feed').hidden !== false);
  if (e.key === 'Escape' && engine.focused) setFocus(null, null);
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
