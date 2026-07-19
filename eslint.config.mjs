import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'node_modules/**', '*.config.*', 'eslint.config.mjs'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'off',
      eqeqeq: ['error', 'smart']
    }
  },
  {
    // Plain JS scripts (node + playwright page.evaluate callbacks): no type
    // info available, so no-undef would flag node/browser globals.
    files: ['**/*.mjs'],
    rules: { 'no-undef': 'off' }
  }
)
