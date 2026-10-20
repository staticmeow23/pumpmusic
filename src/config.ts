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

/**
 * Default endpoints: the free public Solana RPC. Not meant for production.
 * solana.com/docs/references/clusters names api.mainnet.solana.com (checked
 * Oct 2026); the old mainnet-beta hostname stays as a fallback.
 */
export const DEFAULT_WS_ENDPOINTS = ['wss://api.mainnet.solana.com', 'wss://api.mainnet-beta.solana.com'] as const;

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
} as const;
