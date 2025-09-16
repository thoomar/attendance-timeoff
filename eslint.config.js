// eslint.config.js
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default [
    // Ignore build artifacts
    { ignores: ["**/dist/**", "**/node_modules/**", "web/dist/**"] },

    // Base TS/TSX linting
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
        },
    },

    // Server: enable type-checked rules
    {
        files: ["server/**/*.ts"],
        languageOptions: {
            parser: tseslint.parser,
            parserOptions: {
                project: ["./server/tsconfig.json"],
                tsconfigRootDir: new URL(".", import.meta.url),
            },
        },
        rules: {
            ...tseslint.configs.recommendedTypeChecked.rules,
        },
    },

    // Web: enable type-checked rules
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
