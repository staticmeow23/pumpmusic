/**
 * Central configuration. Program IDs and event discriminators were verified
 * against the official IDLs in github.com/pump-fun/pump-public-docs (Oct 2026).
 * Re-check them there before changing anything here.
 */

export const PROGRAMS = {
  /** pump.fun bonding curve (tokens before graduation). */
  pumpCurve: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  /** PumpSwap AMM (tokens after graduation). */
  pumpSwap: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
} as const;

export type ProgramKey = keyof typeof PROGRAMS;

/** Anchor event discriminators (first 8 bytes of a `Program data:` payload). */
export const DISCRIMINATORS = {
  pumpCurve: {
    TradeEvent: [189, 219, 127, 211, 78, 230, 97, 238],
    CreateEvent: [27, 114, 169, 77, 222, 235, 99, 118],
    CompleteEvent: [95, 114, 97, 156, 212, 46, 152, 8],
    CompletePumpAmmMigrationEvent: [189, 233, 93, 185, 92, 148, 234, 148],
  },
  pumpSwap: {
    BuyEvent: [103, 244, 82, 31, 44, 245, 119, 119],
    SellEvent: [62, 47, 55, 10, 165, 3, 220, 42],
    CreatePoolEvent: [177, 49, 12, 210, 160, 118, 167, 116],
  },
} as const;

/** The all-zero pubkey pump.fun uses as quote_mint for SOL-paired coins. */
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** Every pump coin: 1 billion tokens with 6 decimals. */
export const TOKEN_DECIMALS = 6;
export const TOKEN_SUPPLY_RAW = 1_000_000_000 * 10 ** TOKEN_DECIMALS;
/** real_token_reserves of a fresh bonding curve (seen in real CreateEvents, Oct 2026). */
export const INITIAL_REAL_TOKEN_RESERVES = 793_100_000_000_000;

/**
 * Default endpoints: the free public Solana RPC. Not meant for production.
 * solana.com/docs/references/clusters names api.mainnet.solana.com (checked
 * Oct 2026); the old mainnet-beta hostname stays as a fallback.
 */
export const DEFAULT_WS_ENDPOINTS = ['wss://api.mainnet.solana.com', 'wss://api.mainnet-beta.solana.com'] as const;

/**
 * The Slotwave relay (relay/ in this repo, a Cloudflare Worker holding the
 * Helius key). Empty hides the option.
 */
export const RELAY_WS_URL = 'wss://slotwave-relay.staticmeow.workers.dev/ws';

/** Mainnet has no warmup epochs, so epoch = floor(slot / SLOTS_PER_EPOCH). */
export const SLOTS_PER_EPOCH = 432_000;
/** Each leader produces this many consecutive slots (one musical beat). */
export const SLOTS_PER_LEADER_WINDOW = 4;
/** Nominal slot time since Oct 2026 (SIMD-0525). The clock measures the real value. */
export const NOMINAL_SLOT_MS = 200;

/** Helius bills streamed WebSocket data at 2 credits per 0.1 MB (checked Oct 2026). */
export const HELIUS_CREDITS_PER_100KB = 2;
export const HELIUS_FREE_MONTHLY_CREDITS = 1_000_000;

export const STREAM = {
  /** Reconnect backoff bounds. */
  backoffMinMs: 1_000,
  backoffMaxMs: 30_000,
  /** If nothing arrives for this long the socket is considered dead. */
  watchdogMs: 20_000,
  /** How many signatures to remember for de-duplication. */
  dedupeSize: 5_000,
} as const;

export const MUSIC = {
  /** Default buffer between "slot happened" and "slot is heard". */
  defaultDelayMs: 1_200,
  minDelayMs: 400,
  maxDelayMs: 4_000,
  /** Notes per instrument per slot; anything beyond is folded into texture. */
  notesPerSlotPerVoice: 2,
  /** Hard cap of simultaneously sounding voices (CPU safety). */
  maxActiveVoices: 64,
  /** Trade size (share of reserves) above which a trade counts as a whale. */
  whaleImpact: 0.03,
  /** Chord changes every N slots (32 slots = 2 bars = 6.4 s at 200 ms). */
  slotsPerChord: 32,
  /** Mood (buy vs sell pressure) smoothing time constant. */
  moodHalfLifeMs: 15_000,
  /** Trades per second that count as "busy" for pad and background (measured live, Oct 2026: ~325/s). */
  marketActivityRef: 150,
  /** Listening to one coin. */
  coin: {
    /** One scale step per 3 % price move. */
    priceStep: 1.03,
    /** The melody's home price follows the real price with this half-life. */
    priceHalfLifeMs: 180_000,
    /** Pentatonic steps around home: -8 (1.6 octaves down) .. +12 (2.4 octaves up). */
    minStep: -8,
    maxStep: 12,
    /** One coin rarely has more; every trade should be heard. */
    notesPerSlot: 4,
    activityRef: 3,
  },
} as const;

/** Activity log: which trades get a line, and how many lines stay on screen. */
export const FEED = {
  minSol: 1,
  maxItems: 8,
} as const;

/**
 * How many coins can be heard at once. Each is one logsSubscribe on the same
 * connection, so data (and Helius credits) grow with every coin. Set by the
 * user (Oct 2026); the relay enforces the same number per listener.
 */
export const MAX_COINS = 3;

/** One colour per coin, in the order the coins were entered (RGB triplets for canvas). */
export const COIN_COLORS = [
  '94, 234, 212', // teal
  '252, 211, 77', // amber
  '196, 181, 253', // violet
  '251, 146, 60', // orange
  '125, 211, 252', // sky
  '190, 242, 100', // lime
  '244, 114, 182', // pink
  '253, 164, 175', // coral
] as const;

/**
 * When a coin "rugs" (a heuristic, never proof). Any one of: a single sell
 * taking a fifth of the pool's quote reserves, the coin's creator selling
 * 5 % or more, or the price falling 40 % within a minute. One alarm per coin
 * per two minutes.
 */
export const RUG = {
  dumpImpact: 0.2,
  devImpact: 0.05,
  crashDrop: 0.4,
  windowMs: 60_000,
  cooldownMs: 120_000,
} as const;
