# HOWLOW catalog

Sellers, categories, products, images and the inventory an auction draws on.

## Sellers

A seller is a row in `sellers` tied to one user. Registration is idempotent —
calling it twice returns the same seller rather than a second one.

| State       | May read own catalog | May add to it |
| ----------- | -------------------- | ------------- |
| `pending`   | yes                  | no            |
| `approved`  | yes                  | yes           |
| `suspended` | yes                  | no            |
| `closed`    | yes                  | no            |

`requireApprovedSeller` is the gate, and it lives in the module rather than at
each call site, so no channel can skip it. A pending seller can see what they
have prepared; they simply cannot publish.

`sellers_approved_when_approved` ties `approved_at` to the status, so the two
move together and a suspended account cannot keep a stale approval date.

### Permissions

| Operation                           | Who                        |
| ----------------------------------- | -------------------------- |
| Manage own products                 | the owning seller          |
| Create and submit own auctions      | the owning approved seller |
| Withdraw own auction before it runs | the owning seller          |
| Approve / reject / suspend / cancel | `auction_manager`, `admin` |
| Change a seller's status            | `auction_manager`, `admin` |
| Manage categories                   | `auction_manager`, `admin` |

Ownership is asserted **in the module**, not only in the route. A seller who
sends another seller's product id gets `PRODUCT_NOT_OWNED` from any channel.
`super_admin` passes every role check, as everywhere else in the platform.

A seller cannot approve their own auction even if they also hold
`auction_manager`: the lifecycle service refuses when the approver is the
auction's creator, because otherwise the review step would be decorative.

## Categories

A two-level tree: roots and their children. Two levels is a deliberate MVP
limit — it is what the navigation renders, and a deeper tree needs breadcrumb
and filtering work no surface asks for yet. Nothing in the schema prevents
more.

- `slug` is unique and shaped by a database CHECK.
- `is_active` retires a category. An inactive category **cannot take new
  products**, but the ones already in it are untouched.
- `position` orders siblings.

### Cycles

A category may not be its own ancestor. `categories_not_own_parent` catches the
direct case; the transitive case is checked in the service with a recursive
ancestor walk, because a cycle would make the tree unwalkable and any recursive
read non-terminating. The walk is depth-capped as a safety net, not as a product
rule.

## Products

A product is the thing being sold and the holder of stock. An auction offers
**one unit** of it.

| Status     | Meaning                                          |
| ---------- | ------------------------------------------------ |
| `draft`    | being prepared; cannot be auctioned              |
| `active`   | sellable; eligible for auction                   |
| `archived` | withdrawn; kept for history, cannot be auctioned |

### Validation

- `slug` unique, lowercase-hyphenated (CHECK).
- `sku` unique **per seller**, not globally — two sellers may legitimately use
  the same internal code. Enforced by a partial unique index, and the database's
  verdict is what the service reports: a pre-check is a claim a concurrent
  insert can falsify.
- `retail_price_minor > 0` (CHECK).
- `stock_quantity >= 0` (CHECK), and it may not be reduced below the units live
  auctions already hold — those are promised to bidders.
- Category must exist and be active.
- Title at least 3 characters, description at least 20.

### Slugs

An omitted slug is derived from the title, with a numeric suffix on collision:
titles collide constantly ("iPhone 16 Pro" from two sellers), and refusing
would make the seller invent a variation for no reason. An **explicitly
supplied** slug is never silently altered — a caller who chose an address is
told it is taken.

### Archival, not deletion

A product referenced by an auction is the description that auction was decided
on. Deleting it would erase the basis of a financial outcome, so products are
archived. Archival is refused while an unfinished auction still depends on the
product (`PRODUCT_IN_USE`); once nothing unfinished remains, the row stays and
the status changes.

### Pagination

