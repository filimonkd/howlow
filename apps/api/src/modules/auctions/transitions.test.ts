import type { AuctionStatus } from '@howlow/shared';
import { AUCTION_STATUSES } from '@howlow/shared';
import { describe, expect, it } from 'vitest';
import {
  AUCTION_TRANSITIONS,
  allowedFrom,
  canTransition,
  holdsInventory,
  isTerminal,
  targetOf,
  termsAreLocked,
  type AuctionAction,
} from './transitions.js';

/**
 * The transition table, tested as the specification it is.
 *
 * Every status change in the platform consults this table, so a mistake here
 * is a mistake everywhere — including the moves the brief names explicitly as
 * ones that must be rejected.
 */
const ACTIONS = Object.keys(AUCTION_TRANSITIONS) as AuctionAction[];

describe('the moves that must be rejected', () => {
  /** Named in the specification as examples that must not be possible. */
  it('refuses draft → live', () => {
    expect(canTransition('open', 'draft')).toBe(false);
  });

  it('refuses live → scheduled', () => {
    // Nothing targets `scheduled` except approval, and approval starts from
    // pending_approval only.
    expect(canTransition('approve', 'live')).toBe(false);
    expect(targetOf('approve')).toBe('scheduled');
  });

  it('refuses completed → live', () => {
    expect(canTransition('open', 'completed')).toBe(false);
  });

  it('lets nothing at all move out of a terminal state', () => {
    for (const status of ['completed', 'cancelled'] as const) {
      expect(isTerminal(status)).toBe(true);
      for (const action of ACTIONS) {
        expect(canTransition(action, status)).toBe(false);
      }
    }
  });

  it('refuses to skip approval', () => {
    expect(canTransition('approve', 'draft')).toBe(false);
    expect(canTransition('open', 'pending_approval')).toBe(false);
  });

  it('refuses to close an auction that never opened', () => {
    for (const status of ['draft', 'pending_approval', 'scheduled'] as const) {
      expect(canTransition('close', status)).toBe(false);
    }
  });
});

describe('the happy path', () => {
  it('walks draft → pending_approval → scheduled → live → closing', () => {
    const path: readonly [AuctionAction, AuctionStatus, AuctionStatus][] = [
      ['submit', 'draft', 'pending_approval'],
      ['approve', 'pending_approval', 'scheduled'],
      ['open', 'scheduled', 'live'],
      ['close', 'live', 'closing'],
    ];
    for (const [action, from, to] of path) {
      expect(canTransition(action, from)).toBe(true);
      expect(targetOf(action)).toBe(to);
    }
  });

  /**
   * Phase 4 stops at `closing`. The two moves beyond it are declared so the
   * Phase 6 service enforces the same previous-state rules, and nothing in
   * Phase 4 performs them.
   */
  it('declares the Phase 6 moves without Phase 4 using them', () => {
    expect(canTransition('beginCalculating', 'closing')).toBe(true);
    expect(targetOf('beginCalculating')).toBe('calculating');
    expect(canTransition('complete', 'calculating')).toBe(true);
    expect(targetOf('complete')).toBe('completed');
    // Nothing reaches `calculating` except from `closing`.
    expect(allowedFrom('beginCalculating')).toEqual(['closing']);
  });

  it('returns a rejected auction to its seller as a draft', () => {
    expect(canTransition('reject', 'pending_approval')).toBe(true);
    expect(targetOf('reject')).toBe('draft');
    // And a returned draft can be resubmitted.
    expect(canTransition('submit', 'draft')).toBe(true);
  });
});

describe('suspension', () => {
  it('is reachable only from states that are committed but unfinished', () => {
    expect(allowedFrom('suspend')).toEqual(['pending_approval', 'scheduled', 'live']);
    for (const status of ['draft', 'closing', 'calculating', 'completed', 'cancelled'] as const) {
      expect(canTransition('suspend', status)).toBe(false);
    }
  });
});

describe('cancellation', () => {
  it('is reachable from everything unfinished and nothing finished', () => {
    const cancellable = new Set<AuctionStatus>(allowedFrom('cancel'));
    for (const status of AUCTION_STATUSES) {
      const expected = !['calculating', 'completed', 'cancelled'].includes(status);
      expect(cancellable.has(status)).toBe(expected);
    }
  });

  /**
   * An auction being decided is past the point where cancelling is safe: bids
   * are in and fees have been taken, so unwinding is a refund decision for a
   * later phase rather than a status change.
   */
  it('does not allow cancelling an auction that is already being decided', () => {
    expect(canTransition('cancel', 'calculating')).toBe(false);
  });
});

describe('terms and inventory', () => {
  it('locks terms from the moment bidding can begin', () => {
    expect(termsAreLocked('draft')).toBe(false);
    expect(termsAreLocked('pending_approval')).toBe(false);
    expect(termsAreLocked('scheduled')).toBe(false);
    for (const status of ['live', 'closing', 'calculating', 'completed', 'cancelled', 'suspended'] as const) {
      expect(termsAreLocked(status)).toBe(true);
    }
  });

  /**
   * A suspended auction keeps its unit: releasing it would let another auction
   * take the stock, and resuming would then fail.
   */
  it('holds inventory exactly while an auction is committed to a unit', () => {
    expect(holdsInventory('live')).toBe(true);
    expect(holdsInventory('closing')).toBe(true);
    expect(holdsInventory('suspended')).toBe(true);
    for (const status of ['draft', 'pending_approval', 'scheduled', 'cancelled'] as const) {
      expect(holdsInventory(status)).toBe(false);
    }
  });
});

describe('the table itself', () => {
  it('names only real statuses', () => {
    const known = new Set<string>(AUCTION_STATUSES);
    for (const action of ACTIONS) {
      expect(known).toContain(targetOf(action));
      for (const from of allowedFrom(action)) expect(known).toContain(from);
    }
  });

  it('never lets an action start from the state it targets', () => {
    // A self-transition would make "already done" and "legal move" ambiguous,
    // and the lifecycle service relies on that distinction to stay idempotent.
    for (const action of ACTIONS) {
      expect(allowedFrom(action)).not.toContain(targetOf(action));
    }
  });

  it('can reach every status from the draft state', () => {
    // A status nothing can reach would be dead weight in the enum.
    const reachable = new Set<AuctionStatus>(['draft']);
    // Iterate to a fixed point: one pass per status is more than enough for
    // any chain the table can express.
    for (const _pass of AUCTION_STATUSES) {
      for (const action of ACTIONS) {
        if (allowedFrom(action).some((from) => reachable.has(from))) {
          reachable.add(targetOf(action));
        }
      }
    }
    expect([...AUCTION_STATUSES].filter((status) => !reachable.has(status))).toEqual([]);
  });
});
