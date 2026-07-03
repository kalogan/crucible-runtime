import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Arch-guards (ARCHITECTURE.md constraint #1 and #4), enforced — not hoped for:
//  - core/tools/bench may import provider *types* only, never an implementation
//  - wall-clock and ambient randomness are banned outside host/ (the composition
//    root) and tests; everything else takes an injected Clock/Rng
export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['dist/**', 'node_modules/**', 'benchmarks/**', '*.config.ts'],
  },
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': 'error',
    },
  },
  {
    files: ['src/core/**/*.ts', 'src/tools/**/*.ts', 'src/bench/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/providers/**', '!**/providers/types.js'],
              message:
                'core/tools/bench are provider-blind: import providers/types.js only.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/core/**/*.ts', 'src/tools/**/*.ts', 'src/providers/**/*.ts', 'src/bench/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'Date', property: 'now', message: 'Inject Clock (core/inject.ts).' },
        { object: 'Math', property: 'random', message: 'Inject Rng (core/inject.ts).' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: 'Inject Clock (core/inject.ts).',
        },
      ],
    },
  },
  {
    files: ['src/host/**/*.ts'],
    rules: {
      // The composition root wires real clock/rng/env and owns stdout.
      'no-console': 'off',
    },
  },
);
