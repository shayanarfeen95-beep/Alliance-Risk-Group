/**
 * The two variables this deployment cannot run without.
 *
 * A missing AUTH_SECRET took the production site down in a way that looked like
 * a broken application rather than an unfinished setup: every page rendered,
 * because the signing key is not needed until a cookie is minted, and then the
 * login form returned a bare 500 with digest 1457096130 and nothing else.
 *
 * The check is a pure environment read, so it is cheap enough to run on every
 * request and catch the problem before anybody types a password.
 */
import { afterEach, describe, expect, it } from 'vitest';

/** Mirrors the check in app/layout.tsx. Kept here so it can be asserted at all. */
function missingRequiredEnv(env: Record<string, string | undefined>): string[] {
  if (env.NODE_ENV !== 'production') return [];
  return [!env.DATABASE_URL && 'DATABASE_URL', !env.AUTH_SECRET && 'AUTH_SECRET'].filter(
    (name): name is string => typeof name === 'string',
  );
}

const production = (over: Record<string, string | undefined> = {}) => ({
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://u:p@h/db',
  AUTH_SECRET: 'a-secret',
  ...over,
});

describe('required environment', () => {
  afterEach(() => {
    // Nothing global is mutated, but keep the intent explicit.
  });

  it('names AUTH_SECRET when it is missing — the failure that took the site down', () => {
    expect(missingRequiredEnv(production({ AUTH_SECRET: undefined }))).toEqual(['AUTH_SECRET']);
  });

  it('names DATABASE_URL when it is missing', () => {
    expect(missingRequiredEnv(production({ DATABASE_URL: undefined }))).toEqual(['DATABASE_URL']);
  });

  it('names both when neither is set', () => {
    expect(
      missingRequiredEnv(production({ DATABASE_URL: undefined, AUTH_SECRET: undefined })),
    ).toEqual(['DATABASE_URL', 'AUTH_SECRET']);
  });

  it('is satisfied by a fully configured deployment', () => {
    expect(missingRequiredEnv(production())).toEqual([]);
  });

  it('never blocks development, where both have working fallbacks', () => {
    expect(
      missingRequiredEnv({ NODE_ENV: 'development', DATABASE_URL: undefined, AUTH_SECRET: undefined }),
    ).toEqual([]);
  });
});
