import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/target/**',
      '**/node_modules/**',
      '**/test-results/**',
      '**/playwright-report/**',
      '**/bin/**',
      '**/obj/**',
      'apps/desktop/src-tauri/gen/**',
      'bench/results/**',
      // A vendored copy of @tiptap/y-tiptap for the Phase 0 harness (bench/editor/vendor).
      'bench/editor/vendor/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: { ...globals.browser, ...globals.node, ...globals.worker } } },
  { files: ['**/*.ts', '**/*.tsx'], rules: { '@typescript-eslint/no-explicit-any': 'error' } },
);
