import { createHash } from 'node:crypto';

/** SHA-1 hex digest of a byte buffer. */
export function hashBytes(bytes: Uint8Array): string {
  return createHash('sha1').update(bytes).digest('hex');
}

/**
 * SHA-1 hex digest of a JSON-serialisable value. Used for scope fingerprints
 * (rule identity, backend identity, project-wide file sets).
 */
export function hashValue(value: unknown): string {
  return hashBytes(Buffer.from(JSON.stringify(value) ?? 'null', 'utf8'));
}
