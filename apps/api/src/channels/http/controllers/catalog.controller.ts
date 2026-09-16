import type { Request, Response } from 'express';
import {
  createCategorySchema,
  createProductSchema,
  imageUploadRequestSchema,
  productListQuerySchema,
  reorderImagesSchema,
  sellerStatusChangeSchema,
  updateCategorySchema,
  updateProductSchema,
} from '@howlow/shared';
import * as catalog from '../../../modules/catalog/index.js';
import { requireAuth } from '../middleware/authenticate.js';
import { decodeCursor, encodeCursor, operationContext, uuidParam } from './http-helpers.js';

/**
 * Catalog endpoints.
 *
 * These contain no business logic: they read the caller, validate the request
 * shape, call the module and serialise the result. Every ownership rule, slug
 * rule and inventory rule lives in the module, so the Telegram channel reaches
 * identical behaviour by calling the same functions.
 */

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

export async function listCategories(_req: Request, res: Response): Promise<void> {
  res.status(200).json({ categories: await catalog.getCategoryTree() });
}

export async function getCategory(req: Request, res: Response): Promise<void> {
  const category = await catalog.getCategoryBySlug(slugParam(req));
  res.status(200).json(catalog.toCategoryDto(category));
}

/** A slug is a public reference, so it is read as a path segment, not an id. */
function slugParam(req: Request): string {
  const value = req.params['slug'];
  return typeof value === 'string' ? value : '';
}

// ---------------------------------------------------------------------------
// Seller products
// ---------------------------------------------------------------------------

export async function listMyProducts(req: Request, res: Response): Promise<void> {
  const { userId } = requireAuth(req);
  const seller = await catalog.getSellerForUser(userId);
  const query = productListQuerySchema.parse(req.query);

  const page = await catalog.listProducts({
    sellerId: seller.id,
    status: query.status,
    categorySlug: query.categorySlug,
    limit: query.limit,
    ...(query.cursor === undefined ? {} : { cursor: decodeProductCursor(query.cursor) }),
  });

  res.status(200).json({
    products: page.products.map(catalog.toProductDto),
    nextCursor: page.nextCursor === null ? null : encodeProductCursor(page.nextCursor),
  });
}

export async function getMyProduct(req: Request, res: Response): Promise<void> {
  const { userId } = requireAuth(req);
  const seller = await catalog.getSellerForUser(userId);
  // Ownership is asserted by the module, not by the route.
  await catalog.getOwnedProduct({ productId: uuidParam(req, 'publicId'), sellerId: seller.id });
  res.status(200).json(catalog.toProductDto(await catalog.getProduct(uuidParam(req, 'publicId'))));
}

export async function createProduct(req: Request, res: Response): Promise<void> {
  const { userId } = requireAuth(req);
  const seller = await catalog.requireApprovedSeller(userId);
  const body = createProductSchema.parse(req.body);

  const product = await catalog.createProduct({
    sellerId: seller.id,
    actorUserId: userId,
    title: body.title,
    description: body.description,
    condition: body.condition,
    specs: body.specs,
    currency: body.currency,
    retailPriceMinor: BigInt(body.retailPriceMinor),
    stockQuantity: body.stockQuantity,
    ...(body.slug === undefined ? {} : { slug: body.slug }),
    ...(body.categoryId === undefined ? {} : { categoryId: body.categoryId }),
    ...(body.sku === undefined ? {} : { sku: body.sku }),
    ...(body.brand === undefined ? {} : { brand: body.brand }),
    context: operationContext(req, 'web'),
  });

  res.status(201).json(catalog.toProductDto(product));
}

export async function updateProduct(req: Request, res: Response): Promise<void> {
  const { userId } = requireAuth(req);
  const seller = await catalog.getSellerForUser(userId);
  const body = updateProductSchema.parse(req.body);

  // The price arrives as a decimal string and becomes bigint here; spreading
  // the body wholesale would carry the string through as well.
  const { retailPriceMinor, ...rest } = body;
  const product = await catalog.updateProduct({
    productId: uuidParam(req, 'publicId'),
    sellerId: seller.id,
    actorUserId: userId,
    changes: {
      ...rest,
      ...(retailPriceMinor === undefined ? {} : { retailPriceMinor: BigInt(retailPriceMinor) }),
    },
    context: operationContext(req, 'web'),
  });

  res.status(200).json(catalog.toProductDto(product));
}

export async function archiveProduct(req: Request, res: Response): Promise<void> {
  const { userId } = requireAuth(req);
  const seller = await catalog.getSellerForUser(userId);
  const product = await catalog.archiveProduct({
    productId: uuidParam(req, 'publicId'),
    sellerId: seller.id,
    actorUserId: userId,
    context: operationContext(req, 'web'),
  });
  res.status(200).json(catalog.toProductDto(product));
}

