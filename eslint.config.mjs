import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
    globalIgnores([
        "artifacts/**",
        ".cache/**",
        "corpus/**",
        "dist/**",
        "examples/**",
        "generated/**",
        "native/**",
        "reference/**",
        "test/fixtures/**",
        "ui/**",
        "upstream/**",
    ]),
    {
        files: ["src/**/*.ts", "test/**/*.ts"],
        extends: [
            js.configs.recommended,
            tseslint.configs.recommendedTypeChecked,
        ],
        languageOptions: {
            globals: globals.node,
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            // The strict TypeScript build owns unused locals and parameters.
            "@typescript-eslint/no-unused-vars": "off",
            // Platform adapters retain an async contract even when a branch completes synchronously.
            "@typescript-eslint/require-await": "off",
            "@typescript-eslint/no-empty-object-type": [
                "error",
                { allowInterfaces: "with-single-extends" },
            ],
            "prefer-const": ["error", { ignoreReadBeforeAssign: true }],
            "@typescript-eslint/no-floating-promises": [
                "error",
                {
                    allowForKnownSafeCalls: [
                        {
                            from: "package",
                            package: "node:test",
                            name: ["test", "describe", "it"],
                        },
                    ],
                },
            ],
        },
    },
    {
        files: ["*.mjs", "tools/**/*.mjs", "checks/plugins/*.mjs"],
        extends: [js.configs.recommended],
        languageOptions: {
            globals: globals.node,
        },
    },
    {
        files: ["checks/plugins/*.init.js"],
        extends: [js.configs.recommended],
        languageOptions: {
            globals: globals.browser,
        },
    },
]);
