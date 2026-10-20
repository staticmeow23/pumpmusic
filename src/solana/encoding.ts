const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Decodes standard base64. Returns null for malformed input instead of throwing. */
export function base64ToBytes(input: string): Uint8Array | null {
  try {
    const bin = atob(input.trim());
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Encodes bytes as base58 (Bitcoin/Solana alphabet). */
export function bytesToBase58(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  // Repeated division of the big-endian byte array by 58.
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += B58_ALPHABET[digits[i]!];
  return out;
}

/** Cheap syntactic check for a Solana address (used before building links). */
export function isBase58Address(value: string): boolean {
  return B58_PATTERN.test(value);
}

/** FNV-1a 32-bit hash. Deterministic, so every listener hears a token the same way. */
export function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
