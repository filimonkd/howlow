import type {
  CategoryDto,
  CategoryTreeDto,
  ImageUploadTicket,
  ProductCondition,
  ProductDto,
  ProductImageDto,
  ProductStatus,
  Role,
  SellerDto,
} from '@howlow/shared';
import { AppError, slugify } from '@howlow/shared';
import { withTransaction, type Tx } from '../../db/index.js';
import { createUploadSlot, deleteObject, readUrl } from '../../storage/index.js';
import { writeAuditLog, type OperationContext } from '../../shared/index.js';
import { hasAnyRole, loadRoles } from '../auth/rbac.js';
import {
  categoryCycle,
  categoryInactive,
  categoryNotFound,
  categorySlugTaken,
  imageLimitReached,
  imageNotFound,
  productArchived,
  productInUse,
  productNotFound,
  productNotOwned,
  productSkuTaken,
  productSlugTaken,
  sellerNotApproved,
  sellerNotFound,
  unauthorizedCatalogOperation,
} from './errors.js';
import * as repo from './catalogRepository.js';
import type { ProductCursor } from './catalogRepository.js';
import {
  availableQuantity,
  type CategoryRecord,
  type ProductImageRecord,
  type ProductRecord,
  type ProductWithImages,
  type SellerRecord,
} from './types.js';

/**
 * The catalog module's operations.
 *
 * **Only this module writes catalog SQL.** Controllers and Telegram handlers
 * call these functions; every ownership rule, slug rule and inventory rule
 * lives here, so both channels reach identical answers and a route added later
 * cannot bypass a check by talking to the database directly.
 */

/** Roles that may manage the catalog on anyone's behalf. */
const CATALOG_STAFF: readonly Role[] = ['auction_manager', 'admin'];
/** A product may carry this many images. Enough for a listing, bounded for the UI. */
export const MAX_PRODUCT_IMAGES = 12;

async function assertStaff(actorUserId: string, operation: string): Promise<void> {
  const roles = await loadRoles(actorUserId);
  if (!hasAnyRole(roles, CATALOG_STAFF)) {
    throw unauthorizedCatalogOperation(`${actorUserId} may not ${operation}`);
  }
}

// ---------------------------------------------------------------------------
// Sellers
// ---------------------------------------------------------------------------

export const toSellerDto = (seller: SellerRecord): SellerDto => ({
  id: seller.id,
  displayName: seller.displayName,
  status: seller.status,
  payoutCurrency: seller.payoutCurrency,
  approvedAt: seller.approvedAt?.toISOString() ?? null,
  createdAt: seller.createdAt.toISOString(),
});

export async function getSellerForUser(userId: string, tx?: Tx): Promise<SellerRecord> {
  const seller = await repo.findSellerByUserId(userId, tx);
  if (!seller) throw sellerNotFound(`user ${userId}`);
  return seller;
}

/**
 * The seller account a write is being made on behalf of.
 *
 * A pending or suspended seller may read their own catalog but may not add to
 * it, so the approval check lives here rather than at each call site.
 */
export async function requireApprovedSeller(userId: string, tx?: Tx): Promise<SellerRecord> {
  const seller = await getSellerForUser(userId, tx);
  if (seller.status !== 'approved') throw sellerNotApproved(seller.status);
  return seller;
}

export async function registerSeller(
  input: { userId: string; displayName: string; legalName?: string | undefined },
  context: OperationContext = {},
): Promise<SellerRecord> {
  const existing = await repo.findSellerByUserId(input.userId);
  if (existing) return existing;

  return withTransaction(async (tx) => {
    const seller = await repo.insertSeller(input, tx);
    await writeAuditLog(
      {
        action: 'seller.registered',
        entityType: 'seller',
        entityId: seller.id,
        actorUserId: input.userId,
        channel: context.channel ?? 'web',
        requestId: context.requestId,
        details: { displayName: seller.displayName, status: seller.status },
      },
      tx,
    );
    return seller;
  });
}

