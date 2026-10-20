import type { ParsedLogs } from '../pump/logs';

/** One pump transaction as it reaches the app. */
export interface TxMessage {
  slot: number;
  signature: string;
  /** performance.now() when the message arrived. */
  receivedAt: number;
  parsed: ParsedLogs;
}

export type StreamState =
  | { kind: 'idle' }
  | { kind: 'connecting'; attempt: number }
  | { kind: 'live'; since: number }
  | { kind: 'waiting'; retryInMs: number; reason: string }
  | { kind: 'error'; reason: string };

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
