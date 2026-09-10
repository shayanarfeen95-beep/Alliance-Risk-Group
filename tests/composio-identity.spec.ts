/**
 * Reading an identity out of a Composio connection.
 *
 * Composio redacts credentials by design — and it does so by replacing the value
 * with the literal string "REDACTED" rather than by omitting the key. A lookup
 * that only checks for a non-empty string therefore finds a placeholder and
 * treats it as the answer.
 *
 * That produced two failures on the same line of code. The visible one was an
 * admin screen reading "Portal REDACTED" where a portal id should be. The
 * dangerous one was never reached only by luck: had a QuickBooks connection
 * carried a redacted realm-shaped key, the realm would have been stored as the
 * word REDACTED and every accounting request would have gone to
 * `/v3/company/REDACTED/…` — a connection reporting itself as healthy while
 * pointing at no books at all.
 *
 * A placeholder is an absence, and absence is a state this application already
 * knows how to handle: it asks.
 */
import { describe, expect, it } from 'vitest';
import { describeConnection } from '@/lib/connectors/composio';

function account(metadata: Record<string, unknown>) {
  return {
    id: 'ca_test',
    status: 'ACTIVE',
    toolkitSlug: 'hubspot',
    metadata,
    createdAt: null,
  };
}

describe('identity from a connection', () => {
  it('does not read a redaction placeholder as a portal id', async () => {
    const identity = await describeConnection('HUBSPOT', account({ hub_id: 'REDACTED' }));

    // Not "Portal REDACTED".
    expect(identity.accountId).toBeNull();
    expect(identity.accountLabel).not.toMatch(/redacted/i);
  });

  it('reads a real portal id', async () => {
    const identity = await describeConnection('HUBSPOT', account({ hub_id: '48210534' }));
    expect(identity.accountId).toBe('48210534');
    expect(identity.accountLabel).toBe('Portal 48210534');
  });

  it('treats the other placeholder spellings as absent too', async () => {
    for (const placeholder of ['null', 'undefined', 'none', 'N/A', '  ']) {
      const identity = await describeConnection('HUBSPOT', account({ hub_id: placeholder }));
      expect(identity.accountId).toBeNull();
    }
  });

  it('refuses a redacted value as a Google account', async () => {
    const identity = await describeConnection('SHEETS', account({ email: 'REDACTED' }));
    expect(identity.accountId).toBeNull();
  });
});
