import { PROGRAMS } from '../config';
import { base64ToBytes } from '../solana/encoding';
import { decodeProgramData, type PumpEvent, type Side, type Venue } from './events';

const PROGRAM_BY_ID: Record<string, 'pumpCurve' | 'pumpSwap'> = {
  [PROGRAMS.pumpCurve]: 'pumpCurve',
  [PROGRAMS.pumpSwap]: 'pumpSwap',
};
const VENUE: Record<'pumpCurve' | 'pumpSwap', Venue> = { pumpCurve: 'curve', pumpSwap: 'swap' };

const DATA_PREFIX = 'Program data: ';
const IX_PREFIX = 'Program log: Instruction: ';

export interface ParsedLogs {
  events: PumpEvent[];
  /** The transaction failed. Failed pump transactions are mostly bots losing races. */
  failed: boolean;
  /** Venue of the failed transaction, if it touched a pump program. */
  failedVenue: Venue | null;
  /** Trades known only from the instruction name (no decodable event in the logs). */
  fallbackTrades: number;
  /** `Program data:` lines emitted by other programs inside the same transaction. */
  foreignData: number;
  /** Payloads from a pump program that could not be decoded. */
  malformed: number;
}

/** Instruction names look like Buy, BuyV2, BuyExactSolIn, Sell, SellV3, ... */
function sideFromInstruction(name: string): Side | null {
  if (/^Buy/.test(name)) return 'buy';
  if (/^Sell/.test(name)) return 'sell';
  return null;
}

/**
 * Extracts pump events from a transaction's log lines.
 *
 * `Program data:` lines don't say which program wrote them, so any program in
 * the transaction could forge a pump event. The runtime brackets every
 * invocation with `Program <id> invoke [n]` ... `Program <id> success|failed`,
 * so a stack over those lines tells us who emitted each line. Only payloads
 * emitted by pump's own frames are trusted.
 */
export function parseLogs(logs: readonly string[], err: unknown): ParsedLogs {
  const result: ParsedLogs = {
    events: [],
    failed: err !== null && err !== undefined,
    failedVenue: null,
    fallbackTrades: 0,
    foreignData: 0,
    malformed: 0,
  };

  const stack: string[] = [];
  // Instruction-name trades per frame, used only when no event was decoded.
  const pendingIx: { venue: Venue; side: Side }[] = [];
  let decodedTrades = 0;

  for (const line of logs) {
    if (line.startsWith('Program ') && !line.startsWith('Program log:') && !line.startsWith('Program data:')) {
      const parts = line.split(' ');
      const id = parts[1];
      const verb = parts[2];
      if (id && verb?.startsWith('invoke')) {
        stack.push(id);
        const program = PROGRAM_BY_ID[id];
        if (program && result.failed && result.failedVenue === null) result.failedVenue = VENUE[program];
        continue;
      }
      // "Program X success" or "Program X failed: custom program error: 0x..."
      if (verb === 'success' || verb?.startsWith('failed')) {
        stack.pop();
        continue;
      }
      continue; // "consumed N of M compute units", "return:", ...
    }

    const current = stack[stack.length - 1];
    const program = current ? PROGRAM_BY_ID[current] : undefined;

    if (line.startsWith(DATA_PREFIX)) {
      if (!program) {
        result.foreignData++;
        continue;
      }
      const bytes = base64ToBytes(line.slice(DATA_PREFIX.length));
      if (!bytes) {
        result.malformed++;
        continue;
      }
      const decoded = decodeProgramData(program, bytes);
      if (decoded.status === 'event') {
        result.events.push(decoded.event);
        if (decoded.event.kind === 'trade') decodedTrades++;
      } else if (decoded.status === 'malformed') {
        result.malformed++;
      }
      continue;
    }

    if (program && line.startsWith(IX_PREFIX)) {
      const side = sideFromInstruction(line.slice(IX_PREFIX.length));
      if (side) pendingIx.push({ venue: VENUE[program], side });
    }
  }

  // Failed transactions emit no events; we report them once and stop there.
  if (result.failed) return { ...result, events: [] };

  // Logs can be truncated on large transactions. If we saw pump buy/sell
  // instructions but could not read any trade event, still make a sound.
  if (decodedTrades === 0 && pendingIx.length > 0) {
    for (const ix of pendingIx) {
      result.events.push({ kind: 'trade', venue: ix.venue, side: ix.side, token: null, impact: null, lamports: null, user: null, price: null, quote: null, progress: null, quoteAmount: null, creator: null });
      result.fallbackTrades++;
    }
  }
  return result;
}
