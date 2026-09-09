/**
 * A refused request must never look like an empty one.
 *
 * This is the rule the whole codebase is built on, and the ingestion path broke
 * it in the worst possible place. HubSpot caps a page at 50 objects when
 * property history is requested and REFUSES anything larger; the connector asked
 * for 100. So every deals page came back as:
 *
 *   {"status":"error","message":"You can only request at most 50 objects in one
 *    request for properties with history.","category":"VALIDATION_ERROR"}
 *
 * Composio's envelope called that a successful call — from where it stands the
 * request was delivered — so nothing threw. The connector read `results ?? []`
 * off an error object, got an empty page, stopped paginating, and the run was
 * recorded SUCCEEDED with zero rows and a green tick. The dashboards showed no
 * bookings and no pipeline, and every screen agreed with every other screen that
 * there were no deals.
 *
 * Two independent guards, because either alone would have let it through.
 */
import { describe, expect, it } from 'vitest';
import { unwrapForTest } from '@/lib/connectors/composio';

const HUBSPOT_HISTORY_REFUSAL = {
  status: 'error',
  message: 'You can only request at most 50 objects in one request for properties with history.',
  correlationId: '01a08876-267d-7d64-aca3-e7c06cef5673',
  category: 'VALIDATION_ERROR',
};

describe('a provider error inside a delivered proxy call', () => {
  it('throws rather than being handed back as a payload', () => {
    // Note what is NOT here: `successful: false`. Composio reports the call as
    // fine because it reached HubSpot. Only the body says otherwise.
    expect(() => unwrapForTest({ data: HUBSPOT_HISTORY_REFUSAL }, 'the deals request')).toThrow(
      /at most 50 objects/,
    );
  });

  it('names the provider category so the cause is readable', () => {
    expect(() => unwrapForTest({ data: HUBSPOT_HISTORY_REFUSAL }, 'the deals request')).toThrow(
      /VALIDATION_ERROR/,
    );
  });

  it('still throws on an explicit envelope failure', () => {
    expect(() =>
      unwrapForTest({ successful: false, error: 'connection expired' }, 'the deals request'),
    ).toThrow(/connection expired/);
  });

  it('passes a real payload through untouched', () => {
    const page = { results: [{ id: '1' }, { id: '2' }], paging: { next: { after: '52' } } };
    expect(unwrapForTest<typeof page>({ data: page }, 'the deals request')).toEqual(page);
  });

  it('does not mistake a legitimate status field for a failure', () => {
    // A deal whose own `status` property happens to say something is not an
    // error envelope. Only `status: "error"` is.
    const page = { results: [{ id: '1', properties: { status: 'open' } }], status: 'ok' };
    expect(unwrapForTest<typeof page>({ data: page }, 'the deals request')).toEqual(page);
  });
});
