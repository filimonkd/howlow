#!/usr/bin/env node
/**
 * Verifies that a migrated database actually contains the schema HOWLOW depends
 * on: every required table, the indexes and constraints that protect money and
 * bids, and the triggers that make ledgers append-only.
 *
 * Run after `npm run migrate`, and in CI on every pull request. It fails loudly
 * rather than reporting a partial schema as healthy.
 */
import process from 'node:process';
import pg from 'pg';

const REQUIRED_TABLES = [
  'users',
  'user_roles',
  'sessions',
  'otp_challenges',
  'telegram_accounts',
  'telegram_link_tokens',
  'sellers',
  'categories',
  'products',
  'product_images',
  'auctions',
  'auction_participants',
  'bids',
  'auction_results',
  'wallets',
  'wallet_entries',
  'orders',
  'payments',
  'payment_events',
  'refunds',
  'shipments',
  'idempotency_keys',
  'notifications',
  'telegram_outbox',
  'notification_preferences',
  'audit_logs',
  'fraud_flags',
];

/** Indexes whose absence would break a correctness guarantee, not just speed. */
const REQUIRED_INDEXES = [
  // The duplicate-bid rule.
  'bids_valid_amount_unique_key',
  'bids_idempotency_key_unique',
  'bids_auction_amount_idx',
  'auction_participants_unique_key',
  'auction_results_auction_id_key',
  'wallets_user_currency_key',
  'wallet_entries_idempotency_key_unique',
  'telegram_accounts_user_id_key',
  'telegram_accounts_telegram_user_id_key',
  'telegram_link_tokens_token_hash_key',
  'telegram_link_tokens_live_key',
  'users_email_active_key',
  'users_phone_active_key',
  'sessions_refresh_token_hash_key',
  'otp_challenges_live_key',
  'idempotency_keys_scope_key_unique',
  'payments_provider_reference_key',
  'payment_events_provider_event_key',
  'orders_auction_id_key',
  'product_images_primary_key',
];

const REQUIRED_CONSTRAINTS = [
  ['auctions', 'auctions_time_range_ordered'],
  ['auctions', 'auctions_bid_range_ordered'],
  ['auctions', 'auctions_algorithm_is_lub_v1'],
  ['auctions', 'auctions_max_bids_per_user_positive'],
  ['bids', 'bids_amount_positive'],
  ['products', 'products_stock_non_negative'],
  ['wallets', 'wallets_available_non_negative'],
  ['wallets', 'wallets_reserved_non_negative'],
  ['wallet_entries', 'wallet_entries_amount_non_zero'],
  ['wallet_entries', 'wallet_entries_balance_non_negative'],
  ['orders', 'orders_total_is_sum_of_parts'],
  ['auction_results', 'auction_results_winner_complete'],
  ['telegram_link_tokens', 'telegram_link_tokens_consumption_consistent'],
];

const REQUIRED_TRIGGERS = [
  ['wallet_entries', 'wallet_entries_append_only'],
  ['audit_logs', 'audit_logs_append_only'],
  ['auction_results', 'auction_results_append_only'],
  ['payment_events', 'payment_events_append_only'],
  ['auctions', 'auctions_enforce_immutability'],
  ['bids', 'bids_enforce_immutability'],
];

/** Money must never be stored as a floating point type. */
const FLOAT_TYPES = ['real', 'double precision'];

const failures = [];
const fail = (message) => failures.push(message);

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('verify-schema: DATABASE_URL is not set');
    process.exit(1);
  }

  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    const { rows: tables } = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const present = new Set(tables.map((r) => r.table_name));
    for (const table of REQUIRED_TABLES) {
      if (!present.has(table)) fail(`missing table: ${table}`);
    }

    const { rows: indexes } = await client.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const indexNames = new Set(indexes.map((r) => r.indexname));
    for (const index of REQUIRED_INDEXES) {
      if (!indexNames.has(index)) fail(`missing index: ${index}`);
    }

    const { rows: constraints } = await client.query(
      `SELECT conrelid::regclass::text AS table_name, conname
       FROM pg_constraint WHERE connamespace = 'public'::regnamespace`,
    );
    const constraintKeys = new Set(constraints.map((r) => `${r.table_name}.${r.conname}`));
    for (const [table, name] of REQUIRED_CONSTRAINTS) {
      if (!constraintKeys.has(`${table}.${name}`)) fail(`missing constraint: ${table}.${name}`);
    }

    const { rows: triggers } = await client.query(
      `SELECT tgrelid::regclass::text AS table_name, tgname
       FROM pg_trigger WHERE NOT tgisinternal`,
    );
    const triggerKeys = new Set(triggers.map((r) => `${r.table_name}.${r.tgname}`));
    for (const [table, name] of REQUIRED_TRIGGERS) {
      if (!triggerKeys.has(`${table}.${name}`)) fail(`missing trigger: ${table}.${name}`);
    }

    // No monetary column may be a float, and every *_minor column must be BIGINT.
    const { rows: columns } = await client.query(
      `SELECT table_name, column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public'`,
    );
    for (const column of columns) {
      if (FLOAT_TYPES.includes(column.data_type)) {
        fail(`floating point column: ${column.table_name}.${column.column_name} (${column.data_type})`);
      }
      if (column.column_name.endsWith('_minor') && column.data_type !== 'bigint') {
        fail(`money column is not BIGINT: ${column.table_name}.${column.column_name} (${column.data_type})`);
      }
    }

    // Every foreign key should be indexed on the referencing side, or deleting a
    // parent row degrades into a sequential scan of the child table.
    const { rows: unindexedFks } = await client.query(`
      SELECT c.conrelid::regclass::text AS table_name, c.conname
      FROM pg_constraint c
      WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
        AND NOT EXISTS (
          SELECT 1 FROM pg_index i
          WHERE i.indrelid = c.conrelid
            AND (i.indkey::smallint[])[0:array_length(c.conkey, 1) - 1] @> c.conkey
        )
    `);
    for (const fk of unindexedFks) {
      console.warn(`  warning: foreign key without a leading index: ${fk.table_name}.${fk.conname}`);
    }

    console.log(
      `verify-schema: ${REQUIRED_TABLES.length} tables, ${REQUIRED_INDEXES.length} indexes, ` +
        `${REQUIRED_CONSTRAINTS.length} constraints, ${REQUIRED_TRIGGERS.length} triggers checked`,
    );
  } finally {
    await client.end();
  }

  if (failures.length > 0) {
    console.error(`\nverify-schema FAILED (${failures.length}):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log('verify-schema: OK');
}

main().catch((error) => {
  console.error(`verify-schema: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
