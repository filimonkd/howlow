import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * HOWLOW architecture enforcement.
 *
 * The invariants in the system design specification are not comments — they
 * are lint rules, and CI fails the pull request when one is broken.
 *
 *   channels/telegram  ⇏  db/          (no direct database access)
 *   channels/http      ⇏  db/          (no direct database access)
 *   channels/telegram  ⇏  channels/http
 *   channels/http      ⇏  channels/telegram
 *   modules/*          ⇏  channels/*   (business logic knows no transport)
 *   anything           ⇏  modules/wallet/walletRepository
 *                                       (only the wallet module moves money)
 *   anything           ⇏  modules/catalog/catalogRepository
 *                                       (only the catalog module reserves stock)
 *   anything           ⇏  modules/auctions/auctionRepository
 *                                       (only the lifecycle service changes status)
 *
 * Channel adapters may import `modules/*` and `shared/*`, and nothing else
 * that carries business meaning.
 */

/**
 * The wallet's SQL is reachable from one directory only.
 *
 * Every balance change must be accompanied by its ledger entry in the same
 * transaction. That is guaranteed by there being exactly one code path that can
 * change a balance — so anything that could bypass `modules/wallet` is a way
 * for the guarantee to be lost, whether it is a controller, a Telegram handler,
 * payment code or an admin tool.
 */
const TRANSPORT_IMPORT_PATTERN = {
  group: ['**/channels', '**/channels/**', 'express', 'grammy', 'grammy/**'],
  message:
    'Business logic must not know about transports. Return data and let the channel adapter format it.',
};

const WALLET_INTERNALS_PATTERN = {
  group: [
    '**/modules/wallet/walletRepository',
    '**/modules/wallet/walletRepository.js',
    '**/wallet/walletRepository',
    '**/wallet/walletRepository.js',
  ],
  message:
    'Only modules/wallet may touch wallet SQL. Call the wallet module (getWallet, credit, debit, refund, adminCredit, adminDebit) instead — every balance change must carry its ledger entry in the same transaction.',
};

/**
 * Catalog SQL is reachable from one directory only.
 *
 * Ownership, slug uniqueness and — most importantly — inventory reservation
 * are guaranteed by there being exactly one code path that can change them.
 * Anything that could bypass `modules/catalog` is a way for a product unit to
 * be promised twice.
 */
const CATALOG_INTERNALS_PATTERN = {
  group: [
    '**/modules/catalog/catalogRepository',
    '**/modules/catalog/catalogRepository.js',
    '**/catalog/catalogRepository',
    '**/catalog/catalogRepository.js',
  ],
  message:
    'Only modules/catalog may touch catalog SQL. Call the catalog module instead — ownership and inventory rules are enforced there, and reserving a unit must go through reserveUnit so it cannot be double-counted.',
};

/**
 * Auction SQL, likewise. Every status change must go through the lifecycle
 * service so the transition table is the only thing deciding what an auction
 * may do next.
 */
const AUCTION_INTERNALS_PATTERN = {
  group: [
    '**/modules/auctions/auctionRepository',
    '**/modules/auctions/auctionRepository.js',
    '**/auctions/auctionRepository',
    '**/auctions/auctionRepository.js',
  ],
  message:
    'Only modules/auctions may touch auction SQL. Call the lifecycle service (submitForApproval, approve, reject, open, close, suspend, resume, cancel) instead — a status set directly bypasses the transition table.',
};

/**
 * Bid SQL, likewise — and this is the one that decides whether people's money
 * is safe. `bids` and `auction_participants` may only be written by the single
 * engine in `modules/bidding`, because a bid inserted without its fee, its
 * participant counter and its auction counter is a corrupt auction rather than
 * a cheap one. Two code paths that could insert a bid would eventually
 * disagree, and what they would disagree about is who won.
 */
const BIDDING_INTERNALS_PATTERN = {
  group: [
    '**/modules/bidding/bidRepository',
    '**/modules/bidding/bidRepository.js',
    '**/bidding/bidRepository',
    '**/bidding/bidRepository.js',
  ],
  message:
    'Only modules/bidding may touch bid SQL. Call bidService.submitBids() instead — it is the only bidding engine, and it carries the fee, the counters and the audit row in the same transaction.',
};

