/**
 * The connection string Neon actually gives you.
 *
 * Neon's console ends its string with `?sslmode=require&channel_binding=require`.
 * That is correct for psql and fatal for postgres-js, which forwards any query
 * parameter it has no option for to the server as a startup parameter — and
 * Postgres rejects an unknown one with FATAL, so every request 500s with nothing
 * on screen explaining why.
 *
 * Pasting the string you were handed is the obvious thing to do, so it has to
 * work.
 */
import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sanitiseConnectionString } from '@/lib/db/client';

const NEON = 'postgresql://user:pw@ep-x-pooler.c-2.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require';

/** What postgres-js would send in the startup packet for a given URL. */
function startupParams(url: string): Record<string, string> {
  const sql = postgres(url, { max: 1, prepare: false });
  const params = { ...(sql.options.connection as Record<string, string>) };
  void sql.end();
  return params;
}

describe('connection string', () => {
  it('drops channel_binding, which Postgres would reject as a startup parameter', () => {
    expect(startupParams(NEON)).toHaveProperty('channel_binding');
    expect(startupParams(sanitiseConnectionString(NEON))).not.toHaveProperty('channel_binding');
  });

  it('keeps sslmode, which postgres-js does understand', () => {
    const cleaned = sanitiseConnectionString(NEON);
    expect(cleaned).toContain('sslmode=require');
    expect(postgres(cleaned, { max: 1 }).options.ssl).toBe('require');
  });

  it('leaves a string with nothing to strip exactly as it was', () => {
    const plain = 'postgresql://user:pw@host/db?sslmode=require';
    expect(sanitiseConnectionString(plain)).toBe(plain);
  });

  it('hands an unparseable string over untouched, rather than mangling it', () => {
    expect(sanitiseConnectionString('not a url')).toBe('not a url');
  });

  it('strips every libpq-only parameter, not only the one Neon sets', () => {
    const busy =
      'postgresql://u:p@h/db?sslmode=require&channel_binding=require&gssencmode=disable&sslcert=/x&application_name=arg';
    const cleaned = sanitiseConnectionString(busy);

    expect(cleaned).not.toContain('channel_binding');
    expect(cleaned).not.toContain('gssencmode');
    expect(cleaned).not.toContain('sslcert');
    // application_name is a real Postgres setting and must survive.
    expect(cleaned).toContain('application_name=arg');
  });
});
