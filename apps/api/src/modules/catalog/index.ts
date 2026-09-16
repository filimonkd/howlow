/**
 * The catalog module's public surface.
 *
 * Every catalog mutation in HOWLOW goes through these functions. Nothing
 * outside this directory writes to `sellers`, `categories`, `products`,
 * `product_images` or `inventory_reservations` — not a controller, not a
 * Telegram handler, not the worker — so ownership, slug and inventory rules are
 * enforced by there being exactly one place they could be broken.
 */
export {
  archiveProduct,
  createCategory,
  createImageUploadSlot,
  createProduct,
  deleteProductImage,
  getCategoryBySlug,
  getCategoryTree,
  getOwnedProduct,
  getProduct,
  getProductBySlug,
  getSellerForUser,
  listCategories,
  listProducts,
  MAX_PRODUCT_IMAGES,
  registerSeller,
  reorderProductImages,
  requireApprovedSeller,
  setSellerStatus,
  toCategoryDto,
  toImageDto,
  toProductDto,
  toSellerDto,
  updateCategory,
  updateProduct,
} from './catalogService.js';
export type { ProductPageResult } from './catalogService.js';

export { reconcileProductInventory, releaseUnit, reserveUnit, reserveUnitStandalone } from './inventory.js';
export type { InventoryReport, ReleaseOutcome, ReservationOutcome } from './inventory.js';

export { CATALOG_ERRORS } from './errors.js';
export type { CatalogErrorCode } from './errors.js';

export { availableQuantity } from './types.js';
export type {
  CategoryRecord,
  ProductImageRecord,
  ProductRecord,
  ProductWithImages,
  ReservationRecord,
  ReservationState,
  SellerRecord,
} from './types.js';