const DB_IMPORT_PATTERNS = [
  {
    group: ['**/db', '**/db/**', '@howlow/api/db'],
    message:
      'Channel adapters must not touch the database. Call an application service in modules/ instead (see apps/api/src/channels/README.md).',
  },
  {
    group: ['pg', 'pg-*', 'postgres', 'node-pg-migrate', 'ioredis', 'bullmq'],
    message:
      'Channel adapters must not open database, cache or queue connections. Call an application service in modules/ instead.',
  },
];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/*.d.ts',
      'migrations/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/dot-notation': ['error', { allowIndexSignaturePropertyAccess: true }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-restricted-globals': [
        'error',
        {
          name: 'parseFloat',
          message: 'Money is never parsed as a float. Use @howlow/shared money helpers.',
        },
      ],
    },
  },

  // ── Architecture: the Telegram channel adapter ───────────────────────────
  {
    files: ['apps/api/src/channels/telegram/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...DB_IMPORT_PATTERNS,
            WALLET_INTERNALS_PATTERN,
            CATALOG_INTERNALS_PATTERN,
            AUCTION_INTERNALS_PATTERN,
            {
              group: ['**/channels/http', '**/channels/http/**', '**/http', '**/http/**'],
              message:
                'Channels are siblings and must not import each other. Move anything shared into modules/ or shared/.',
            },
          ],
        },
      ],
    },
  },

  // ── Architecture: the HTTP (website) channel adapter ─────────────────────
  {
    files: ['apps/api/src/channels/http/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...DB_IMPORT_PATTERNS,
            WALLET_INTERNALS_PATTERN,
            CATALOG_INTERNALS_PATTERN,
            AUCTION_INTERNALS_PATTERN,
            {
              group: ['**/channels/telegram', '**/channels/telegram/**', '**/telegram', '**/telegram/**'],
              message:
                'Channels are siblings and must not import each other. Move anything shared into modules/ or shared/.',
            },
            {
              group: ['grammy', 'grammy/**'],
              message: 'The Telegram SDK belongs to channels/telegram only.',
            },
          ],
        },
      ],
    },
  },

  // ── Architecture: business logic is transport-agnostic ───────────────────
  //
  // Blocks with the same rule name replace rather than merge, so each scope
  // below lists every pattern that applies to it.
  {
    files: ['apps/api/src/modules/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            TRANSPORT_IMPORT_PATTERN,
            WALLET_INTERNALS_PATTERN,
            CATALOG_INTERNALS_PATTERN,
            AUCTION_INTERNALS_PATTERN,
            BIDDING_INTERNALS_PATTERN,
          ],
        },
      ],
    },
  },

  // Each module is the one place its own SQL may be called from, so it keeps
  // the transport rule and its siblings' rules, but not its own.
  {
    files: ['apps/api/src/modules/wallet/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            TRANSPORT_IMPORT_PATTERN,
            CATALOG_INTERNALS_PATTERN,
            AUCTION_INTERNALS_PATTERN,
            BIDDING_INTERNALS_PATTERN,
          ],
        },
      ],
    },
  },
  {
    files: ['apps/api/src/modules/catalog/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            TRANSPORT_IMPORT_PATTERN,
            WALLET_INTERNALS_PATTERN,
            AUCTION_INTERNALS_PATTERN,
            BIDDING_INTERNALS_PATTERN,
          ],
        },
      ],
    },
  },
  {
    files: ['apps/api/src/modules/auctions/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            TRANSPORT_IMPORT_PATTERN,
            WALLET_INTERNALS_PATTERN,
            CATALOG_INTERNALS_PATTERN,
            BIDDING_INTERNALS_PATTERN,
          ],
        },
      ],
    },
  },

  {
    files: ['apps/api/src/modules/bidding/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            TRANSPORT_IMPORT_PATTERN,
            WALLET_INTERNALS_PATTERN,
            CATALOG_INTERNALS_PATTERN,
            AUCTION_INTERNALS_PATTERN,
          ],
        },
      ],
    },
  },

  // ── Architecture: domain SQL stays inside its module ─────────────────────
  {
    files: ['apps/api/src/realtime/**/*.ts', 'apps/worker/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            WALLET_INTERNALS_PATTERN,
            CATALOG_INTERNALS_PATTERN,
            AUCTION_INTERNALS_PATTERN,
            BIDDING_INTERNALS_PATTERN,
          ],
        },
      ],
    },
  },

  // ── The website is a client, not a second backend ────────────────────────
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@howlow/api', '@howlow/api/**', 'pg', 'ioredis', 'bullmq'],
              message:
                'The website is a client. It reaches HOWLOW over HTTP, never by importing the backend.',
            },
          ],
        },
      ],
    },
  },

  // Node-side code: API, worker, shared package, tooling. The web app keeps
  // browser globals only, so a server-only API cannot leak into the client.
  {
    files: [
      'apps/api/**/*.ts',
      'apps/worker/**/*.ts',
      'packages/**/*.ts',
      'scripts/**/*.mjs',
      '*.config.ts',
      'apps/web/vite.config.ts',
      'eslint.config.js',
    ],
    languageOptions: { globals: globals.node },
  },

  // Entrypoints legitimately write to stderr before the logger exists.
  {
    files: ['apps/*/src/index.ts', 'eslint.config.js', '**/*.config.ts'],
    rules: { 'no-console': 'off' },
  },

  // Operational scripts are plain JS: report to stdout, no type information.
  {
    files: ['scripts/**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    rules: { ...tseslint.configs.disableTypeChecked.rules, 'no-console': 'off' },
  },

  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },

  {
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },

  prettier,
);
