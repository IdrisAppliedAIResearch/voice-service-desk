import { randomBytes } from 'node:crypto';
import * as argon2 from '@node-rs/argon2';

export function normalizeAnswer(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}]/gu, '').replace(/\s+/g, ' ').trim();
}

// The library default is argon2id (m=19456 KiB, t=2, p=1); crypto.test.ts pins the $argon2id$ prefix.
export function hashSecret(normalized: string): Promise<string> {
  return argon2.hash(normalized);
}

export async function verifySecret(hash: string, normalized: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, normalized);
  } catch {
    return false;
  }
}

// Same parameters as hashSecret, so checking a decoy costs the same time as checking a real answer.
export const DUMMY_HASH = argon2.hashSync(randomBytes(32).toString('hex'));