export async function setSellerStatus(input: {
  sellerId: string;
  status: SellerRecord['status'];
  actorUserId: string;
  context?: OperationContext | undefined;
}): Promise<SellerRecord> {
  await assertStaff(input.actorUserId, 'change a seller status');

  return withTransaction(async (tx) => {
    const before = await repo.findSellerById(input.sellerId, tx);
    if (!before) throw sellerNotFound(input.sellerId);

    const seller = await repo.setSellerStatus({ sellerId: input.sellerId, status: input.status }, tx);
    if (!seller) throw sellerNotFound(input.sellerId);

    await writeAuditLog(
      {
        action: 'seller.status_changed',
        entityType: 'seller',
        entityId: seller.id,
        actorUserId: input.actorUserId,
        channel: input.context?.channel ?? 'admin',
        requestId: input.context?.requestId,
        before: { status: before.status },
        details: { status: seller.status },
      },
      tx,
    );
    return seller;
  });
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export const toCategoryDto = (category: CategoryRecord): CategoryDto => ({
  id: category.id,
  parentId: category.parentId,
  slug: category.slug,
  name: category.name,
  description: category.description,
  position: category.position,
  isActive: category.isActive,
});

export async function listCategories(options: { includeInactive?: boolean } = {}): Promise<CategoryRecord[]> {
  return repo.listCategories({ activeOnly: options.includeInactive !== true });
}

/**
 * Categories as a two-level tree.
 *
 * Two levels is a deliberate MVP limit: it is what the navigation shows, and a
 * deeper tree would need breadcrumb and filtering work no surface asks for yet.
 * Nothing in the schema prevents more, so a later phase can deepen it.
 */
export async function getCategoryTree(
  options: { includeInactive?: boolean } = {},
): Promise<CategoryTreeDto[]> {
  const categories = await listCategories(options);
  const roots = categories.filter((category) => category.parentId === null);
  return roots.map((root) => ({
    ...toCategoryDto(root),
    children: categories
      .filter((category) => category.parentId === root.id)
      .map((category) => toCategoryDto(category)),
  }));
}

export async function getCategoryBySlug(slug: string): Promise<CategoryRecord> {
  const category = await repo.findCategoryBySlug(slug);
  if (!category) throw categoryNotFound(slug);
  return category;
}

/**
 * Validate a parent reference.
 *
 * A category may not be its own ancestor: a cycle would make the tree
 * unwalkable and any recursive read non-terminating. The database's
 * `categories_not_own_parent` CHECK catches only the direct case, so the
 * transitive one is checked here.
 */
async function assertParentAcceptable(
  input: { categoryId?: string | undefined; parentId: string; slug: string },
  tx?: Tx,
): Promise<void> {
  const parent = await repo.findCategoryById(input.parentId, tx);
  if (!parent) throw categoryNotFound(input.parentId);

  if (input.categoryId !== undefined) {
    if (parent.id === input.categoryId) throw categoryCycle(input.slug);
    const ancestors = await repo.listAncestorIds(parent.id, tx);
    if (ancestors.includes(input.categoryId)) throw categoryCycle(input.slug);
  }
}

export async function createCategory(input: {
  name: string;
  slug?: string | undefined;
  parentId?: string | null | undefined;
  description?: string | undefined;
  position?: number | undefined;
  actorUserId: string;
  context?: OperationContext | undefined;
}): Promise<CategoryRecord> {
  await assertStaff(input.actorUserId, 'create a category');
  const slug = input.slug ?? slugify(input.name);

  return withTransaction(async (tx) => {
    if (await repo.findCategoryBySlug(slug, tx)) throw categorySlugTaken(slug);
    if (input.parentId !== undefined && input.parentId !== null) {
      await assertParentAcceptable({ parentId: input.parentId, slug }, tx);
    }

    const category = await repo.insertCategory(
      {
        slug,
        name: input.name,
        parentId: input.parentId ?? undefined,
        description: input.description,
        position: input.position,
      },
      tx,
    );
    await writeAuditLog(
      {
        action: 'category.created',
        entityType: 'category',
        entityId: category.id,
        actorUserId: input.actorUserId,
        channel: input.context?.channel ?? 'admin',
        requestId: input.context?.requestId,
        details: { slug: category.slug, name: category.name, parentId: category.parentId },
      },
      tx,
    );
    return category;
  });
}

export async function updateCategory(input: {
  categoryId: string;
  changes: {
    name?: string | undefined;
    slug?: string | undefined;
    parentId?: string | null | undefined;
    description?: string | null | undefined;
    position?: number | undefined;
    isActive?: boolean | undefined;
  };
  actorUserId: string;
  context?: OperationContext | undefined;
}): Promise<CategoryRecord> {
  await assertStaff(input.actorUserId, 'update a category');

  return withTransaction(async (tx) => {
    const before = await repo.findCategoryById(input.categoryId, tx);
    if (!before) throw categoryNotFound(input.categoryId);

    if (input.changes.slug !== undefined && input.changes.slug !== before.slug) {
      const clash = await repo.findCategoryBySlug(input.changes.slug, tx);
      if (clash) throw categorySlugTaken(input.changes.slug);
    }
    if (input.changes.parentId !== undefined && input.changes.parentId !== null) {
      await assertParentAcceptable(
        { categoryId: before.id, parentId: input.changes.parentId, slug: before.slug },
        tx,
      );
    }

    const category = await repo.updateCategory(input.categoryId, input.changes, tx);
    if (!category) throw categoryNotFound(input.categoryId);

    await writeAuditLog(
      {
        action: 'category.updated',
        entityType: 'category',
        entityId: category.id,
        actorUserId: input.actorUserId,
        channel: input.context?.channel ?? 'admin',
        requestId: input.context?.requestId,
        before: { slug: before.slug, isActive: before.isActive, parentId: before.parentId },
        details: { slug: category.slug, isActive: category.isActive, parentId: category.parentId },
      },
      tx,
    );
    return category;
  });
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

/**
 * Presign a read URL for each image.
 *
 * The stored value is a bucket key, never a public URL: the storage host can
 * change, and objects are not world-readable. URLs are minted per response and
 * expire, so a leaked page does not hand out permanent access.
 */
export function toProductDto(product: ProductWithImages): ProductDto {
  return {
    id: product.id,
    sellerId: product.sellerId,
    sellerName: product.sellerName,
    categoryId: product.categoryId,
    categorySlug: product.categorySlug,
    slug: product.slug,
    title: product.title,
    description: product.description,
    sku: product.sku,
    brand: product.brand,
    condition: product.condition,
    specs: product.specs,
    currency: product.currency,
    retailPriceMinor: product.retailPriceMinor.toString(),
    stockQuantity: product.stockQuantity,
    reservedQuantity: product.reservedQuantity,
    availableQuantity: availableQuantity(product),
    status: product.status,
    images: product.images.map(toImageDto),
    createdAt: product.createdAt.toISOString(),
    updatedAt: product.updatedAt.toISOString(),
  };
}

export const toImageDto = (image: ProductImageRecord): ProductImageDto => ({
  id: image.id,
  url: readUrl(image.storageKey),
  altText: image.altText,
  position: image.position,
  isPrimary: image.isPrimary,
});

export async function getProduct(productId: string, tx?: Tx): Promise<ProductWithImages> {
  const product = await repo.findProductById(productId, tx);
  if (!product) throw productNotFound(productId);
  const images = await repo.listImages(product.id, tx);
  return { ...product, images };
}

export async function getProductBySlug(slug: string): Promise<ProductWithImages> {
  const product = await repo.findProductBySlug(slug);
  if (!product) throw productNotFound(slug);
  return { ...product, images: await repo.listImages(product.id) };
}

/**
 * Load a product the acting seller owns.
 *
 * Ownership is enforced here, at the service boundary, so no channel can reach
 * another seller's product — and the refusal is `PRODUCT_NOT_OWNED` rather
 * than a 404, because the caller legitimately knows the id exists (they were
 * given it); pretending otherwise would not hide anything.
 */
export async function getOwnedProduct(
  input: { productId: string; sellerId: string },
  tx?: Tx,
): Promise<ProductRecord> {
  const product = await repo.findProductById(input.productId, tx);
  if (!product) throw productNotFound(input.productId);
  if (product.sellerId !== input.sellerId) {
    throw productNotOwned(input.productId, input.sellerId);
  }
  return product;
}

/**
 * A slug that is free.
 *
 * Titles collide often ("iPhone 16 Pro" from two sellers), so a numeric suffix
 * is appended rather than refusing and making the seller invent a variation.
 * An explicitly supplied slug is never silently altered — a caller who chose
 * an address gets told it is taken.
 */
async function resolveProductSlug(
  input: { desired: string | undefined; title: string },
  tx: Tx,
): Promise<string> {
  if (input.desired !== undefined) {
    if (await repo.findProductBySlug(input.desired, tx)) throw productSlugTaken(input.desired);
    return input.desired;
  }

  const base = slugify(input.title) || 'product';
  for (let suffix = 0; suffix < 50; suffix += 1) {
    const candidate = suffix === 0 ? base : `${base}-${suffix + 1}`;
    if (!(await repo.findProductBySlug(candidate, tx))) return candidate;
  }
  throw productSlugTaken(base);
}

export async function createProduct(input: {
  sellerId: string;
  actorUserId: string;
  title: string;
  slug?: string | undefined;
  description: string;
  categoryId?: string | undefined;
  sku?: string | undefined;
  brand?: string | undefined;
  condition: ProductCondition;
  specs: Record<string, string>;
  currency: ProductRecord['currency'];
  retailPriceMinor: bigint;
  stockQuantity: number;
  context?: OperationContext | undefined;
}): Promise<ProductWithImages> {
  return withTransaction(async (tx) => {
    if (input.categoryId !== undefined) {
      const category = await repo.findCategoryById(input.categoryId, tx);
      if (!category) throw categoryNotFound(input.categoryId);
      // An inactive category is being retired; new products must not be added to it.
      if (!category.isActive) throw categoryInactive(category.slug);
    }

    const slug = await resolveProductSlug({ desired: input.slug, title: input.title }, tx);
    const product = await repo
      .insertProduct(
        {
          sellerId: input.sellerId,
          categoryId: input.categoryId,
          slug,
          title: input.title,
          description: input.description,
          sku: input.sku,
          brand: input.brand,
          condition: input.condition,
          specs: input.specs,
          currency: input.currency,
          retailPriceMinor: input.retailPriceMinor,
          stockQuantity: input.stockQuantity,
        },
        tx,
      )
      .catch(rethrowUniqueViolation(input.sku));

    await writeAuditLog(
      {
        action: 'product.created',
        entityType: 'product',
        entityId: product.id,
        actorUserId: input.actorUserId,
        channel: input.context?.channel ?? 'web',
        requestId: input.context?.requestId,
        details: {
          sellerId: product.sellerId,
          slug: product.slug,
          title: product.title,
          status: product.status,
          stockQuantity: product.stockQuantity,
        },
      },
      tx,
    );
    return { ...product, images: [] };
  });
}

/**
 * Turn the database's unique-violation into the module's own error.
 *
 * The SKU index is per seller and partial, so only the database can decide
 * whether a value collides. Catching its verdict is more truthful than a
 * pre-check, which a concurrent insert could invalidate between check and
 * write. A raw PostgreSQL exception never reaches a client.
 */
function rethrowUniqueViolation(sku: string | undefined) {
  return (error: unknown): never => {
    const constraint =
      typeof error === 'object' && error !== null && 'constraint' in error
        ? String((error as { constraint?: unknown }).constraint)
        : '';
    if (constraint === 'products_seller_sku_key' && sku !== undefined) throw productSkuTaken(sku);
    if (constraint === 'products_slug_key') throw productSlugTaken('that address');
    throw error;
  };
}

export async function updateProduct(input: {
  productId: string;
  sellerId: string;
  actorUserId: string;
  changes: {
    title?: string | undefined;
    slug?: string | undefined;
    description?: string | undefined;
    categoryId?: string | null | undefined;
    sku?: string | null | undefined;
    brand?: string | null | undefined;
    condition?: ProductCondition | undefined;
    specs?: Record<string, string> | undefined;
    retailPriceMinor?: bigint | undefined;
    stockQuantity?: number | undefined;
    status?: Extract<ProductStatus, 'draft' | 'active'> | undefined;
  };
  context?: OperationContext | undefined;
}): Promise<ProductWithImages> {
  return withTransaction(async (tx) => {
    const before = await getOwnedProduct({ productId: input.productId, sellerId: input.sellerId }, tx);
    if (before.status === 'archived') throw productArchived(before.id);

    if (input.changes.slug !== undefined && input.changes.slug !== before.slug) {
      if (await repo.findProductBySlug(input.changes.slug, tx)) {
        throw productSlugTaken(input.changes.slug);
      }
    }
    if (input.changes.categoryId !== undefined && input.changes.categoryId !== null) {
      const category = await repo.findCategoryById(input.changes.categoryId, tx);
      if (!category) throw categoryNotFound(input.changes.categoryId);
      if (!category.isActive) throw categoryInactive(category.slug);
    }

    // Stock may not drop below what live auctions already hold: those units are
    // promised to bidders, and the database CHECK would refuse it anyway.
    if (input.changes.stockQuantity !== undefined) {
      const held = await repo.sumHeldReservations(before.id, tx);
      if (input.changes.stockQuantity < held) {
        throw new AppError({
          code: 'CONFLICT',
          message: `Stock cannot drop to ${input.changes.stockQuantity}; ${held} unit(s) are held by live auctions`,
          publicMessage: `${held} unit(s) are held by live auctions, so stock cannot go below that.`,
          details: { catalogError: 'INSUFFICIENT_INVENTORY', heldQuantity: held },
        });
      }
    }

    const product = await repo
      .updateProduct(before.id, input.changes, tx)
      .catch(rethrowUniqueViolation(input.changes.sku ?? undefined));
    if (!product) throw productNotFound(before.id);

    await writeAuditLog(
      {
        action: 'product.updated',
        entityType: 'product',
        entityId: product.id,
        actorUserId: input.actorUserId,
        channel: input.context?.channel ?? 'web',
        requestId: input.context?.requestId,
        before: { slug: before.slug, status: before.status, stockQuantity: before.stockQuantity },
        details: {
          changed: Object.keys(input.changes),
          slug: product.slug,
          status: product.status,
          stockQuantity: product.stockQuantity,
        },
      },
      tx,
    );
    return { ...product, images: await repo.listImages(product.id, tx) };
  });
}

/**
 * Archive a product.
 *
 * Archival, never deletion. A product referenced by a completed auction is the
 * description that auction was decided on, and deleting it would erase the
 * basis of a financial outcome. `countAuctionsForProduct` is reported in the
 * audit row so the reason is visible later.
 */
export async function archiveProduct(input: {
  productId: string;
  sellerId: string;
  actorUserId: string;
  context?: OperationContext | undefined;
}): Promise<ProductWithImages> {
  return withTransaction(async (tx) => {
    const before = await getOwnedProduct({ productId: input.productId, sellerId: input.sellerId }, tx);

    // An auction that has not finished still depends on this product's terms.
    const active = await repo.countActiveAuctionsForProduct(before.id, tx);
    if (active > 0) throw productInUse(before.id, active);

    const product = await repo.updateProduct(before.id, { status: 'archived' }, tx);
    if (!product) throw productNotFound(before.id);

    await writeAuditLog(
      {
        action: 'product.archived',
        entityType: 'product',
        entityId: product.id,
        actorUserId: input.actorUserId,
        channel: input.context?.channel ?? 'web',
        requestId: input.context?.requestId,
        before: { status: before.status },
        details: {
          status: product.status,
          historicalAuctions: await repo.countAuctionsForProduct(product.id, tx),
        },
      },
      tx,
    );
    return { ...product, images: await repo.listImages(product.id, tx) };
  });
}

export interface ProductPageResult {
  readonly products: ProductWithImages[];
  readonly nextCursor: ProductCursor | null;
}

export async function listProducts(filters: {
  sellerId?: string | undefined;
  status?: ProductStatus | undefined;
  categorySlug?: string | undefined;
  limit: number;
  cursor?: ProductCursor | undefined;
}): Promise<ProductPageResult> {
  const page = await repo.listProducts(filters);
  return { products: await repo.withImages(page.products), nextCursor: page.nextCursor };
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

/**
 * Register an image and hand back a presigned upload slot.
 *
 * The row is written first, so an abandoned upload leaves a row pointing at a
 * missing object rather than an object nobody can find or bill for. The read
 * URL for a missing object simply fails to load, which the seller sees and can
 * fix by re-uploading; the reverse — an orphaned object with no row — would be
 * invisible.
 */
export async function createImageUploadSlot(input: {
  productId: string;
  sellerId: string;
  actorUserId: string;
  contentType: string;
  sizeBytes: number;
  altText?: string | undefined;
  context?: OperationContext | undefined;
}): Promise<ImageUploadTicket> {
  return withTransaction(async (tx) => {
    const product = await getOwnedProduct({ productId: input.productId, sellerId: input.sellerId }, tx);
    if (product.status === 'archived') throw productArchived(product.id);

    const existing = await repo.countImages(product.id, tx);
    if (existing >= MAX_PRODUCT_IMAGES) throw imageLimitReached(MAX_PRODUCT_IMAGES);

    // The key is built from the seller, the product and a fresh uuid — never
    // from anything the caller sent.
    const slot = createUploadSlot({
      sellerId: product.sellerId,
      productId: product.id,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
    });

    const image = await repo.insertImage(
      {
        productId: product.id,
        storageKey: slot.key,
        altText: input.altText,
        position: existing,
        // The first image a product gets is its primary one until reordered.
        isPrimary: existing === 0,
      },
      tx,
    );

    await writeAuditLog(
      {
        action: 'product.image_added',
        entityType: 'product',
        entityId: product.id,
        actorUserId: input.actorUserId,
        channel: input.context?.channel ?? 'web',
        requestId: input.context?.requestId,
        details: {
          imageId: image.id,
          position: image.position,
          isPrimary: image.isPrimary,
          contentType: input.contentType,
          sizeBytes: input.sizeBytes,
        },
      },
      tx,
    );

    return {
      imageId: image.id,
      uploadUrl: slot.uploadUrl,
      expiresInSeconds: slot.expiresInSeconds,
      method: 'PUT',
      headers: slot.headers,
    };
  });
}

/**
 * Remove an image.
 *
 * The row goes first and the object second: a failed object delete leaves
 * unreferenced bytes, which costs a little storage, while a failed row delete
 * would leave an image the seller believes they removed. Storage failures are
 * logged in the audit row rather than thrown.
 */
export async function deleteProductImage(input: {
  productId: string;
  imageId: string;
  sellerId: string;
  actorUserId: string;
  context?: OperationContext | undefined;
}): Promise<void> {
  const removed = await withTransaction(async (tx) => {
    await getOwnedProduct({ productId: input.productId, sellerId: input.sellerId }, tx);
    const image = await repo.findImageById({ productId: input.productId, imageId: input.imageId }, tx);
    if (!image) throw imageNotFound(input.imageId);

    await repo.deleteImage({ productId: input.productId, imageId: input.imageId }, tx);

    // Close the gap the removal left, and make sure a primary still exists.
    const remaining = await repo.listImages(input.productId, tx);
    if (remaining.length > 0) {
      await repo.applyImageOrder(
        { productId: input.productId, imageIds: remaining.map((item) => item.id) },
        tx,
      );
    }
    return image;
  });

  const storage = await deleteObject(removed.storageKey);
  await writeAuditLog({
    action: 'product.image_removed',
    entityType: 'product',
    entityId: input.productId,
    actorUserId: input.actorUserId,
    channel: input.context?.channel ?? 'web',
    requestId: input.context?.requestId,
    details: {
      imageId: input.imageId,
      objectDeleted: storage.deleted,
      ...(storage.reason === undefined ? {} : { storageReason: storage.reason }),
    },
  });
}

/**
 * Apply a new display order. The first image becomes the primary one.
 *
 * Every id must belong to this product and the set must be complete, so a
 * partial list cannot leave images stranded without a position.
 */
export async function reorderProductImages(input: {
  productId: string;
  sellerId: string;
  actorUserId: string;
  imageIds: readonly string[];
  context?: OperationContext | undefined;
}): Promise<ProductImageDto[]> {
  return withTransaction(async (tx) => {
    await getOwnedProduct({ productId: input.productId, sellerId: input.sellerId }, tx);

    const current = await repo.listImages(input.productId, tx);
    const currentIds = new Set(current.map((image) => image.id));
    const requested = new Set(input.imageIds);

    if (requested.size !== input.imageIds.length) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        message: 'The image order repeats an id',
        publicMessage: 'That image order lists the same image twice.',
      });
    }
    for (const id of input.imageIds) {
      if (!currentIds.has(id)) throw imageNotFound(id);
    }
    if (requested.size !== currentIds.size) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        message: `The order lists ${requested.size} of ${currentIds.size} images`,
        publicMessage: 'The new order must list every image on the product.',
      });
    }

    await repo.applyImageOrder({ productId: input.productId, imageIds: input.imageIds }, tx);

    await writeAuditLog(
      {
        action: 'product.images_reordered',
        entityType: 'product',
        entityId: input.productId,
        actorUserId: input.actorUserId,
        channel: input.context?.channel ?? 'web',
        requestId: input.context?.requestId,
        details: { imageCount: input.imageIds.length, primaryImageId: input.imageIds[0] },
      },
      tx,
    );

    return (await repo.listImages(input.productId, tx)).map(toImageDto);
  });
}
