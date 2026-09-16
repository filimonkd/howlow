import type { AuctionStatus } from '@howlow/shared';

/**
 * The auction transition table.
 *
 * This is the single declaration of what an auction may do next. The lifecycle
 * service consults it for every move, and no other code changes a status — so
 * "DRAFT → LIVE must be rejected" is a property of this table rather than a
 * check someone has to remember to write.
 *
 *   draft ──submit──▶ pending_approval ──approve──▶ scheduled ──open──▶ live
 *     ▲                     │                                            │
 *     └──────reject─────────┘                                         close
 *                                                                        │
 *                                                                        ▼
 *                                              completed ◀──(Phase 6)── closing
 *                                                    ▲                   │
 *                                                    └── calculating ◀───┘
 *
 * `suspend` is reachable from the states where an auction is committed but not
 * finished; `resume` restores whatever state the suspension interrupted, which
 * is why `auctions.suspended_from` exists rather than resume guessing.
 *
 * `cancel` is reachable from everything that has not finished. `completed` and
 * `cancelled` are terminal, and the database trigger enforces that too.
 */
export const AUCTION_TRANSITIONS = {
  submit: { to: 'pending_approval', from: ['draft'] },
  approve: { to: 'scheduled', from: ['pending_approval'] },
  /** Rejection returns the auction to its seller to edit and resubmit. */
  reject: { to: 'draft', from: ['pending_approval'] },
  open: { to: 'live', from: ['scheduled'] },
  close: { to: 'closing', from: ['live'] },
  /**
   * The Phase 4 → Phase 5/6 boundary. Phase 4 moves an auction to `closing`
   * and stops; whatever computes the result owns `closing → calculating` and
   * `calculating → completed`, and neither is performed here.
   */
  beginCalculating: { to: 'calculating', from: ['closing'] },
  complete: { to: 'completed', from: ['calculating'] },
  suspend: {
    to: 'suspended',
    from: ['pending_approval', 'scheduled', 'live'],
  },
  cancel: {
    to: 'cancelled',
    from: ['draft', 'pending_approval', 'scheduled', 'live', 'closing', 'suspended'],
  },
} as const satisfies Record<string, { to: AuctionStatus; from: readonly AuctionStatus[] }>;

export type AuctionAction = keyof typeof AUCTION_TRANSITIONS;

/** States a suspension may be resumed back into. */
export const RESUMABLE_STATUSES = ['pending_approval', 'scheduled', 'live'] as const;

/** True once an auction's terms are fixed, because bidders have committed to them. */
export const TERMS_LOCKED_STATUSES = [
  'live',
  'closing',
  'calculating',
  'completed',
  'cancelled',
  'suspended',
] as const satisfies readonly AuctionStatus[];

/** Terminal states. Nothing moves out of these, by table and by trigger. */
export const TERMINAL_STATUSES = ['completed', 'cancelled'] as const satisfies readonly AuctionStatus[];

export function canTransition(action: AuctionAction, from: AuctionStatus): boolean {
  return (AUCTION_TRANSITIONS[action].from as readonly AuctionStatus[]).includes(from);
}

export function allowedFrom(action: AuctionAction): readonly AuctionStatus[] {
  return AUCTION_TRANSITIONS[action].from;
}

export function targetOf(action: AuctionAction): AuctionStatus {
  return AUCTION_TRANSITIONS[action].to;
}

export function termsAreLocked(status: AuctionStatus): boolean {
  return (TERMS_LOCKED_STATUSES as readonly AuctionStatus[]).includes(status);
}

export function isTerminal(status: AuctionStatus): boolean {
  return (TERMINAL_STATUSES as readonly AuctionStatus[]).includes(status);
}

/** True while the auction holds a product unit, and so must release it if it ends early. */
export function holdsInventory(status: AuctionStatus): boolean {
  return status === 'live' || status === 'closing' || status === 'suspended';
}
