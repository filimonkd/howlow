import type { Currency, ProductCondition, ProductStatus, SellerStatus } from '@howlow/shared';

/**
 * Internal catalog records.
 *
 * Money is `bigint` throughout; it becomes a decimal string only at the API
 * boundary, and is never a JavaScript `number`.
 */
export interface SellerRecord {
  readonly id: string;
  readonly userId: string;
  readonly displayName: string;
  readonly status: SellerStatus;
  readonly payoutCurrency: Currency;
  readonly commissionBps: number;
  readonly approvedAt: Date | null;
  readonly createdAt: Date;
}

export interface CategoryRecord {
  readonly id: string;
  readonly parentId: string | null;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly position: number;
  readonly isActive: boolean;
}

export interface ProductImageRecord {
  readonly id: string;
  readonly productId: string;
  readonly storageKey: string;
  readonly altText: string | null;
  readonly position: number;
  readonly isPrimary: boolean;
}

export interface ProductRecord {
  readonly id: string;
  readonly sellerId: string;
  readonly sellerName: string;
  readonly categoryId: string | null;
  readonly categorySlug: string | null;
  readonly slug: string;
  readonly title: string;
  readonly description: string | null;
  readonly sku: string | null;
  readonly brand: string | null;
  readonly condition: ProductCondition;
  readonly specs: Record<string, string>;
  readonly currency: Currency;
  readonly retailPriceMinor: bigint;
  readonly stockQuantity: number;
  readonly reservedQuantity: number;
  readonly status: ProductStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A product with its images, as every read surface wants it. */
export interface ProductWithImages extends ProductRecord {
  readonly images: readonly ProductImageRecord[];
}

export type ReservationState = 'held' | 'released' | 'consumed';

export interface ReservationRecord {
  readonly id: string;
  readonly productId: string;
  readonly auctionId: string;
  readonly quantity: number;
  readonly state: ReservationState;
  readonly reason: string | null;
  readonly createdAt: Date;
  readonly releasedAt: Date | null;
}

/** Units free to be reserved right now. */
export function availableQuantity(product: { stockQuantity: number; reservedQuantity: number }): number {
  return product.stockQuantity - product.reservedQuantity;
}
