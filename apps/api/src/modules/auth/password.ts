import { hash, verify, type Algorithm } from '@node-rs/argon2';

/**
 * Argon2id, the current recommendation for password storage: memory-hard, so an
 * attacker with GPUs gains far less than they would against a fast hash.
 *
 * Parameters follow OWASP's guidance (19 MiB, 2 iterations, parallelism 1).
 * The cost is encoded in the hash string, so raising it later does not
 * invalidate existing hashes — `needsRehash` reports which ones to upgrade on
 * next successful login.
 */
// @node-rs/argon2 publishes Algorithm as an ambient const enum, which cannot be
// imported as a value under verbatimModuleSyntax. Argon2id is variant 2; bound
// here once so the number never appears at a call site.
const ARGON2ID = 2 as Algorithm;

const OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, OPTIONS);
}

/**
 * Verify a password. Returns false rather than throwing on a malformed stored
 * hash, so a corrupt row denies access instead of leaking a different error
 * shape that would distinguish it from a wrong password.
 */
export async function verifyPassword(storedHash: string, plaintext: string): Promise<boolean> {
  try {
    return await verify(storedHash, plaintext, OPTIONS);
  } catch {
    return false;
  }
}

/**
 * Spend roughly the same time as a real verification when no account exists.
 * Without this, "no such user" returns measurably faster than "wrong password",
 * which is an account-enumeration oracle.
 */
export async function simulatePasswordVerification(): Promise<void> {
  await hash('timing-equalisation-placeholder', OPTIONS);
}
