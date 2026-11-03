// ESLint flat config: @eslint/js recommended plus globals for Node, browsers and Workers.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'dist/', 'test-results/', 'playwright-report/', 'coverage/', '**/*.tmp.mjs'] },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser, ...globals.serviceworker },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-control-regex': 'off',
      'no-useless-escape': 'warn',
    },
  },
  {
    // Browser-only scripts served to the page.
    files: ['public/**/*.js', 'public/**/*.mjs'],
    languageOptions: { sourceType: 'module', globals: { ...globals.browser } },
  },
];
