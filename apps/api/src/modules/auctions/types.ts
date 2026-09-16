import type { AuctionStatus, Currency, ProductCondition } from '@howlow/shared';

/** Internal auction records. Money is `bigint` throughout. */
export interface AuctionTerms {
  readonly currency: Currency;
  readonly minBidMinor: bigint;
  readonly maxBidMinor: bigint;
  readonly bidIncrementMinor: bigint;
  readonly maxBidsPerUser: number;
  /** Charged per bid. The specification calls this the participation fee. */
  readonly bidFeeMinor: bigint;
  readonly winnerPaymentHours: number;
}

export interface AuctionRecord extends AuctionTerms {
  readonly id: string;
  readonly productId: string;
  readonly sellerId: string;
  readonly slug: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly shippingNote: string | null;
  readonly status: AuctionStatus;
  readonly quantity: number;
  readonly algorithmVersion: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly createdBy: string | null;
  readonly submittedAt: Date | null;
  readonly approvedBy: string | null;
  readonly approvedAt: Date | null;
  readonly rejectedAt: Date | null;
  readonly rejectionReason: string | null;
  readonly openedAt: Date | null;
  readonly closingAt: Date | null;
  readonly closedAt: Date | null;
  readonly suspendedAt: Date | null;
  readonly suspendReason: string | null;
  readonly suspendedFrom: AuctionStatus | null;
  readonly cancelledAt: Date | null;
  readonly cancelReason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The product and seller facts a listing or detail page shows alongside an auction. */
export interface AuctionDisplay {
  readonly sellerName: string;
  readonly categorySlug: string | null;
  readonly productTitle: string;
  readonly productDescription: string | null;
  readonly productBrand: string | null;
  readonly productCondition: ProductCondition;
  readonly productSpecs: Record<string, string>;
  readonly retailPriceMinor: bigint;
}

export interface AuctionWithDisplay extends AuctionRecord, AuctionDisplay {}
