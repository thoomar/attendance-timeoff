// eslint.config.mjs — Ship-it mode (warnings silenced)

import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import pluginImport from 'eslint-plugin-import';
import pluginN from 'eslint-plugin-n';
import pluginPromise from 'eslint-plugin-promise';

export default [
    // 0) Ignore generated and meta/config files
    {
        ignores: [
            '**/node_modules/**',
            '**/dist/**',
            '**/.turbo/**',
            '**/.next/**',
            'coverage/**',
            'web/dist/**',
            'server/dist/**',
            'eslint.config.*',
            'web/vite.config.*',
            'web/tailwind.config.*',
            '**/*.lock',
        ],
    },

    // 1) Base JS recommended rules
    js.configs.recommended,

    // 2) TypeScript recommended rules
    ...tseslint.configs.recommended,

    // 3) Common language + plugin setup
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
            // --- Ship-it mode: silence noisy rules ---
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-unused-vars': 'off',
            '@typescript-eslint/no-namespace': 'off',
            'import/order': 'off',

            // --- Keep the essentials ---
            'import/no-unresolved': 'error',
            'no-console': 'off',
            'promise/catch-or-return': 'warn',
            'no-unused-vars': 'off', // TS plugin covers it if re-enabled
        },
    },

    // 4) Folder-specific globals (optional but nice)
    {
        files: ['server/**/*.{ts,tsx}'],
        languageOptions: { globals: { ...globals.node } },
    },
    {
        files: ['web/**/*.{ts,tsx}'],
        languageOptions: { globals: { ...globals.browser } },
    },
];