// ---------------------------------------------------------------------------
// Product images
// ---------------------------------------------------------------------------

/**
 * Hand back a presigned upload slot.
 *
 * The response is a URL the browser PUTs to directly. The caller never names a
 * storage path — the server generates the key — so there is no request shape
 * in which one seller could write over another's object.
 */
export async function createImageUploadSlot(req: Request, res: Response): Promise<void> {
  const { userId } = requireAuth(req);
  const seller = await catalog.requireApprovedSeller(userId);
  const body = imageUploadRequestSchema.parse(req.body);

  const ticket = await catalog.createImageUploadSlot({
    productId: uuidParam(req, 'publicId'),
    sellerId: seller.id,
    actorUserId: userId,
    contentType: body.contentType,
    sizeBytes: body.sizeBytes,
    ...(body.altText === undefined ? {} : { altText: body.altText }),
    context: operationContext(req, 'web'),
  });

  res.status(201).json(ticket);
}

export async function deleteImage(req: Request, res: Response): Promise<void> {
  const { userId } = requireAuth(req);
  const seller = await catalog.getSellerForUser(userId);
  await catalog.deleteProductImage({
    productId: uuidParam(req, 'publicId'),
    imageId: uuidParam(req, 'imageId'),
    sellerId: seller.id,
    actorUserId: userId,
    context: operationContext(req, 'web'),
  });
  res.status(204).end();
}

export async function reorderImages(req: Request, res: Response): Promise<void> {
  const { userId } = requireAuth(req);
  const seller = await catalog.getSellerForUser(userId);
  const body = reorderImagesSchema.parse(req.body);

  const images = await catalog.reorderProductImages({
    productId: uuidParam(req, 'publicId'),
    sellerId: seller.id,
    actorUserId: userId,
    imageIds: body.imageIds,
    context: operationContext(req, 'web'),
  });
  res.status(200).json({ images });
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export async function listAllCategories(_req: Request, res: Response): Promise<void> {
  res.status(200).json({ categories: await catalog.getCategoryTree({ includeInactive: true }) });
}

export async function createCategory(req: Request, res: Response): Promise<void> {
  const { userId } = requireAuth(req);
  const body = createCategorySchema.parse(req.body);

  const category = await catalog.createCategory({
    name: body.name,
    actorUserId: userId,
    ...(body.slug === undefined ? {} : { slug: body.slug }),
    ...(body.parentId === undefined ? {} : { parentId: body.parentId }),
    ...(body.description === undefined ? {} : { description: body.description }),
    ...(body.position === undefined ? {} : { position: body.position }),
    context: operationContext(req, 'admin'),
  });
  res.status(201).json(catalog.toCategoryDto(category));
}

export async function updateCategory(req: Request, res: Response): Promise<void> {
  const { userId } = requireAuth(req);
  const body = updateCategorySchema.parse(req.body);

  const category = await catalog.updateCategory({
    categoryId: uuidParam(req, 'publicId'),
    changes: body,
    actorUserId: userId,
    context: operationContext(req, 'admin'),
  });
  res.status(200).json(catalog.toCategoryDto(category));
}

export async function listAllProducts(req: Request, res: Response): Promise<void> {
  const query = productListQuerySchema.parse(req.query);
  const page = await catalog.listProducts({
    status: query.status,
    categorySlug: query.categorySlug,
    limit: query.limit,
    ...(query.cursor === undefined ? {} : { cursor: decodeProductCursor(query.cursor) }),
  });
  res.status(200).json({
    products: page.products.map(catalog.toProductDto),
    nextCursor: page.nextCursor === null ? null : encodeProductCursor(page.nextCursor),
  });
}

export async function setSellerStatus(req: Request, res: Response): Promise<void> {
  const { userId } = requireAuth(req);
  const body = sellerStatusChangeSchema.parse(req.body);

  const seller = await catalog.setSellerStatus({
    sellerId: uuidParam(req, 'publicId'),
    status: body.status,
    actorUserId: userId,
    context: operationContext(req, 'admin'),
  });
  res.status(200).json(catalog.toSellerDto(seller));
}

// ---------------------------------------------------------------------------
// Cursors
// ---------------------------------------------------------------------------

/**
 * Product cursors are opaque, like the wallet's: an encoded position, not an
 * offset. The list grows at the head, so an offset would shift under a reader.
 */
const encodeProductCursor = (cursor: { createdAt: string; id: string }): string =>
  encodeCursor({ at: cursor.createdAt, id: cursor.id });

const decodeProductCursor = (value: string): { createdAt: string; id: string } => {
  const cursor = decodeCursor(value);
  return { createdAt: cursor.at, id: cursor.id };
};
