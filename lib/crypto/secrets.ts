import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Encryption for credentials at rest.
 *
 * OAuth refresh tokens for QuickBooks and HubSpot, and a Google service-account
 * private key, are the most sensitive things this system stores — more so than
 * the figures, because they grant access to ARG's accounting system directly.
 * They are encrypted before they reach the database, so a database dump, a
 * backup, or a read-only Postgres user does not hand someone ARG's books.
 *
 * AES-256-GCM: authenticated, so a tampered ciphertext fails to decrypt rather
 * than silently producing garbage that gets sent to Intuit as a token.
 *
 * The key comes from CREDENTIAL_KEY. Where it is absent the store refuses to
 * write rather than falling back to something weaker — a credential that
 * *looks* encrypted and is not is worse than an obvious plaintext one, because
 * nobody goes back to check.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

export class MissingCredentialKeyError extends Error {
  constructor() {
    super(
      'CREDENTIAL_KEY is not set, so source credentials cannot be stored. Generate one with ' +
        '`openssl rand -base64 32` and set it in the environment. Connecting a source is refused ' +
        'rather than storing a token unprotected.',
    );
    this.name = 'MissingCredentialKeyError';
  }
}

export function hasCredentialKey(): boolean {
  return Boolean(process.env.CREDENTIAL_KEY);
}

/**
 * Derives the 32-byte key.
 *
 * SHA-256 over the configured value, so any length of input works and the
 * operator is not forced to produce exactly 32 raw bytes. This is a key
 * *derivation* for a high-entropy secret, not password hashing — the input is
 * expected to be random, so a slow KDF would buy nothing.
 */
function key(): Buffer {
  const configured = process.env.CREDENTIAL_KEY;
  if (!configured) throw new MissingCredentialKeyError();
  return createHash('sha256').update(configured, 'utf8').digest();
}

/** Returns `v1.<iv>.<tag>.<ciphertext>`, all base64url. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    'v1',
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export function decryptSecret(encoded: string): string {
  const [version, ivPart, tagPart, dataPart] = encoded.split('.');
  if (version !== 'v1' || !ivPart || !tagPart || !dataPart) {
    throw new Error('Stored credential is not in the expected format and cannot be decrypted.');
  }

  const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));

  try {
    return Buffer.concat([
      decipher.update(Buffer.from(dataPart, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // Authentication failure means either the key changed or the ciphertext was
    // altered. Both mean "reconnect the source", and neither should be papered
    // over by returning something usable.
    throw new Error(
      'Stored credential failed to decrypt. Either CREDENTIAL_KEY changed or the record was ' +
        'altered — reconnect the source.',
    );
  }
}

/** A display form that proves which credential is stored without revealing it. */
export function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}
