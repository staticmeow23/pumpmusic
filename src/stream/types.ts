import type { ParsedLogs } from '../pump/logs';

/** One pump transaction as it reaches the app. */
export interface TxMessage {
  slot: number;
  signature: string;
  /** performance.now() when the message arrived. */
  receivedAt: number;
  parsed: ParsedLogs;
  /** Coin mode: the mint whose subscription delivered this transaction. */
  mentions: string | null;
}

export type StreamState =
  | { kind: 'idle' }
  | { kind: 'connecting'; attempt: number }
  | { kind: 'live'; since: number }
  /** `failures`: connections in a row that ended without going live (or dropped). */
  | { kind: 'waiting'; retryInMs: number; reason: string; failures: number }
  | { kind: 'error'; reason: string };

/** What to listen to: the whole pump market (both programs) or a few coins by mint. */
export type StreamTarget = { kind: 'market' } | { kind: 'coins'; mints: readonly string[] };

export interface StreamHandlers {
  onTx(tx: TxMessage): void;
  onSlot(slot: number, receivedAt: number): void;
  onState(state: StreamState): void;
  /** Raw size of every received frame, for the cost estimate. */
  onBytes(bytes: number, kind: 'logs' | 'slot' | 'other'): void;
}

export interface Stream {
  start(): void;
  stop(): void;
  readonly label: string;
}
