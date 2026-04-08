import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import nodePlugin from "eslint-plugin-n";
import promise from "eslint-plugin-promise";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import unicorn from "eslint-plugin-unicorn";
import vitest from "@vitest/eslint-plugin";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/*.js",
      "**/*.cjs",
      "**/*.mjs",
      "**/*.config.ts",
      "**/.wrangler/**",
    ],
  },

  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  unicorn.configs["flat/recommended"],
  nodePlugin.configs["flat/recommended-module"],
  promise.configs["flat/recommended"],
  prettier,

  {
    plugins: { "simple-import-sort": simpleImportSort },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    settings: {
      node: { version: ">=22.0.0" },
    },
    rules: {
      // Import sorting
      "simple-import-sort/imports": "error",
      "simple-import-sort/exports": "error",

      // Unicorn tuning
      "unicorn/prevent-abbreviations": [
        "error",
        {
          allowList: {
            args: true,
            ctx: true,
            db: true,
            Db: true,
            def: true,
            dir: true,
            Dir: true,
            env: true,
            Env: true,
            fn: true,
            params: true,
            Params: true,
            props: true,
            Props: true,
            ref: true,
            Ref: true,
            res: true,
          },
        },
      ],
      "unicorn/no-process-exit": "off", // CLI needs process.exit
      "unicorn/import-style": "off", // Named imports from node: modules are clearer
      "unicorn/no-array-reduce": "off", // Reduce is fine for simple accumulators
      "unicorn/no-useless-undefined": "off", // Explicit undefined needed for required params

      // Ban unsafe type escapes
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-non-null-assertion": "error",

      // Prefer stricter patterns
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports" },
      ],
      "@typescript-eslint/restrict-template-expressions": [
        "warn",
        { allowNumber: true },
      ],

      // Allow underscore-prefixed unused vars
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      // Prefer type over interface
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],

      // Async safety
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",

      // Node plugin tuning
      "n/no-missing-import": "off", // TypeScript handles module resolution
      "n/no-unpublished-import": "off", // Monorepo root devDeps (vitest, etc.)
      "n/no-extraneous-import": "off", // pnpm workspace hoisting handles this
      "n/no-process-exit": "off", // CLI needs process.exit (unicorn covers this)
      "n/no-unsupported-features/node-builtins": "off", // Web APIs (fetch, Response, crypto) are runtime-provided

      // Pragmatic relaxations
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: false },
      ],
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/no-unnecessary-type-conversion": "off",
      "@typescript-eslint/no-deprecated": "error",
    },
  },

  // React: PascalCase filenames are convention
  {
    files: ["**/*.tsx"],
    rules: {
      "unicorn/filename-case": ["error", { cases: { pascalCase: true, kebabCase: true } }],
    },
  },

  // Tests: vitest rules + allow non-null assertions (guarded by expect)
  {
    files: ["**/*.test.ts", "**/*.test.tsx"],
    plugins: { vitest },
    rules: {
      ...vitest.configs.recommended.rules,
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },

  // Evals: only relax import sorting (files have established order)
  {
    files: ["evals/**/*.ts"],
    rules: {
      "simple-import-sort/imports": "off",
    },
  },
);
