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
        { patterns: [TRANSPORT_IMPORT_PATTERN, WALLET_INTERNALS_PATTERN] },
      ],
    },
  },

  // The wallet module is the one place wallet SQL may be called from, so it
  // keeps the transport rule and not the wallet one.
  {
    files: ['apps/api/src/modules/wallet/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [TRANSPORT_IMPORT_PATTERN] }],
    },
  },

  // ── Architecture: only the wallet module moves money ─────────────────────
  {
    files: ['apps/api/src/realtime/**/*.ts', 'apps/worker/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [WALLET_INTERNALS_PATTERN] }],
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
