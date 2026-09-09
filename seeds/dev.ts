/**
 * Development seed data.
 *
 * Idempotent: every row is written with a deterministic id and an upsert, so
 * running this repeatedly converges on the same state rather than accumulating
 * duplicates.
 *
 * NO FINANCIAL BALANCES ARE SEEDED. Wallets are created at zero. Money enters a
 * HOWLOW wallet only through the ledger, and inventing a balance here would put
 * a row in `wallets` that no `wallet_entries` history explains — exactly the
 * divergence the ledger exists to make impossible.
 */
import { closePool, closeRedis, withTransaction, type Tx } from '@howlow/api/db';
import { loadConfig } from '@howlow/api/config';

/** Fixed ids keep the seed idempotent and make fixtures quotable in tests. */
const ID = {
  adminUser: '00000000-0000-4000-8000-000000000001',
  sellerUser: '00000000-0000-4000-8000-000000000002',
  buyerUser: '00000000-0000-4000-8000-000000000003',
  seller: '00000000-0000-4000-8000-000000000010',
  categoryElectronics: '00000000-0000-4000-8000-000000000020',
  categoryPhones: '00000000-0000-4000-8000-000000000021',
  categoryAppliances: '00000000-0000-4000-8000-000000000022',
  categoryFashion: '00000000-0000-4000-8000-000000000023',
  productPhone: '00000000-0000-4000-8000-000000000030',
  productLaptop: '00000000-0000-4000-8000-000000000031',
  productFridge: '00000000-0000-4000-8000-000000000032',
  productWatch: '00000000-0000-4000-8000-000000000033',
  auctionLive: '00000000-0000-4000-8000-000000000040',
  auctionScheduled: '00000000-0000-4000-8000-000000000041',
} as const;

/** ETB minor units: 1.00 = 100. */
const etb = (major: number): string => String(BigInt(Math.round(major * 100)));

async function seedUsers(tx: Tx): Promise<void> {
  // password_hash is intentionally NULL: credentials are Phase 2's concern, and
  // seeding a hash here would bake a known-password account into every
  // developer database.
  await tx.query(
    `INSERT INTO users (id, email, display_name, status, email_verified_at, locale)
     VALUES ($1, $2, $3, 'active', now(), 'en'),
            ($4, $5, $6, 'active', now(), 'en'),
            ($7, $8, $9, 'active', now(), 'en')
     ON CONFLICT (id) DO UPDATE
       SET email = EXCLUDED.email, display_name = EXCLUDED.display_name`,
    [
      ID.adminUser,
      'admin@howlow.local',
      'HOWLOW Admin',
      ID.sellerUser,
      'seller@howlow.local',
      'Addis Electronics',
      ID.buyerUser,
      'buyer@howlow.local',
      'Test Buyer',
    ],
  );

  await tx.query(
    `INSERT INTO user_roles (user_id, role) VALUES
       ($1, 'admin'), ($1, 'user'), ($2, 'seller'), ($2, 'user'), ($3, 'user')
     ON CONFLICT (user_id, role) DO NOTHING`,
    [ID.adminUser, ID.sellerUser, ID.buyerUser],
  );

  // Wallets exist so later phases have somewhere to post entries. Zero balance.
  await tx.query(
    `INSERT INTO wallets (user_id, currency) VALUES ($1, 'ETB'), ($2, 'ETB'), ($3, 'ETB')
     ON CONFLICT (user_id, currency) DO NOTHING`,
    [ID.adminUser, ID.sellerUser, ID.buyerUser],
  );
}

