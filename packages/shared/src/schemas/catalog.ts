import { z } from 'zod';
import { currencySchema, minorAmountSchema } from './common.js';

/**
 * Catalog wire contracts: sellers, categories, products and their images.
 *
 * Money crosses the boundary as a decimal string of minor units, for the same
 * reason as in the wallet: a BIGINT price can exceed 2^53 and `JSON.parse`
 * would silently round it.
 *
 * Identifiers on the wire are always the uuid `id` or the `slug`. There is no
 * sequential internal id to leak.
 */

/** Lowercase, hyphen-separated, matching the database's slug CHECK. */
export const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Slug must be lowercase words separated by hyphens');

/**
 * Derive a slug from a title. Used when a caller supplies none, so a seller is
 * not made to invent URL syntax.
 */
export function slugify(value: string): string {
  return value
    .normalize('NFKD')
    // Strip diacritics so "Téléphone" becomes "telephone" rather than losing the word.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
    .replace(/-+$/g, '');
}

export const SELLER_STATUSES = ['pending', 'approved', 'suspended', 'closed'] as const;
export const sellerStatusSchema = z.enum(SELLER_STATUSES);
export type SellerStatus = z.infer<typeof sellerStatusSchema>;

export const sellerSchema = z.object({
  id: z.uuid(),
  displayName: z.string(),
  status: sellerStatusSchema,
  payoutCurrency: currencySchema,
  approvedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type SellerDto = z.infer<typeof sellerSchema>;

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export const categorySchema = z.object({
  id: z.uuid(),
  parentId: z.uuid().nullable(),
  slug: slugSchema,
  name: z.string(),
  description: z.string().nullable(),
  position: z.number().int().nonnegative(),
  isActive: z.boolean(),
});
export type CategoryDto = z.infer<typeof categorySchema>;

/** A category with its children, for a browsing menu. Two levels is enough for the MVP. */
export const categoryTreeSchema = categorySchema.extend({
  children: z.array(categorySchema),
});
export type CategoryTreeDto = z.infer<typeof categoryTreeSchema>;

export const createCategorySchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: slugSchema.optional(),
  parentId: z.uuid().nullable().optional(),
  description: z.string().trim().max(2000).optional(),
  position: z.number().int().nonnegative().max(10_000).optional(),
});

export const updateCategorySchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    slug: slugSchema.optional(),
    parentId: z.uuid().nullable().optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    position: z.number().int().nonnegative().max(10_000).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'No changes supplied' });

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export const PRODUCT_STATUSES = ['draft', 'active', 'archived'] as const;
export const productStatusSchema = z.enum(PRODUCT_STATUSES);
export type ProductStatus = z.infer<typeof productStatusSchema>;

export const PRODUCT_CONDITIONS = [
  'new',
  'refurbished',
  'used_like_new',
  'used_good',
  'used_fair',
] as const;
export const productConditionSchema = z.enum(PRODUCT_CONDITIONS);
export type ProductCondition = z.infer<typeof productConditionSchema>;

export const productImageSchema = z.object({
  id: z.uuid(),
  /** A time-limited URL. The stored value is a bucket key, never a public URL. */
  url: z.string(),
  altText: z.string().nullable(),
  position: z.number().int().nonnegative(),
  isPrimary: z.boolean(),
});
export type ProductImageDto = z.infer<typeof productImageSchema>;

export const productSchema = z.object({
  id: z.uuid(),
  sellerId: z.uuid(),
  sellerName: z.string(),
  categoryId: z.uuid().nullable(),
  categorySlug: slugSchema.nullable(),
  slug: slugSchema,
  title: z.string(),
  description: z.string().nullable(),
  sku: z.string().nullable(),
  brand: z.string().nullable(),
  condition: productConditionSchema,
  specs: z.record(z.string(), z.string()),
  currency: currencySchema,
  /**
   * Informational product metadata — what the item retails for. It is NOT the
   * auction's winning price, which is whatever the lowest unique bid turns out
   * to be.
   */
  retailPriceMinor: minorAmountSchema,
  stockQuantity: z.number().int().nonnegative(),
  reservedQuantity: z.number().int().nonnegative(),
  availableQuantity: z.number().int().nonnegative(),
  status: productStatusSchema,
  images: z.array(productImageSchema),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ProductDto = z.infer<typeof productSchema>;

/** Positive integer minor amount as a decimal string. */
const positiveMinorAmount = minorAmountSchema.refine(
  (value) => !value.startsWith('-') && value !== '0',
  { message: 'Amount must be greater than zero' },
);

export const createProductSchema = z.object({
  title: z.string().trim().min(3).max(200),
  slug: slugSchema.optional(),
  description: z.string().trim().min(20).max(10_000),
  categoryId: z.uuid().optional(),
  sku: z.string().trim().min(1).max(64).optional(),
  brand: z.string().trim().min(1).max(120).optional(),
  condition: productConditionSchema.default('new'),
  specs: z.record(z.string().min(1).max(60), z.string().min(1).max(500)).default({}),
  currency: currencySchema.default('ETB'),
  retailPriceMinor: positiveMinorAmount,
  stockQuantity: z.number().int().nonnegative().max(1_000_000).default(0),
});

export const updateProductSchema = z
  .object({
    title: z.string().trim().min(3).max(200).optional(),
    slug: slugSchema.optional(),
    description: z.string().trim().min(20).max(10_000).optional(),
    categoryId: z.uuid().nullable().optional(),
    sku: z.string().trim().min(1).max(64).nullable().optional(),
    brand: z.string().trim().min(1).max(120).nullable().optional(),
    condition: productConditionSchema.optional(),
    specs: z.record(z.string().min(1).max(60), z.string().min(1).max(500)).optional(),
    retailPriceMinor: positiveMinorAmount.optional(),
    stockQuantity: z.number().int().nonnegative().max(1_000_000).optional(),
    status: z.enum(['draft', 'active']).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'No changes supplied' });

export const productListQuerySchema = z.object({
  status: productStatusSchema.optional(),
  categorySlug: slugSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(256).optional(),
});

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

/** Image content types accepted for upload. Anything else is refused. */
export const IMAGE_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const imageContentTypeSchema = z.enum(IMAGE_CONTENT_TYPES);
export type ImageContentType = z.infer<typeof imageContentTypeSchema>;

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * Ask for an upload slot. The caller never supplies a storage path — the
 * server generates the key, so a caller cannot write outside its own prefix or
 * overwrite another seller's object.
 */
export const imageUploadRequestSchema = z.object({
  contentType: imageContentTypeSchema,
  sizeBytes: z.number().int().positive().max(MAX_IMAGE_BYTES),
  altText: z.string().trim().min(1).max(300).optional(),
});

export const imageUploadTicketSchema = z.object({
  imageId: z.uuid(),
  uploadUrl: z.string(),
  /** Seconds the upload URL remains valid. */
  expiresInSeconds: z.number().int().positive(),
  method: z.literal('PUT'),
  headers: z.record(z.string(), z.string()),
});
export type ImageUploadTicket = z.infer<typeof imageUploadTicketSchema>;

export const reorderImagesSchema = z.object({
  /** Image ids in their intended display order. The first becomes primary. */
  imageIds: z.array(z.uuid()).min(1).max(20),
});
