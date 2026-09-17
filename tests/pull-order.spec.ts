/**
 * The order a pull runs its entities in.
 *
 * `syncPlan` walks each connector's `entities()` array in declaration order, so
 * the position of a descriptor IS the order it is pulled and conformed in. That
 * made the array's order load-bearing without anything saying so, and it was
 * wrong: accounts and classes sat last.
 *
 * The consequence was a balance sheet that failed on every single run while the
 * chart of accounts showed a healthy row count two lines below it on the same
 * screen. One "Pull everything" conformed the balance sheet against whatever
 * chart the warehouse happened to be holding, THEN refreshed the chart — so a
 * newly-seen account (every deleted account, the first time the query included
 * them) blocked the month, and was present by the time anybody went looking for
 * why.
 *
 * These assertions are here because nothing else would catch somebody appending
 * a new reference entity to the end of the array.
 */
import { describe, expect, it } from 'vitest';
import { qboConnector } from '@/lib/connectors/qbo';

describe('the order QuickBooks entities are pulled in', () => {
  const order = qboConnector.entities().map((entity) => entity.entity);
  const positionOf = (entity: string) => order.indexOf(entity);

  it('pulls the chart of accounts before the reports that resolve against it', () => {
    expect(positionOf('accounts')).toBeGreaterThanOrEqual(0);

    for (const dependent of ['profit_and_loss', 'balance_sheet', 'trial_balance']) {
      expect(positionOf('accounts')).toBeLessThan(positionOf(dependent));
    }
  });

  it('pulls the class list before anything that resolves a division', () => {
    for (const dependent of ['profit_and_loss', 'balance_sheet', 'ar_aging', 'ap_aging']) {
      expect(positionOf('classes')).toBeLessThan(positionOf(dependent));
    }
  });

  it('still offers every entity the dashboards need', () => {
    // Reordering must not quietly drop one.
    expect(new Set(order)).toEqual(
      new Set([
        'accounts',
        'classes',
        'profit_and_loss',
        'balance_sheet',
        'trial_balance',
        'ar_aging',
        'ap_aging',
      ]),
    );
  });
});
