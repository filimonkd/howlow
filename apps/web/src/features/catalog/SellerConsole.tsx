import { useCallback, useEffect, useState } from 'react';
import type { AuctionSummaryDto, CategoryTreeDto, ProductDto } from '@howlow/shared';
import * as api from '../../lib/catalog-api.js';
import { Button, Field, Notice, Panel, useForm } from '../../components/AuthForms.js';
import { StatusBadge, money } from '../auctions/AuctionCard.js';

/**
 * A seller's products and auctions.
 *
 * Every refusal shown here comes from the API: ownership, slug collisions, SKU
 * duplication, an unwalkable bid ladder and stock held by live auctions are all
 * decided server-side, so this page reports what it was told rather than
 * re-implementing the rules.
 */
type Feedback = { readonly kind: 'error' | 'info'; readonly message: string } | undefined;

export function SellerConsole(): React.JSX.Element {
  const [products, setProducts] = useState<readonly ProductDto[]>();
  const [auctions, setAuctions] = useState<readonly AuctionSummaryDto[]>();
  const [categories, setCategories] = useState<readonly CategoryTreeDto[]>([]);
  const [feedback, setFeedback] = useState<Feedback>();
  const [loadError, setLoadError] = useState<string>();

  const productForm = useForm({
    title: '',
    description: '',
    retailPriceMajor: '',
    stockQuantity: '1',
    brand: '',
    sku: '',
    categoryId: '',
  });

  const auctionForm = useForm({
    productId: '',
    title: '',
    description: '',
    startsAt: '',
    endsAt: '',
    minBidMajor: '1',
    maxBidMajor: '50',
    incrementMajor: '1',
    maxBidsPerUser: '25',
    bidFeeMajor: '5',
  });

  const reload = useCallback(async (): Promise<void> => {
    setLoadError(undefined);
    try {
      const [productPage, auctionPage] = await Promise.all([
        api.fetchMyProducts(),
        api.fetchMyAuctions(),
      ]);
      setProducts(productPage.products);
      setAuctions(auctionPage.auctions);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : 'Your catalog could not be loaded.');
    }
  }, []);

  useEffect(() => {
    void reload();
    void api.fetchCategories().then(setCategories).catch(() => setCategories([]));
  }, [reload]);

  const run = (action: () => Promise<void>): void => {
    setFeedback(undefined);
    void action().catch((cause: unknown) => {
      setFeedback({
        kind: 'error',
        message: cause instanceof Error ? cause.message : 'That did not work.',
      });
    });
  };

  /**
   * Major units are what a seller types; minor units are what the API takes.
   * Converted with string arithmetic, never a float — `12.34 * 100` is not 1234.
   */
  const toMinor = (major: string): string => {
    const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(major.trim());
    if (!match) throw new Error(`"${major}" is not an amount. Use digits, e.g. 1200 or 1200.50`);
    return `${match[1]}${(match[2] ?? '').padEnd(2, '0')}`;
  };

  return (
    <div className="space-y-4">
      {loadError !== undefined && <Notice kind="error">{loadError}</Notice>}
      {feedback !== undefined && <Notice kind={feedback.kind}>{feedback.message}</Notice>}

      <Panel title="Add a product">
        <p className="mb-3 text-sm opacity-70">
          A product holds the stock. Each auction offers one unit of it, reserved when the auction
          goes live.
        </p>
        <form
          onSubmit={productForm.onSubmit(() => {
            run(async () => {
              const created = await api.createProduct({
                title: productForm.values.title,
                description: productForm.values.description,
                retailPriceMinor: toMinor(productForm.values.retailPriceMajor),
                stockQuantity: Number(productForm.values.stockQuantity),
                condition: 'new',
                ...(productForm.values.brand === '' ? {} : { brand: productForm.values.brand }),
                ...(productForm.values.sku === '' ? {} : { sku: productForm.values.sku }),
                ...(productForm.values.categoryId === ''
                  ? {}
                  : { categoryId: productForm.values.categoryId }),
              });
              productForm.reset();
              setFeedback({
                kind: 'info',
                message: `"${created.title}" created as a draft. Activate it to run an auction.`,
              });
              await reload();
            });
          })}
        >
          <Field label="Title" value={productForm.values.title} onChange={productForm.set('title')} />
          <Field
            label="Description (at least 20 characters)"
            value={productForm.values.description}
            onChange={productForm.set('description')}
          />
          <Field
            label="Reference price (ETB)"
            value={productForm.values.retailPriceMajor}
            onChange={productForm.set('retailPriceMajor')}
            placeholder="120000"
          />
          <Field
            label="Stock"
            value={productForm.values.stockQuantity}
            onChange={productForm.set('stockQuantity')}
          />
          <Field label="Brand (optional)" value={productForm.values.brand} onChange={productForm.set('brand')} />
          <Field label="SKU (optional)" value={productForm.values.sku} onChange={productForm.set('sku')} />
          {categories.length > 0 && (
            <label className="mb-3 block text-sm">
              <span className="mb-1 block opacity-70">Category (optional)</span>
              <select
                className="w-full rounded-md border border-black/15 bg-transparent px-3 py-2 dark:border-white/20"
                value={productForm.values.categoryId}
                onChange={(event) => {
                  productForm.set('categoryId')(event.target.value);
                }}
              >
                <option value="">None</option>
                {categories.flatMap((category) => [
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>,
                  ...category.children.map((child) => (
                    <option key={child.id} value={child.id}>
                      {`— ${child.name}`}
                    </option>
                  )),
                ])}
              </select>
            </label>
          )}
          <Button>Create product</Button>
        </form>
      </Panel>

      <Panel title="Your products">
        {products === undefined ? (
          <p className="text-sm opacity-70">Loading…</p>
        ) : products.length === 0 ? (
          <p className="text-sm opacity-70">
            No products yet. Add one above to start running auctions.
          </p>
        ) : (
          <ul className="divide-y divide-black/10 text-sm dark:divide-white/15">
            {products.map((product) => (
              <li key={product.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <span className="block font-medium">{product.title}</span>
                  <span className="block text-xs opacity-60">
                    {product.status} · stock {product.stockQuantity} · {product.reservedQuantity}{' '}
                    reserved · {money(product.retailPriceMinor, product.currency)}
                  </span>
                </span>
                <span className="flex gap-2">
                  {product.status === 'draft' && (
                    <Button
                      variant="secondary"
                      onClick={() => {
                        run(async () => {
                          await api.updateProduct(product.id, { status: 'active' });
                          setFeedback({ kind: 'info', message: `"${product.title}" is now active.` });
                          await reload();
                        });
                      }}
                    >
                      Activate
                    </Button>
                  )}
                  {product.status !== 'archived' && (
                    <Button
                      variant="secondary"
                      onClick={() => {
                        run(async () => {
                          await api.archiveProduct(product.id);
                          setFeedback({ kind: 'info', message: `"${product.title}" archived.` });
                          await reload();
                        });
                      }}
                    >
                      Archive
                    </Button>
                  )}
                  <ImageUpload
                    productId={product.id}
                    onDone={(message) => {
                      setFeedback(message);
                      void reload();
                    }}
                  />
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Create an auction">
        <p className="mb-3 text-sm opacity-70">
          The bid range must divide evenly by the increment, or the highest bid would be one nobody
          could place.
        </p>
        <form
          onSubmit={auctionForm.onSubmit(() => {
            run(async () => {
              await api.createAuction({
                productId: auctionForm.values.productId,
                title: auctionForm.values.title,
                description: auctionForm.values.description,
                startsAt: new Date(auctionForm.values.startsAt).toISOString(),
                endsAt: new Date(auctionForm.values.endsAt).toISOString(),
                minBidMinor: toMinor(auctionForm.values.minBidMajor),
                maxBidMinor: toMinor(auctionForm.values.maxBidMajor),
                bidIncrementMinor: toMinor(auctionForm.values.incrementMajor),
                maxBidsPerUser: Number(auctionForm.values.maxBidsPerUser),
                bidFeeMinor: toMinor(auctionForm.values.bidFeeMajor),
              });
              auctionForm.reset();
              setFeedback({
                kind: 'info',
                message: 'Auction created as a draft. Submit it for review when you are ready.',
              });
              await reload();
            });
          })}
        >
          <label className="mb-3 block text-sm">
            <span className="mb-1 block opacity-70">Product (must be active)</span>
            <select
              className="w-full rounded-md border border-black/15 bg-transparent px-3 py-2 dark:border-white/20"
              value={auctionForm.values.productId}
              onChange={(event) => {
                auctionForm.set('productId')(event.target.value);
              }}
            >
              <option value="">Choose a product</option>
              {(products ?? [])
                .filter((product) => product.status === 'active')
                .map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.title}
                  </option>
                ))}
            </select>
          </label>
          <Field label="Auction title" value={auctionForm.values.title} onChange={auctionForm.set('title')} />
          <Field
            label="Description"
            value={auctionForm.values.description}
            onChange={auctionForm.set('description')}
          />
          <Field
            label="Starts at"
            type="datetime-local"
            value={auctionForm.values.startsAt}
            onChange={auctionForm.set('startsAt')}
          />
          <Field
            label="Ends at"
            type="datetime-local"
            value={auctionForm.values.endsAt}
            onChange={auctionForm.set('endsAt')}
          />
          <Field
            label="Minimum bid (ETB)"
            value={auctionForm.values.minBidMajor}
            onChange={auctionForm.set('minBidMajor')}
          />
          <Field
            label="Maximum bid (ETB)"
            value={auctionForm.values.maxBidMajor}
            onChange={auctionForm.set('maxBidMajor')}
          />
          <Field
            label="Increment (ETB)"
            value={auctionForm.values.incrementMajor}
            onChange={auctionForm.set('incrementMajor')}
          />
          <Field
            label="Bids per person"
            value={auctionForm.values.maxBidsPerUser}
            onChange={auctionForm.set('maxBidsPerUser')}
          />
          <Field
            label="Participation fee per bid (ETB, 0 for free)"
            value={auctionForm.values.bidFeeMajor}
            onChange={auctionForm.set('bidFeeMajor')}
          />
          <Button>Create auction</Button>
        </form>
      </Panel>

      <Panel title="Your auctions">
        {auctions === undefined ? (
          <p className="text-sm opacity-70">Loading…</p>
        ) : auctions.length === 0 ? (
          <p className="text-sm opacity-70">No auctions yet.</p>
        ) : (
          <ul className="divide-y divide-black/10 text-sm dark:divide-white/15">
            {auctions.map((auction) => (
              <li key={auction.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <span className="block font-medium">{auction.title}</span>
                  <span className="block text-xs opacity-60">
                    {auction.productTitle} · ends {new Date(auction.endsAt).toLocaleString()}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <StatusBadge status={auction.status} />
                  {auction.status === 'draft' && (
                    <Button
                      onClick={() => {
                        run(async () => {
                          await api.submitAuction(auction.id);
                          setFeedback({ kind: 'info', message: 'Sent for review.' });
                          await reload();
                        });
                      }}
                    >
                      Submit for review
                    </Button>
                  )}
                  {(auction.status === 'draft' || auction.status === 'pending_approval') && (
                    <Button
                      variant="secondary"
                      onClick={() => {
                        run(async () => {
                          await api.cancelMyAuction(auction.id, 'Withdrawn by the seller');
                          setFeedback({ kind: 'info', message: 'Auction withdrawn.' });
                          await reload();
                        });
                      }}
                    >
                      Withdraw
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

/**
 * Upload one image.
 *
 * The file goes straight to storage using the presigned slot the API issues;
 * the bytes never pass through HOWLOW's API.
 */
function ImageUpload({
  productId,
  onDone,
}: {
  readonly productId: string;
  readonly onDone: (feedback: Feedback) => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);

  return (
    <label className="cursor-pointer rounded-md border border-black/15 px-3 py-2 text-sm dark:border-white/20">
      {busy ? 'Uploading…' : 'Add image'}
      <input
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        disabled={busy}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file === undefined) return;
          setBusy(true);
          void api
            .uploadProductImage({ productId, file, altText: file.name })
            .then(() => {
              onDone({ kind: 'info', message: 'Image uploaded.' });
            })
            .catch((cause: unknown) => {
              onDone({
                kind: 'error',
                message: cause instanceof Error ? cause.message : 'The image could not be uploaded.',
              });
            })
            .finally(() => {
              setBusy(false);
            });
        }}
      />
    </label>
  );
}
