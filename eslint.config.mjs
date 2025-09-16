// eslint.config.mjs
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Root flat-config for the monorepo
 * - Lints TS/TSX across server/ and web/
 * - Uses TS-aware no-unused-vars and allows underscore-prefixed args/vars
 * - Enables type-aware rules per workspace tsconfig
 */
export default [
    // Ignore build outputs & deps
    { ignores: ["**/dist/**", "**/node_modules/**", "web/dist/**"] },

    // Base config for all TS/TSX (syntax-level; no type-checking here)
    {
        files: ["**/*.{ts,tsx}"],
        languageOptions: {
            parser: tseslint.parser,
            parserOptions: {
                ecmaVersion: "latest",
                sourceType: "module",
                ecmaFeatures: { jsx: true },
            },
            globals: { ...globals.node, ...globals.browser },
        },
        plugins: { "@typescript-eslint": tseslint.plugin },
        rules: {
            ...js.configs.recommended.rules,
            ...tseslint.configs.recommended.rules,

            // Prefer TS rule and allow underscore-prefixed unused vars/args/catches
            "no-unused-vars": "off",
            "@typescript-eslint/no-unused-vars": [
                "warn",
                {
                    argsIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                    caughtErrorsIgnorePattern: "^_",
                },
            ],
        },
    },

    // SERVER: enable type-aware rules using server/tsconfig.json
    {
        files: ["server/**/*.ts"],
        languageOptions: {
            parser: tseslint.parser,
            parserOptions: {
                project: ["./server/tsconfig.json"],
                // Anchor paths at repo root (where this file lives)
                tsconfigRootDir: new URL(".", import.meta.url),
            },
        },
        rules: {
            ...tseslint.configs.recommendedTypeChecked.rules,
        },
    },

    // WEB: enable type-aware rules using web/tsconfig.json
    {
        files: ["web/src/**/*.{ts,tsx}"],
        languageOptions: {
            parser: tseslint.parser,
            parserOptions: {
                project: ["./web/tsconfig.json"],
                tsconfigRootDir: new URL(".", import.meta.url),
            },
        },
        rules: {
            ...tseslint.configs.recommendedTypeChecked.rules,
        },
    },
];
