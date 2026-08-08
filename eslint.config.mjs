import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".vercel/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    files: ["packages/domain/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[object.name='process'][property.name='env']",
          message: "Domain code must not read process.env; inject configuration from infrastructure.",
        },
      ],
    },
  },
  {
    // Prefer the structured logger over raw console.* in app/lib code.
    // Console is legitimate only in the logger module, the CLI, and scripts.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/lib/logger.ts", "src/components/react-bits/**"],
    rules: {
      "no-console": "error",
    },
  },
]);

export default eslintConfig;
