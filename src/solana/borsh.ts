import { bytesToBase58 } from './encoding';

/** Thrown when a payload ends before a field. Older events are shorter than the current IDL. */
export class EndOfData extends Error {
  constructor() {
    super('end of data');
  }
}

/**
 * Minimal little-endian Borsh reader for Anchor event payloads.
 * 64-bit integers are returned as JS numbers: precise up to 2^53, which covers
 * every amount the music needs. Exact accounting would need bigint.
 */
export class BorshReader {
  private readonly view: DataView;
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  private need(n: number): void {
    if (this.offset + n > this.bytes.length) throw new EndOfData();
  }

  u8(): number {
    this.need(1);
    return this.view.getUint8(this.offset++);
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  u64(): number {
    this.need(8);
    const v = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return Number(v);
  }

  i64(): number {
    this.need(8);
    const v = this.view.getBigInt64(this.offset, true);
    this.offset += 8;
    return Number(v);
  }

  i128(): number {
    this.need(16);
    const lo = this.view.getBigUint64(this.offset, true);
    const hi = this.view.getBigInt64(this.offset + 8, true);
    this.offset += 16;
    return Number((hi << 64n) | lo);
  }

  pubkey(): string {
    this.need(32);
    const v = bytesToBase58(this.bytes.subarray(this.offset, this.offset + 32));
    this.offset += 32;
    return v;
  }

  /** Borsh string: u32 length + UTF-8. `maxLen` guards against hostile lengths. */
  string(maxLen = 1_024): string {
    const len = this.u32();
    if (len > maxLen) throw new EndOfData();
    this.need(len);
    const v = new TextDecoder().decode(this.bytes.subarray(this.offset, this.offset + len));
    this.offset += len;
    return v;
  }

  skip(n: number): void {
    this.need(n);
    this.offset += n;
  }
}
