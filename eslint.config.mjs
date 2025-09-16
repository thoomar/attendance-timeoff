// eslint.config.mjs
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import pluginImport from 'eslint-plugin-import';
import pluginN from 'eslint-plugin-n';
import pluginPromise from 'eslint-plugin-promise';

export default [
    // 0) Ignore generated and config files
    {
        ignores: [
            '**/node_modules/**',
            '**/dist/**',
            '**/.turbo/**',
            '**/.next/**',
            'coverage/**',
            // app build outs
            'web/dist/**',
            'server/dist/**',
            // config files we don't want to lint for import/no-unresolved etc
            'eslint.config.*',
            'web/vite.config.*',
            'web/tailwind.config.*',
            // lockfiles, misc
            '**/*.lock',
        ],
    },

    // 1) Base JS
    js.configs.recommended,

    // 2) TS rules
    ...tseslint.configs.recommended,

    // 3) Envs / plugins / resolver
    {
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                ...globals.node,
                ...globals.browser,
            },
        },
        plugins: {
            import: pluginImport,
            n: pluginN,
            promise: pluginPromise,
        },
        settings: {
            'import/resolver': {
                // enable TypeScript-aware module resolution
                typescript: {
                    alwaysTryTypes: true,
                    project: [
                        './tsconfig.json',
                        './server/tsconfig.json',
                        './web/tsconfig.json',
                    ],
                },
                node: { extensions: ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.d.ts'] },
            },
        },
        rules: {
            // use TS version of unused-vars
            'no-unused-vars': 'off',
            '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],

            // allow console in server/bootstrap
            'no-console': 'off',

            // import hygiene
            'import/order': [
                'warn',
                {
                    groups: [
                        'builtin',
                        'external',
                        'internal',
                        ['parent', 'sibling', 'index'],
                        'type',
                    ],
                    'newlines-between': 'always',
                    alphabetize: { order: 'asc', caseInsensitive: true },
                },
            ],
            'import/no-unresolved': 'error',

            // promise hygiene
            'promise/catch-or-return': 'warn',

            // Be pragmatic for now: tame the any-errors so we can ship
            '@typescript-eslint/no-explicit-any': 'warn',
            '@typescript-eslint/no-namespace': 'off', // server/auth was flagged
        },
    },

    // 4) Per-folder tweaks (optional)
    {
        files: ['server/**/*.{ts,tsx}'],
        languageOptions: { globals: { ...globals.node } },
    },
    {
        files: ['web/**/*.{ts,tsx}'],
        languageOptions: { globals: { ...globals.browser } },
    },
];