async function seedCatalog(tx: Tx): Promise<void> {
  await tx.query(
    `INSERT INTO sellers (id, user_id, display_name, legal_name, status, approved_at, commission_bps)
     VALUES ($1, $2, 'Addis Electronics', 'Addis Electronics PLC', 'approved', now(), 1000)
     ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`,
    [ID.seller, ID.sellerUser],
  );

  await tx.query(
    `INSERT INTO categories (id, parent_id, slug, name, position) VALUES
       ($1, NULL, 'electronics', 'Electronics', 1),
       ($2, $1,   'mobile-phones', 'Mobile Phones', 1),
       ($3, NULL, 'home-appliances', 'Home Appliances', 2),
       ($4, NULL, 'fashion', 'Fashion', 3)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, position = EXCLUDED.position`,
    [ID.categoryElectronics, ID.categoryPhones, ID.categoryAppliances, ID.categoryFashion],
  );

  await tx.query(
    `INSERT INTO products
       (id, seller_id, category_id, slug, title, description,
        currency, retail_price_minor, stock_quantity, status)
     VALUES
       ($1, $5, $6, 'samsung-galaxy-a55', 'Samsung Galaxy A55 128GB',
        'Sealed retail unit with local warranty.', 'ETB', $10, 12, 'active'),
       ($2, $5, $7, 'lenovo-ideapad-slim-3', 'Lenovo IdeaPad Slim 3 16GB/512GB',
        'Ryzen 7, 16GB RAM, 512GB NVMe.', 'ETB', $11, 5, 'active'),
       ($3, $5, $8, 'hisense-fridge-220l', 'Hisense 220L Double Door Refrigerator',
        'A+ rated, two year compressor warranty.', 'ETB', $12, 8, 'active'),
       ($4, $5, $9, 'casio-edifice-ef539d', 'Casio Edifice EF-539D Chronograph',
        'Stainless steel, 100m water resistance.', 'ETB', $13, 20, 'active')
     ON CONFLICT (id) DO UPDATE
       SET title = EXCLUDED.title, retail_price_minor = EXCLUDED.retail_price_minor`,
    [
      ID.productPhone,
      ID.productLaptop,
      ID.productFridge,
      ID.productWatch,
      ID.seller,
      ID.categoryPhones,
      ID.categoryElectronics,
      ID.categoryAppliances,
      ID.categoryFashion,
      etb(32_000),
      etb(78_500),
      etb(46_000),
      etb(12_400),
    ],
  );

  await tx.query(
    `INSERT INTO product_images (product_id, storage_key, alt_text, position, is_primary)
     VALUES
       ($1, 'seed/samsung-galaxy-a55.jpg', 'Samsung Galaxy A55', 0, true),
       ($2, 'seed/lenovo-ideapad-slim-3.jpg', 'Lenovo IdeaPad Slim 3', 0, true),
       ($3, 'seed/hisense-fridge-220l.jpg', 'Hisense 220L refrigerator', 0, true),
       ($4, 'seed/casio-edifice-ef539d.jpg', 'Casio Edifice chronograph', 0, true)
     ON CONFLICT (product_id, position) DO NOTHING`,
    [ID.productPhone, ID.productLaptop, ID.productFridge, ID.productWatch],
  );
}

async function seedAuctions(tx: Tx): Promise<void> {
  // One auction already running and one not yet open, so both the website and
  // the bot have something meaningful to render before Phase 4 exists.
  await tx.query(
    `INSERT INTO auctions
       (id, product_id, seller_id, title, description, currency,
        bid_fee_minor, min_bid_minor, max_bid_minor, bid_increment_minor,
        max_bids_per_user, starts_at, ends_at, status)
     VALUES
       ($1, $3, $5, 'Samsung Galaxy A55 — lowest unique bid',
        'DEVELOPMENT SEED. Lowest unique bid wins.', 'ETB',
        $6, $7, $8, 100, 25, now() - interval '1 hour', now() + interval '23 hours', 'live'),
       ($2, $4, $5, 'Lenovo IdeaPad Slim 3 — lowest unique bid',
        'DEVELOPMENT SEED. Opens tomorrow.', 'ETB',
        $9, $10, $11, 100, 40, now() + interval '1 day', now() + interval '3 days', 'scheduled')
     ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title`,
    [
      ID.auctionLive,
      ID.auctionScheduled,
      ID.productPhone,
      ID.productLaptop,
      ID.seller,
      etb(5),
      etb(1),
      etb(500),
      etb(10),
      etb(1),
      etb(1_000),
    ],
  );
}

async function main(): Promise<void> {
  const env = loadConfig();
  if (env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed a production database');
  }

  await withTransaction(async (tx) => {
    await seedUsers(tx);
    await seedCatalog(tx);
    await seedAuctions(tx);
  });

  process.stdout.write(
    'Seeded: 3 users (admin, seller, buyer), 1 seller, 4 categories, 4 products,\n' +
      '        4 images, 2 auctions (1 live, 1 scheduled), 3 wallets at zero balance.\n' +
      'No balances were seeded: money enters a wallet only through the ledger.\n',
  );
}

main()
  .then(async () => {
    await Promise.allSettled([closePool(), closeRedis()]);
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    await Promise.allSettled([closePool(), closeRedis()]);
    process.exit(1);
  });