Product listings page by keyset on `(created_at, id)`, newest first: the list
grows at the head, so an offset would shift under a reader between pages. The
cursor timestamp is carried as text at full microsecond precision and never
parsed into a `Date` — see the pagination section of
[auctions.md](./auctions.md#pagination) for why a millisecond-truncated cursor
silently drops rows, and what the repositories do instead.

### Reference price

`retail_price_minor` is **product metadata**: what the item retails for. It is
explicitly _not_ the auction's winning price, which is whatever the lowest
unique bid turns out to be. The field invites that confusion, so it is
documented against it in the schema, the wire contract and the UI copy.

## Images

Up to `MAX_PRODUCT_IMAGES` (12) per product. PostgreSQL stores a bucket **key**
and metadata; the bytes live in the S3-compatible bucket and never pass through
the API.

### Uploading

1. The client asks for a slot with a content type and size.
2. The API validates them, writes the `product_images` row, and returns a
   **presigned PUT URL** valid for 15 minutes.
3. The client PUTs the file straight to storage.

The caller never names a storage path — `buildImageKey` builds
`products/<sellerId>/<productId>/<uuid>.<ext>` from server-side values only. So
path traversal and cross-seller overwrites are impossible by construction
rather than filtered out. Content type and length are part of the signature, so
a slot issued for a 2 KB PNG cannot be replayed to push something else.

Accepted types: `image/jpeg`, `image/png`, `image/webp`. Maximum 8 MB.

The row is written **before** the upload, so an abandoned upload leaves a row
pointing at a missing object — visible to the seller and fixable by
re-uploading. The reverse, an orphaned object with no row, would be invisible.

Deletion goes the other way for the same reason: the row first, the object
second. A storage failure is recorded in the audit row rather than thrown,
because unreferenced bytes cost a little disk while a failed row delete would
leave an image the seller believes they removed.

### Ordering

`position` is unique per product and exactly one image is primary, both by
index. Reordering therefore cannot rewrite rows one at a time without
transiently colliding: every row is parked at a high offset first, then written
back in order, inside one transaction. The offset is _added_, not subtracted,
because `position >= 0` is a CHECK — parking below zero fails, which is how
that was found. The first image in the new order becomes primary. A reorder must
list every image on the product, so none is left without a position.

## Inventory

A product holds stock; an auction represents one unit. The unit is reserved when
the auction **goes live**, not when it is created — an auction drafted and never
approved must not hold stock hostage for days.

`inventory_reservations` is the record; `products.reserved_quantity` is a cache
maintained in the same transaction, exactly as the wallet's cached balance is.

    available = stock_quantity - reserved_quantity

| State      | Meaning                                     | Written by |
| ---------- | ------------------------------------------- | ---------- |
| `held`     | a live auction holds the unit               | Phase 4    |
| `released` | returned to stock (cancelled, or no winner) | Phase 4    |
| `consumed` | taken by a fulfilled order                  | Phase 10   |

Phase 4 never writes `consumed`; the state exists so Phase 10 extends this
rather than inventing a parallel mechanism.

### Locking and idempotency

Reservation takes exactly one lock: `SELECT ... FOR UPDATE` on the product row.
That is what makes the availability check sound — two auctions for the same
product queue there rather than both seeing the last unit free.

Reserving is **idempotent**: a partial unique index on held rows means one
auction cannot hold two units, so a replayed `auction.open` returns the existing
hold instead of taking a second. That matters because the worker may run the job
more than once — a retry, or the sweeper racing the scheduled job — and a
double-decrement would silently lose stock.

Releasing is idempotent in the other direction: an auction with no held
reservation is already in the state the caller wants, so releasing reports
"nothing to do" rather than failing. Cancelling an auction that never opened is
a normal thing to do.

`CHECK (reserved_quantity <= stock_quantity)` is the database's own last word on
overselling, behind the lock and the service's check.

### Reconciliation

`reconcileProductInventory` compares the cached count against the held rows. It
**detects and never repairs**, for the same reason wallet reconciliation does: a
disagreement is evidence of a bug, and rewriting the count would destroy the
evidence and could move the product further from the truth. Discrepancies are
audited under `inventory.reconciliation_failed`.

## Error codes

Every catalog failure carries a stable code in `details.catalogError`. A raw
PostgreSQL exception never reaches a client.

| Code                             | HTTP | Meaning                                |
| -------------------------------- | ---- | -------------------------------------- |
| `SELLER_NOT_FOUND`               | 404  | no seller account                      |
| `SELLER_NOT_APPROVED`            | 403  | the account cannot publish yet         |
| `CATEGORY_NOT_FOUND`             | 404  | unknown category                       |
| `CATEGORY_INACTIVE`              | 422  | retired; takes no new products         |
| `CATEGORY_CYCLE`                 | 422  | would make a category its own ancestor |
| `CATEGORY_SLUG_TAKEN`            | 409  | address in use                         |
| `PRODUCT_NOT_FOUND`              | 404  | unknown product                        |
| `PRODUCT_SLUG_TAKEN`             | 409  | address in use                         |
| `PRODUCT_SKU_TAKEN`              | 409  | this seller already uses that SKU      |
| `PRODUCT_NOT_OWNED`              | 403  | belongs to another seller              |
| `PRODUCT_ARCHIVED`               | 422  | withdrawn; cannot be used              |
| `PRODUCT_IN_USE`                 | 409  | an unfinished auction depends on it    |
| `IMAGE_NOT_FOUND`                | 404  | no such image on this product          |
| `IMAGE_LIMIT_REACHED`            | 422  | at the per-product cap                 |
| `INSUFFICIENT_INVENTORY`         | 409  | no unit free to reserve                |
| `INVENTORY_ALREADY_RESERVED`     | 409  | this auction already holds its unit    |
| `INVENTORY_NOT_RESERVED`         | 409  | nothing held to release                |
| `UNAUTHORIZED_CATALOG_OPERATION` | 403  | the actor may not do that              |

## API

Amounts are decimal strings of minor units throughout — a price can exceed 2^53
and `JSON.parse` would silently round a number.

### Public

```
GET /api/v1/categories
GET /api/v1/categories/:slug
```

### Seller

```
GET    /api/v1/seller/products
POST   /api/v1/seller/products
GET    /api/v1/seller/products/:publicId
PATCH  /api/v1/seller/products/:publicId
POST   /api/v1/seller/products/:publicId/archive
POST   /api/v1/seller/products/:publicId/images
PATCH  /api/v1/seller/products/:publicId/images
DELETE /api/v1/seller/products/:publicId/images/:imageId
```

### Staff

```
GET   /api/v1/admin/categories
POST  /api/v1/admin/categories
PATCH /api/v1/admin/categories/:publicId
GET   /api/v1/admin/products
POST  /api/v1/admin/sellers/:publicId/status
```

## Only the catalog module writes catalog SQL

A lint rule, not a convention: `catalogRepository` cannot be imported from a
channel, another module or the worker, and `tests/architecture.test.ts` proves
the rule rejects a violation from each. Inventory reservation is the reason —
a path that bypasses `reserveUnit` can promise one unit to two auctions.

## Testing

```bash
npm run test:db          # the catalog suite, against real PostgreSQL
npm run verify:catalog   # both channel surfaces over HTTP and the webhook
npm run verify:sigv4     # presigning against botocore
```

`tests/db/catalog.test.ts` covers seller approval, category cycles, slug and
SKU rules, ownership refusals, archival, image ordering and every inventory
path including concurrent reservation. See [auctions.md](auctions.md) for the
lifecycle and locking documentation.
