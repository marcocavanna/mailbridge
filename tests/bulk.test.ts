import { describe, expect, it } from 'vitest';

import { getBulkLimit, validateUidSet } from '#imap/bulk';
import { isMailbridgeError } from '#shared/errors';

/* --------
 * validateUidSet
 * -------- */

describe('validateUidSet', () => {
  it('sorts the uids, so the range handed to the server is predictable', () => {
    expect(validateUidSet([30, 10, 20])).toEqual([10, 20, 30]);
  });

  /*
   * A repeated uid would make the server's confirmed count disagree with the caller's request, and that
   * difference is the only signal available to tell a partial move from a complete one.
   */
  it('removes duplicates', () => {
    expect(validateUidSet([5, 5, 7, 5])).toEqual([5, 7]);
  });

  it('drops values that cannot be uids', () => {
    expect(validateUidSet([1, 0, -3, 2.5, 4])).toEqual([1, 4]);
  });

  it('refuses an empty set rather than issuing a no-op operation', () => {
    expect(() => validateUidSet([])).toThrow(/No valid message/);
    expect(() => validateUidSet([0, -1])).toThrow(/No valid message/);
  });

  /*
   * The cap is a blast-radius limit, not a technical one: a mistaken or injected instruction can
   * reorganize at most this many messages before somebody notices.
   */
  it('enforces the cap and says how to proceed', () => {
    const tooMany = Array.from({ length: getBulkLimit() + 1 }, (_, index) => index + 1);

    expect(() => validateUidSet(tooMany)).toThrow(/Too many messages/);

    /*
     * The limit and the way out live in `remediation`, not in the message. What reaches the model is the
     * two joined, so that is what gets asserted — checking only the message would pass while the caller
     * is left without the number it needs.
     */
    try {
      validateUidSet(tooMany);
      expect.unreachable('should have thrown');
    } catch (cause) {
      expect(isMailbridgeError(cause)).toBe(true);

      if (isMailbridgeError(cause)) {
        expect(cause.toAgentMessage()).toContain(String(getBulkLimit()));
        expect(cause.toAgentMessage()).toMatch(/safe to run again/i);
      }
    }
  });

  it('accepts exactly the cap', () => {
    const atLimit = Array.from({ length: getBulkLimit() }, (_, index) => index + 1);

    expect(validateUidSet(atLimit)).toHaveLength(getBulkLimit());
  });

  it('counts the cap after deduplication, so repeats do not eat the budget', () => {
    const withDuplicates = [...Array.from({ length: getBulkLimit() }, (_, index) => index + 1), 1, 2, 3];

    expect(validateUidSet(withDuplicates)).toHaveLength(getBulkLimit());
  });
});
