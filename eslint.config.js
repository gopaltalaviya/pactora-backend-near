// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Lint for the bugs that matter here, type-aware:
 *
 * - a promise nobody awaits (no-floating-promises) is how an error disappears
 *   — the class of bug behind several of this project's worst defects
 *   ("errors swallowed", runs that failed silently);
 * - a promise where a boolean or callback was meant (no-misused-promises);
 * - `await` on something that is not a promise (await-thenable).
 *
 * Style is Prettier's job, not ESLint's.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.d.ts',
      'packages/db/migrations/**',
      'docs/**',
      '.agent-cache/**',
      'artifacts/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: {allowDefaultProject: ['*.config.ts', 'packages/db/drizzle.config.ts']},
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', {checksVoidReturn: {attributes: false}}],
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-unused-vars': ['error', {argsIgnorePattern: '^_', varsIgnorePattern: '^_'}],
      '@typescript-eslint/consistent-type-imports': ['error', {fixStyle: 'inline-type-imports'}],
      '@typescript-eslint/no-explicit-any': 'error',
      eqeqeq: ['error', 'always'],
      // Off: an async signature is often required by an interface or by a
      // Fastify plugin with nothing to await. The dangerous class — a promise
      // nobody awaits — is no-floating-promises, which stays an error.
      '@typescript-eslint/require-await': 'off',
      'no-console': 'off',
    },
  },
  {
    // Tests build fakes by casting on purpose; the unsafe-* family would flag
    // every one of them without catching anything real.
    files: ['**/test/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: './tsconfig.test.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/unbound-method': 'off',
      // Fakes throw and reject with plain values on purpose — that is the case
      // under test — and explicit generics in tests are documentation.
      '@typescript-eslint/only-throw-error': 'off',
      '@typescript-eslint/prefer-promise-reject-errors': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {globals: {...globals.node}, ecmaVersion: 2024, sourceType: 'module'},
    rules: {
      'no-unused-vars': ['error', {argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none'}],
    },
  },
);
