import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import cgw from './scripts/eslint/cgw-rules.mjs';

// Layer rules (ARCHITECTURE.md, "Dependency rules"): doc and workspace import no React and touch
// no DOM, so they run in a worker and in Node; workspace knows nothing of ProseMirror or Tiptap;
// the editor never saves, loads or calls the network.
const noReact = [
  { name: 'react', message: 'This layer imports no React.' },
  { name: 'react-dom', message: 'This layer imports no React.' },
];
const domGlobals = [
  'window',
  'document',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'navigator',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
].map((name) => ({ name, message: 'This layer touches no DOM, storage or network.' }));
const upperLayers = (layer) => ({
  group: ['@cgw/shell', '@cgw/shell/*', '@cgw/editor', '@cgw/editor/*', '@cgw/web'],
  message: `${layer} does not depend on the layers above it.`,
});
const stores = {
  group: ['@cgw/store-web', '@cgw/store-desktop', '@tauri-apps/*'],
  message: 'Only the shell and the app pick a store.',
};

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
  {
    files: ['packages/*/src/**/*.tsx', 'apps/web/src/**/*.tsx'],
    plugins: { cgw },
    rules: { 'cgw/no-untranslated-text': 'error' },
  },
  {
    files: ['packages/workspace/src/**/*.ts'],
    ignores: ['**/*.test.ts', '**/testing/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: noReact,
          patterns: [
            upperLayers('workspace'),
            stores,
            {
              group: ['@cgw/doc', '@tiptap/*', 'prosemirror-*', 'yjs', 'y-*', '@tiptap/y-tiptap'],
              message:
                'workspace stores and moves opaque Yjs bytes; it knows nothing of documents.',
            },
          ],
        },
      ],
      'no-restricted-globals': ['error', ...domGlobals],
    },
  },
  {
    files: ['packages/doc/src/**/*.ts'],
    ignores: ['**/*.test.ts', '**/testing/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: noReact, patterns: [upperLayers('doc'), stores] },
      ],
      'no-restricted-globals': ['error', ...domGlobals],
    },
  },
  {
    files: ['packages/editor/src/**/*.{ts,tsx}'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@cgw/shell', '@cgw/shell/*', '@cgw/web'],
              message: 'The editor does not depend on the shell.',
            },
            stores,
            {
              group: ['@cgw/workspace', '@cgw/workspace/*'],
              message: 'The editor never saves or loads; it is given a Y.Doc and callbacks.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        ...[
          'localStorage',
          'sessionStorage',
          'indexedDB',
          'fetch',
          'XMLHttpRequest',
          'WebSocket',
        ].map((name) => ({ name, message: 'The editor never saves, loads or calls the network.' })),
      ],
    },
  },
);
