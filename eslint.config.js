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
 *
 * Channel adapters may import `modules/*` and `shared/*`, and nothing else
 * that carries business meaning.
 */

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
  {
    files: ['apps/api/src/modules/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/channels', '**/channels/**', 'express', 'grammy', 'grammy/**'],
              message:
                'Business logic must not know about transports. Return data and let the channel adapter format it.',
            },
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
