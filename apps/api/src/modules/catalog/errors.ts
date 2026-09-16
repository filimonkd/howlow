import { AppError, type ErrorCode } from '@howlow/shared';

/**
 * Stable catalog error codes. Callers and channels branch on these, never on a
 * message, and a raw PostgreSQL exception never reaches a client.
 */
export const CATALOG_ERRORS = [
  'SELLER_NOT_FOUND',
  'SELLER_NOT_APPROVED',
  'CATEGORY_NOT_FOUND',
  'CATEGORY_INACTIVE',
  'CATEGORY_CYCLE',
  'CATEGORY_SLUG_TAKEN',
  'PRODUCT_NOT_FOUND',
  'PRODUCT_SLUG_TAKEN',
  'PRODUCT_SKU_TAKEN',
  'PRODUCT_NOT_OWNED',
  'PRODUCT_ARCHIVED',
  'PRODUCT_IN_USE',
  'IMAGE_NOT_FOUND',
  'IMAGE_LIMIT_REACHED',
  'INSUFFICIENT_INVENTORY',
  'INVENTORY_ALREADY_RESERVED',
  'INVENTORY_NOT_RESERVED',
  'UNAUTHORIZED_CATALOG_OPERATION',
] as const;

export type CatalogErrorCode = (typeof CATALOG_ERRORS)[number];

/** Catalog failures carry their own code in `details.catalogError`. */
function catalogError(
  catalogCode: CatalogErrorCode,
  appCode: ErrorCode,
  message: string,
  publicMessage: string,
  details: Record<string, unknown> = {},
): AppError {
  return new AppError({
    code: appCode,
    message,
    publicMessage,
    details: { catalogError: catalogCode, ...details },
  });
}

export const sellerNotFound = (reference: string): AppError =>
  catalogError(
    'SELLER_NOT_FOUND',
    'NOT_FOUND',
    `No seller for ${reference}`,
    'No seller account could be found.',
  );

export const sellerNotApproved = (status: string): AppError =>
  catalogError(
    'SELLER_NOT_APPROVED',
    'FORBIDDEN',
    `Seller account is ${status}, not approved`,
    'Your seller account is not approved yet.',
  );

export const categoryNotFound = (reference: string): AppError =>
  catalogError(
    'CATEGORY_NOT_FOUND',
    'NOT_FOUND',
    `No category for ${reference}`,
    'That category does not exist.',
  );

export const categoryInactive = (slug: string): AppError =>
  catalogError(
    'CATEGORY_INACTIVE',
    'VALIDATION_FAILED',
    `Category ${slug} is inactive and cannot take new products`,
    'That category is not currently accepting new products.',
  );

/**
 * A category cannot be its own ancestor. Without this a parent cycle would
 * make the tree unwalkable and any recursive read non-terminating.
 */
export const categoryCycle = (slug: string): AppError =>
  catalogError(
    'CATEGORY_CYCLE',
    'VALIDATION_FAILED',
    `Moving category ${slug} there would make it its own ancestor`,
    'A category cannot be placed inside itself.',
  );

export const categorySlugTaken = (slug: string): AppError =>
  catalogError(
    'CATEGORY_SLUG_TAKEN',
    'CONFLICT',
    `Category slug ${slug} is already in use`,
    'That category address is already taken.',
  );

export const productNotFound = (reference: string): AppError =>
  catalogError(
    'PRODUCT_NOT_FOUND',
    'NOT_FOUND',
    `No product for ${reference}`,
    'That product does not exist.',
  );

export const productSlugTaken = (slug: string): AppError =>
  catalogError(
    'PRODUCT_SLUG_TAKEN',
    'CONFLICT',
    `Product slug ${slug} is already in use`,
    'That product address is already taken. Try a different title.',
  );

export const productSkuTaken = (sku: string): AppError =>
  catalogError(
    'PRODUCT_SKU_TAKEN',
    'CONFLICT',
    `SKU ${sku} is already used by another of your products`,
    'You already have a product with that SKU.',
  );

/**
 * Ownership is checked in the module, not only in the route, so a seller can
 * never reach another seller's product through any channel.
 */
export const productNotOwned = (productId: string, sellerId: string): AppError =>
  catalogError(
    'PRODUCT_NOT_OWNED',
    'FORBIDDEN',
    `Product ${productId} does not belong to seller ${sellerId}`,
    'That product belongs to another seller.',
  );

export const productArchived = (productId: string): AppError =>
  catalogError(
    'PRODUCT_ARCHIVED',
    'VALIDATION_FAILED',
    `Product ${productId} is archived`,
    'That product has been archived and cannot be used.',
  );

/**
 * Products referenced by an auction are archived, never deleted: deleting one
 * would erase the description a completed auction was decided on.
 */
export const productInUse = (productId: string, auctionCount: number): AppError =>
  catalogError(
    'PRODUCT_IN_USE',
    'CONFLICT',
    `Product ${productId} is referenced by ${auctionCount} auction(s)`,
    'This product has auction history, so it can be archived but not deleted.',
  );

export const imageNotFound = (imageId: string): AppError =>
  catalogError(
    'IMAGE_NOT_FOUND',
    'NOT_FOUND',
    `No image ${imageId} on this product`,
    'That image does not exist.',
  );

export const imageLimitReached = (limit: number): AppError =>
  catalogError(
    'IMAGE_LIMIT_REACHED',
    'VALIDATION_FAILED',
    `A product may have at most ${limit} images`,
    `A product may have at most ${limit} images.`,
  );

/**
 * The overselling refusal. Raised when no unit is free to reserve, so an
 * auction never goes live against stock that does not exist.
 */
export const insufficientInventory = (input: {
  productId: string;
  requested: number;
  available: number;
}): AppError =>
  catalogError(
    'INSUFFICIENT_INVENTORY',
    'CONFLICT',
    `Product ${input.productId} has ${input.available} unit(s) available, ${input.requested} requested`,
    'This product is out of stock.',
    { available: input.available },
  );

export const inventoryAlreadyReserved = (auctionId: string): AppError =>
  catalogError(
    'INVENTORY_ALREADY_RESERVED',
    'CONFLICT',
    `Auction ${auctionId} already holds a reservation`,
    'This auction already holds its unit.',
  );

export const inventoryNotReserved = (auctionId: string): AppError =>
  catalogError(
    'INVENTORY_NOT_RESERVED',
    'CONFLICT',
    `Auction ${auctionId} holds no reservation to release`,
    'This auction holds no reserved unit.',
  );

export const unauthorizedCatalogOperation = (detail: string): AppError =>
  catalogError(
    'UNAUTHORIZED_CATALOG_OPERATION',
    'FORBIDDEN',
    `Unauthorized catalog operation: ${detail}`,
    'You do not have permission to do that.',
  );
